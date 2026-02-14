import { EventType, LeadStatus } from "@prisma/client";
import { Job, Worker } from "bullmq";
import { prisma } from "../db/client";
import { CallJob, connection } from "../queue";

const workerName = "caller";
const defaultConcurrency = 5;
const workerConcurrency = Number(process.env.CALLER_CONCURRENCY ?? defaultConcurrency);

type PlaceCallInput = {
  to: string;
  script: string;
  callbackUrl: string;
};

type PlaceCallOutput = {
  callId: string;
};

export interface CallProvider {
  placeCall(input: PlaceCallInput): Promise<PlaceCallOutput>;
}

class FakeCallProvider implements CallProvider {
  async placeCall(input: PlaceCallInput): Promise<PlaceCallOutput> {
    const callId = `fake-call-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    console.log(
      "[fake-call-provider] to=%s callback=%s callId=%s script=%s",
      input.to,
      input.callbackUrl,
      callId,
      input.script
    );
    return { callId };
  }
}

class RealCallProvider implements CallProvider {
  async placeCall(_input: PlaceCallInput): Promise<PlaceCallOutput> {
    // TODO: add Twilio/VAPI adapter with production env vars.
    throw new Error("Real call provider not implemented yet");
  }
}

const resolveCallProvider = (): CallProvider => {
  const env = (process.env.ENV ?? "development").toLowerCase();
  if (env === "production") {
    return new RealCallProvider();
  }
  return new FakeCallProvider();
};

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
  const providerResult = await callProvider.placeCall({
    to: lead.phone,
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

  logMessage(campaignId, lead.id, `call attempt ${attempt} placed (callId=${providerResult.callId})`);
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
