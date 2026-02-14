"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enqueueCall = exports.enqueueEmail = exports.enqueueDeploy = exports.enqueueImage = exports.enqueueSite = exports.enqueueEnrich = exports.enqueueScrape = exports.callQueue = exports.emailQueue = exports.deployQueue = exports.imageQueue = exports.siteQueue = exports.enrichQueue = exports.scrapeQueue = exports.connection = void 0;
const bullmq_1 = require("bullmq");
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const buildConnectionOptions = (url) => {
    const parsed = new URL(url);
    const dbPath = parsed.pathname.replace("/", "");
    const db = dbPath ? Number(dbPath) : 0;
    const options = {
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
exports.connection = buildConnectionOptions(redisUrl);
const defaultJobOptions = {
    attempts: 3,
    backoff: {
        type: "exponential",
        delay: 3000
    },
    removeOnComplete: true,
    removeOnFail: false
};
exports.scrapeQueue = new bullmq_1.Queue("scrape", {
    connection: exports.connection,
    defaultJobOptions
});
exports.enrichQueue = new bullmq_1.Queue("enrich", {
    connection: exports.connection,
    defaultJobOptions
});
exports.siteQueue = new bullmq_1.Queue("site", {
    connection: exports.connection,
    defaultJobOptions
});
exports.imageQueue = new bullmq_1.Queue("image", {
    connection: exports.connection,
    defaultJobOptions
});
exports.deployQueue = new bullmq_1.Queue("deploy", {
    connection: exports.connection,
    defaultJobOptions
});
exports.emailQueue = new bullmq_1.Queue("email", {
    connection: exports.connection,
    defaultJobOptions
});
exports.callQueue = new bullmq_1.Queue("call", {
    connection: exports.connection,
    defaultJobOptions
});
const enqueueScrape = async (job) => exports.scrapeQueue.add("scrape-leads", job);
exports.enqueueScrape = enqueueScrape;
const enqueueEnrich = async (job) => exports.enrichQueue.add("enrich-lead", job);
exports.enqueueEnrich = enqueueEnrich;
const enqueueSite = async (job) => exports.siteQueue.add("generate-site", job);
exports.enqueueSite = enqueueSite;
const enqueueImage = async (job) => exports.imageQueue.add("prepare-images", job);
exports.enqueueImage = enqueueImage;
const enqueueDeploy = async (job) => exports.deployQueue.add("deploy-site", job);
exports.enqueueDeploy = enqueueDeploy;
const enqueueEmail = async (job) => exports.emailQueue.add("send-email", job);
exports.enqueueEmail = enqueueEmail;
const enqueueCall = async (job) => exports.callQueue.add("place-call", job);
exports.enqueueCall = enqueueCall;
