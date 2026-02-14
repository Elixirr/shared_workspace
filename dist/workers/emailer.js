"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.emailerWorker = void 0;
const client_1 = require("@prisma/client");
const bullmq_1 = require("bullmq");
const client_2 = require("../db/client");
const queue_1 = require("../queue");
const workerName = "emailer";
const defaultConcurrency = 5;
const workerConcurrency = Number(process.env.EMAILER_CONCURRENCY ?? defaultConcurrency);
const followUpCallDelayMs = 30 * 60 * 1000;
class FakeEmailProvider {
    async sendEmail(input) {
        const fakeMessageId = `fake-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        console.log("[fake-email-provider] to=%s subject=%s messageId=%s", input.to, input.subject, fakeMessageId);
        return { messageId: fakeMessageId };
    }
}
class RealEmailProvider {
    async sendEmail(_input) {
        // TODO: Add SendGrid/Mailgun adapter and env vars.
        throw new Error("Real email provider not implemented yet");
    }
}
const resolveEmailProvider = () => {
    const env = (process.env.ENV ?? "development").toLowerCase();
    if (env === "production") {
        return new RealEmailProvider();
    }
    return new FakeEmailProvider();
};
const logMessage = (campaignId, leadId, message) => {
    console.log(`[${campaignId}][${leadId}][${workerName}] ${message}`);
};
const buildSubject = (businessName, step) => {
    if (step === 1) {
        return `Built this for ${businessName}`;
    }
    return "Quick follow-up: website preview";
};
const buildBody = (businessName, demoUrl, step) => {
    if (step === 1) {
        return {
            html: `<p>Hi ${businessName},</p><p>I built a quick website preview for your business:</p><p><a href="${demoUrl}">${demoUrl}</a></p><p>If useful, I can customize it further.</p>`,
            text: `Hi ${businessName},\n\nI built a quick website preview for your business:\n${demoUrl}\n\nIf useful, I can customize it further.`
        };
    }
    return {
        html: `<p>Quick follow-up for ${businessName}.</p><p>Your website preview is still live here:</p><p><a href="${demoUrl}">${demoUrl}</a></p>`,
        text: `Quick follow-up for ${businessName}.\n\nYour website preview is still live here:\n${demoUrl}`
    };
};
const emailProvider = resolveEmailProvider();
const processEmailJob = async (job) => {
    const { leadId, step } = job.data;
    const lead = await client_2.prisma.lead.findUnique({
        where: { id: leadId }
    });
    if (!lead) {
        throw new Error(`Lead not found: ${leadId}`);
    }
    const campaignId = lead.campaignId;
    if (lead.doNotContact) {
        logMessage(campaignId, lead.id, "skipped email (doNotContact=true)");
        return;
    }
    if (!lead.email) {
        logMessage(campaignId, lead.id, "skipped email (missing email)");
        return;
    }
    if (!lead.demoUrl) {
        throw new Error(`Lead ${lead.id} missing demoUrl; cannot email`);
    }
    if (lead.emailSentCount >= step) {
        logMessage(campaignId, lead.id, `step ${step} already sent; skipping duplicate`);
        return;
    }
    const businessName = lead.businessName ?? "there";
    const subject = buildSubject(businessName, step);
    const body = buildBody(businessName, lead.demoUrl, step);
    const providerResult = await emailProvider.sendEmail({
        to: lead.email,
        subject,
        html: body.html,
        text: body.text,
        headers: {
            "x-campaign-id": campaignId,
            "x-lead-id": lead.id,
            "x-email-step": String(step)
        }
    });
    await client_2.prisma.lead.update({
        where: { id: lead.id },
        data: {
            emailSentCount: { increment: 1 },
            status: client_1.LeadStatus.EMAILED_1,
            lastError: null
        }
    });
    await client_2.prisma.event.create({
        data: {
            campaignId,
            leadId: lead.id,
            type: client_1.EventType.EMAIL_SENT,
            metadata: {
                step,
                providerMessageId: providerResult.messageId,
                subject
            }
        }
    });
    await queue_1.callQueue.add("place-call", { leadId: lead.id, attempt: 1 }, { delay: followUpCallDelayMs });
    logMessage(campaignId, lead.id, `email step ${step} sent; follow-up call queued (+30m)`);
};
exports.emailerWorker = new bullmq_1.Worker("email", processEmailJob, {
    connection: queue_1.connection,
    concurrency: workerConcurrency
});
exports.emailerWorker.on("completed", (job) => {
    logMessage("unknown-campaign", job.data.leadId, `job ${job.id ?? "unknown"} completed`);
});
exports.emailerWorker.on("failed", (job, err) => {
    const leadId = job?.data.leadId ?? "unknown-lead";
    logMessage("unknown-campaign", leadId, `job ${job?.id ?? "unknown"} failed: ${err.message}`);
});
