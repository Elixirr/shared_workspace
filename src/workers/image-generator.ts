import { EventType, LeadStatus } from "@prisma/client";
import { Job, Worker } from "bullmq";
import { prisma } from "../db/client";
import { connection, enqueueDeploy, ImageJob } from "../queue";

const workerName = "image-generator";
const defaultConcurrency = 5;
const workerConcurrency = Number(process.env.IMAGE_GENERATOR_CONCURRENCY ?? defaultConcurrency);

const heroPoolSize = 50;
const servicePoolSize = 100;
const serviceImagesPerLead = 3;
const defaultStyle = "clean-local";

type AspectRatio = "16:9" | "4:3" | "1:1";

type ImagePool = {
  heroImages: string[];
  serviceImages: string[];
};

export interface ImageProvider {
  generate(prompt: string, aspectRatio: AspectRatio): Promise<string>;
}

class FakeImageProvider implements ImageProvider {
  async generate(prompt: string, aspectRatio: AspectRatio): Promise<string> {
    const [width, height] = aspectRatio.split(":").map((n) => Number(n));
    const normalizedPrompt = encodeURIComponent(prompt.toLowerCase().replace(/\s+/g, "-"));
    const pixelWidth = width * 160;
    const pixelHeight = height * 160;
    return `https://picsum.photos/seed/${normalizedPrompt}/${pixelWidth}/${pixelHeight}`;
  }
}

const imagePoolCache = new Map<string, ImagePool>();

const logMessage = (campaignId: string, leadId: string, message: string): void => {
  console.log(`[${campaignId}][${leadId}][${workerName}] ${message}`);
};

const poolKey = (niche: string, style: string): string =>
  `${niche.toLowerCase().trim()}::${style.toLowerCase().trim()}`;

const hashString = (value: string): number => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
};

export const getOrCreateImagePool = async (
  niche: string,
  style: string,
  provider: ImageProvider
): Promise<ImagePool> => {
  const key = poolKey(niche, style);
  const existing = imagePoolCache.get(key);
  if (existing) {
    return existing;
  }

  const heroImages = await Promise.all(
    Array.from({ length: heroPoolSize }, (_unused, idx) =>
      provider.generate(`${style} ${niche} hero ${idx + 1}`, "16:9")
    )
  );

  const serviceImages = await Promise.all(
    Array.from({ length: servicePoolSize }, (_unused, idx) =>
      provider.generate(`${style} ${niche} service ${idx + 1}`, "4:3")
    )
  );

  const pool = { heroImages, serviceImages };
  imagePoolCache.set(key, pool);
  return pool;
};

const pickLeadImages = (
  leadId: string,
  pool: ImagePool
): { heroImageUrl: string; serviceImageUrls: string[] } => {
  const seed = hashString(leadId);
  const heroImageUrl = pool.heroImages[seed % pool.heroImages.length];

  const serviceImageUrls: string[] = [];
  for (let idx = 0; idx < serviceImagesPerLead; idx += 1) {
    const offset = (seed + idx * 13) % pool.serviceImages.length;
    serviceImageUrls.push(pool.serviceImages[offset]);
  }

  return { heroImageUrl, serviceImageUrls };
};

const imageProvider: ImageProvider = new FakeImageProvider();

const processImageJob = async (job: Job<ImageJob>): Promise<void> => {
  const { leadId } = job.data;
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { campaign: true }
  });

  if (!lead) {
    throw new Error(`Lead not found: ${leadId}`);
  }

  const campaignId = lead.campaignId;
  const style = defaultStyle;
  const pool = await getOrCreateImagePool(lead.campaign.niche, style, imageProvider);
  const { heroImageUrl, serviceImageUrls } = pickLeadImages(lead.id, pool);

  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      heroImageUrl,
      serviceImageUrls,
      status: LeadStatus.IMAGES_READY,
      lastError: null
    }
  });

  await prisma.event.create({
    data: {
      campaignId,
      leadId: lead.id,
      type: EventType.IMAGES_READY,
      metadata: {
        style,
        heroImageUrl,
        serviceImageUrlsCount: serviceImageUrls.length
      }
    }
  });

  await enqueueDeploy({ leadId: lead.id });
  logMessage(campaignId, lead.id, "images assigned and deploy queued");
};

export const imageGeneratorWorker = new Worker<ImageJob>("image", processImageJob, {
  connection,
  concurrency: workerConcurrency
});

imageGeneratorWorker.on("completed", (job) => {
  logMessage("unknown-campaign", job.data.leadId, `job ${job.id ?? "unknown"} completed`);
});

imageGeneratorWorker.on("failed", (job, err) => {
  const leadId = job?.data.leadId ?? "unknown-lead";
  logMessage("unknown-campaign", leadId, `job ${job?.id ?? "unknown"} failed: ${err.message}`);
});
