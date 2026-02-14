import { EventType, LeadStatus } from "@prisma/client";
import { Job, Worker } from "bullmq";
import { prisma } from "../db/client";
import { resolveEmailProvider } from "../providers/email";
import { EmailProvider } from "../providers/interfaces/email";
import { callQueue, connection, EmailJob } from "../queue";
import { runIdempotentStage } from "./base-worker";

const workerName = "emailer";
const defaultConcurrency = 5;
const workerConcurrency = Number(process.env.EMAILER_CONCURRENCY ?? defaultConcurrency);
const followUpCallDelayMs = 30 * 60 * 1000;

const logMessage = (campaignId: string, leadId: string, message: string): void => {
  console.log(`[${campaignId}][${leadId}][${workerName}] ${message}`);
};

const buildSubject = (businessName: string, step: 1 | 2): string => {
  if (step === 1) {
    return `Built this for ${businessName}`;
  }
  return "Quick follow-up: website preview";
};

const buildBody = (businessName: string, demoUrl: string, step: 1 | 2): { html: string; text: string } => {
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

const emailProvider: EmailProvider = resolveEmailProvider();

const processEmailJob = async (job: Job<EmailJob>): Promise<void> => {
  const { leadId, step } = job.data;
  const lead = await prisma.lead.findUnique({
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

  const idemKey = `email:${lead.id}:step:${step}`;
  const stageResult = await runIdempotentStage({
    key: idemKey,
    stage: "email",
    campaignId,
    leadId: lead.id,
    workerName,
    run: async () => {
      const providerResult = await emailProvider.sendEmail({
        to: lead.email!,
        subject,
        html: body.html,
        text: body.text,
        headers: {
          "x-campaign-id": campaignId,
          "x-lead-id": lead.id,
          "x-email-step": String(step)
        }
      });

      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          emailSentCount: { increment: 1 },
          status: LeadStatus.EMAILED_1,
          lastError: null
        }
      });

      await prisma.event.create({
        data: {
          campaignId,
          leadId: lead.id,
          type: EventType.EMAIL_SENT,
          metadata: {
            step,
            providerMessageId: providerResult.messageId,
            subject
          }
        }
      });

      await callQueue.add(
        "place-call",
        { leadId: lead.id, attempt: 1 },
        { delay: followUpCallDelayMs }
      );

      return { providerMessageId: providerResult.messageId };
    }
  });

  if (!stageResult.executed) {
    logMessage(campaignId, lead.id, `idempotency skip for step ${step}`);
    return;
  }

  logMessage(campaignId, lead.id, `email step ${step} sent; follow-up call queued (+30m)`);
};

export const emailerWorker = new Worker<EmailJob>("email", processEmailJob, {
  connection,
  concurrency: workerConcurrency
});

emailerWorker.on("completed", (job) => {
  logMessage("unknown-campaign", job.data.leadId, `job ${job.id ?? "unknown"} completed`);
});

emailerWorker.on("failed", (job, err) => {
  const leadId = job?.data.leadId ?? "unknown-lead";
  logMessage("unknown-campaign", leadId, `job ${job?.id ?? "unknown"} failed: ${err.message}`);
});
