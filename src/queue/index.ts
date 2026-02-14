import { ConnectionOptions, DefaultJobOptions, Queue } from "bullmq";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

const buildConnectionOptions = (url: string): ConnectionOptions => {
  const parsed = new URL(url);
  const dbPath = parsed.pathname.replace("/", "");
  const db = dbPath ? Number(dbPath) : 0;

  const options: ConnectionOptions = {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: Number.isFinite(db) ? db : 0,
    maxRetriesPerRequest: null
  };

  if (parsed.protocol === "rediss:") {
    return {
      ...options,
      tls: {}
    };
  }

  return options;
};

// Shared Redis connection options for all queues/workers.
export const connection = buildConnectionOptions(redisUrl);

const defaultJobOptions: DefaultJobOptions = {
  attempts: 3,
  backoff: {
    type: "exponential",
    delay: 3000
  },
  removeOnComplete: true,
  removeOnFail: false
};

export type ScrapeJob = {
  campaignId: string;
};

export type EnrichJob = {
  leadId: string;
};

export type SiteJob = {
  leadId: string;
};

export type ImageJob = {
  leadId: string;
};

export type DeployJob = {
  leadId: string;
};

export type EmailJob = {
  leadId: string;
  step: 1 | 2;
};

export type CallJob = {
  leadId: string;
  attempt: 1 | 2;
};

export const scrapeQueue = new Queue<ScrapeJob, void, "scrape-leads">("scrape", {
  connection,
  defaultJobOptions
});

export const enrichQueue = new Queue<EnrichJob, void, "enrich-lead">("enrich", {
  connection,
  defaultJobOptions
});

export const siteQueue = new Queue<SiteJob, void, "generate-site">("site", {
  connection,
  defaultJobOptions
});

export const imageQueue = new Queue<ImageJob, void, "prepare-images">("image", {
  connection,
  defaultJobOptions
});

export const deployQueue = new Queue<DeployJob, void, "deploy-site">("deploy", {
  connection,
  defaultJobOptions
});

export const emailQueue = new Queue<EmailJob, void, "send-email">("email", {
  connection,
  defaultJobOptions
});

export const callQueue = new Queue<CallJob, void, "place-call">("call", {
  connection,
  defaultJobOptions
});

export const enqueueScrape = async (job: ScrapeJob) =>
  scrapeQueue.add("scrape-leads", job);

export const enqueueEnrich = async (job: EnrichJob) =>
  enrichQueue.add("enrich-lead", job);

export const enqueueSite = async (job: SiteJob) =>
  siteQueue.add("generate-site", job);

export const enqueueImage = async (job: ImageJob) =>
  imageQueue.add("prepare-images", job);

export const enqueueDeploy = async (job: DeployJob) =>
  deployQueue.add("deploy-site", job);

export const enqueueEmail = async (job: EmailJob) =>
  emailQueue.add("send-email", job);

export const enqueueCall = async (job: CallJob) =>
  callQueue.add("place-call", job);
