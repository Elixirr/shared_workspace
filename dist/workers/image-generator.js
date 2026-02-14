"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.imageGeneratorWorker = exports.getOrCreateImagePool = void 0;
const client_1 = require("@prisma/client");
const bullmq_1 = require("bullmq");
const client_2 = require("../db/client");
const queue_1 = require("../queue");
const workerName = "image-generator";
const defaultConcurrency = 5;
const workerConcurrency = Number(process.env.IMAGE_GENERATOR_CONCURRENCY ?? defaultConcurrency);
const heroPoolSize = 50;
const servicePoolSize = 100;
const serviceImagesPerLead = 3;
const defaultStyle = "clean-local";
class FakeImageProvider {
    async generate(prompt, aspectRatio) {
        const [width, height] = aspectRatio.split(":").map((n) => Number(n));
        const normalizedPrompt = encodeURIComponent(prompt.toLowerCase().replace(/\s+/g, "-"));
        const pixelWidth = width * 160;
        const pixelHeight = height * 160;
        return `https://picsum.photos/seed/${normalizedPrompt}/${pixelWidth}/${pixelHeight}`;
    }
}
const imagePoolCache = new Map();
const logMessage = (campaignId, leadId, message) => {
    console.log(`[${campaignId}][${leadId}][${workerName}] ${message}`);
};
const poolKey = (niche, style) => `${niche.toLowerCase().trim()}::${style.toLowerCase().trim()}`;
const hashString = (value) => {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
        hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
    }
    return hash;
};
const getOrCreateImagePool = async (niche, style, provider) => {
    const key = poolKey(niche, style);
    const existing = imagePoolCache.get(key);
    if (existing) {
        return existing;
    }
    const heroImages = await Promise.all(Array.from({ length: heroPoolSize }, (_unused, idx) => provider.generate(`${style} ${niche} hero ${idx + 1}`, "16:9")));
    const serviceImages = await Promise.all(Array.from({ length: servicePoolSize }, (_unused, idx) => provider.generate(`${style} ${niche} service ${idx + 1}`, "4:3")));
    const pool = { heroImages, serviceImages };
    imagePoolCache.set(key, pool);
    return pool;
};
exports.getOrCreateImagePool = getOrCreateImagePool;
const pickLeadImages = (leadId, pool) => {
    const seed = hashString(leadId);
    const heroImageUrl = pool.heroImages[seed % pool.heroImages.length];
    const serviceImageUrls = [];
    for (let idx = 0; idx < serviceImagesPerLead; idx += 1) {
        const offset = (seed + idx * 13) % pool.serviceImages.length;
        serviceImageUrls.push(pool.serviceImages[offset]);
    }
    return { heroImageUrl, serviceImageUrls };
};
const imageProvider = new FakeImageProvider();
const processImageJob = async (job) => {
    const { leadId } = job.data;
    const lead = await client_2.prisma.lead.findUnique({
        where: { id: leadId },
        include: { campaign: true }
    });
    if (!lead) {
        throw new Error(`Lead not found: ${leadId}`);
    }
    const campaignId = lead.campaignId;
    const style = defaultStyle;
    const pool = await (0, exports.getOrCreateImagePool)(lead.campaign.niche, style, imageProvider);
    const { heroImageUrl, serviceImageUrls } = pickLeadImages(lead.id, pool);
    await client_2.prisma.lead.update({
        where: { id: lead.id },
        data: {
            heroImageUrl,
            serviceImageUrls,
            status: client_1.LeadStatus.IMAGES_READY,
            lastError: null
        }
    });
    await client_2.prisma.event.create({
        data: {
            campaignId,
            leadId: lead.id,
            type: client_1.EventType.IMAGES_READY,
            metadata: {
                style,
                heroImageUrl,
                serviceImageUrlsCount: serviceImageUrls.length
            }
        }
    });
    await (0, queue_1.enqueueDeploy)({ leadId: lead.id });
    logMessage(campaignId, lead.id, "images assigned and deploy queued");
};
exports.imageGeneratorWorker = new bullmq_1.Worker("image", processImageJob, {
    connection: queue_1.connection,
    concurrency: workerConcurrency
});
exports.imageGeneratorWorker.on("completed", (job) => {
    logMessage("unknown-campaign", job.data.leadId, `job ${job.id ?? "unknown"} completed`);
});
exports.imageGeneratorWorker.on("failed", (job, err) => {
    const leadId = job?.data.leadId ?? "unknown-lead";
    logMessage("unknown-campaign", leadId, `job ${job?.id ?? "unknown"} failed: ${err.message}`);
});
