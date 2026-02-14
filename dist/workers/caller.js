"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.callerWorker = void 0;
const client_1 = require("@prisma/client");
const bullmq_1 = require("bullmq");
const client_2 = require("../db/client");
const queue_1 = require("../queue");
const workerName = "caller";
const defaultConcurrency = 5;
const workerConcurrency = Number(process.env.CALLER_CONCURRENCY ?? defaultConcurrency);
class FakeCallProvider {
    async placeCall(input) {
        const callId = `fake-call-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        console.log("[fake-call-provider] to=%s callback=%s callId=%s script=%s", input.to, input.callbackUrl, callId, input.script);
        return { callId };
    }
}
class RealCallProvider {
    async placeCall(_input) {
        // TODO: add Twilio/VAPI adapter with production env vars.
        throw new Error("Real call provider not implemented yet");
    }
}
const resolveCallProvider = () => {
    const env = (process.env.ENV ?? "development").toLowerCase();
    if (env === "production") {
        return new RealCallProvider();
    }
    return new FakeCallProvider();
};
const logMessage = (campaignId, leadId, message) => {
    console.log(`[${campaignId}][${leadId}][${workerName}] ${message}`);
};
const buildCallScript = (businessName, demoUrl) => `Hi, is this the owner of ${businessName}? I sent a quick website preview earlier. Can I resend the link? ${demoUrl}`;
const callProvider = resolveCallProvider();
const processCallJob = async (job) => {
    const { leadId, attempt } = job.data;
    const lead = await client_2.prisma.lead.findUnique({
        where: { id: leadId }
    });
    if (!lead) {
        throw new Error(`Lead not found: ${leadId}`);
    }
    const campaignId = lead.campaignId;
    if (lead.doNotContact) {
        logMessage(campaignId, lead.id, "skipped call (doNotContact=true)");
        return;
    }
    if (!lead.phone) {
        logMessage(campaignId, lead.id, "skipped call (missing phone)");
        return;
    }
    if (lead.callAttempts >= 2) {
        logMessage(campaignId, lead.id, "skipped call (callAttempts >= 2)");
        return;
    }
    const businessName = lead.businessName ?? "your business";
    const demoUrl = lead.demoUrl ?? "the preview link";
    const callbackBase = process.env.CALL_WEBHOOK_BASE_URL ?? "http://localhost:3000";
    const callbackUrl = `${callbackBase}/webhooks/calls/fake`;
    const script = buildCallScript(businessName, demoUrl);
    const providerResult = await callProvider.placeCall({
        to: lead.phone,
        script,
        callbackUrl
    });
    await client_2.prisma.lead.update({
        where: { id: lead.id },
        data: {
            callAttempts: { increment: 1 },
            status: client_1.LeadStatus.CALLED_1,
            lastError: null
        }
    });
    await client_2.prisma.event.create({
        data: {
            campaignId,
            leadId: lead.id,
            type: client_1.EventType.CALL_PLACED,
            metadata: {
                attempt,
                callId: providerResult.callId,
                callbackUrl
            }
        }
    });
    logMessage(campaignId, lead.id, `call attempt ${attempt} placed (callId=${providerResult.callId})`);
};
exports.callerWorker = new bullmq_1.Worker("call", processCallJob, {
    connection: queue_1.connection,
    concurrency: workerConcurrency
});
exports.callerWorker.on("completed", (job) => {
    logMessage("unknown-campaign", job.data.leadId, `job ${job.id ?? "unknown"} completed`);
});
exports.callerWorker.on("failed", (job, err) => {
    const leadId = job?.data.leadId ?? "unknown-lead";
    logMessage("unknown-campaign", leadId, `job ${job?.id ?? "unknown"} failed: ${err.message}`);
});
