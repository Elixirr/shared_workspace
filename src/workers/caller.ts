import { EventType, LeadStatus } from "@prisma/client";
import { Job, Worker } from "bullmq";
import { prisma } from "../db/client";
import { resolveCallProvider } from "../providers/voice";
import { CallProvider } from "../providers/interfaces/voice";
import { CallJob, connection } from "../queue";
import { runIdempotentStage } from "./base-worker";

const workerName = "caller";
const defaultConcurrency = 5;
const workerConcurrency = Number(process.env.CALLER_CONCURRENCY ?? defaultConcurrency);

const logMessage = (campaignId: string, leadId: string, message: string): void => {
  console.log(`[${campaignId}][${leadId}][${workerName}] ${message}`);
};

const buildCallScript = (businessName: string, demoUrl: string): string =>
  `Hi, is this the owner of ${businessName}? I sent a quick website preview earlier. Can I resend the link? ${demoUrl}`;

const callProvider: CallProvider = resolveCallProvider();

const processCallJob = async (job: Job<CallJob>): Promise<void> => {
  const { leadId, attempt } = job.data;
  const lead = await prisma.lead.findUnique({
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
  const idemKey = `call:${lead.id}:attempt:${attempt}`;
  const stageResult = await runIdempotentStage({
    key: idemKey,
    stage: "call",
    campaignId,
    leadId: lead.id,
    workerName,
    run: async () => {
      const providerResult = await callProvider.placeCall({
        to: lead.phone!,
        script,
        callbackUrl
      });

      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          callAttempts: { increment: 1 },
          status: LeadStatus.CALLED_1,
          lastError: null
        }
      });

      await prisma.event.create({
        data: {
          campaignId,
          leadId: lead.id,
          type: EventType.CALL_PLACED,
          metadata: {
            attempt,
            callId: providerResult.callId,
            callbackUrl
          }
        }
      });

      return { callId: providerResult.callId };
    }
  });

  if (!stageResult.executed) {
    logMessage(campaignId, lead.id, `idempotency skip for attempt ${attempt}`);
    return;
  }

  logMessage(campaignId, lead.id, `call attempt ${attempt} placed`);
};

export const callerWorker = new Worker<CallJob>("call", processCallJob, {
  connection,
  concurrency: workerConcurrency
});

callerWorker.on("completed", (job) => {
  logMessage("unknown-campaign", job.data.leadId, `job ${job.id ?? "unknown"} completed`);
});

callerWorker.on("failed", (job, err) => {
  const leadId = job?.data.leadId ?? "unknown-lead";
  logMessage("unknown-campaign", leadId, `job ${job?.id ?? "unknown"} failed: ${err.message}`);
});
