import { EventType, LeadStatus } from "@prisma/client";
import { Job, Worker } from "bullmq";
import { promises as fs } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { prisma } from "../db/client";
import { connection, DeployJob, enqueueEmail } from "../queue";

const workerName = "deployer";
const defaultConcurrency = 5;
const workerConcurrency = Number(process.env.DEPLOYER_CONCURRENCY ?? defaultConcurrency);
const workspaceRoot = process.cwd();

export interface DeployProvider {
  deploy(zipPath: string, projectName: string): Promise<{ url: string }>;
}

type CloudflareConfig = {
  apiToken: string;
  accountId: string;
  projectName: string;
};

const logMessage = (campaignId: string, leadId: string, message: string): void => {
  console.log(`[${campaignId}][${leadId}][${workerName}] ${message}`);
};

const sanitizeSlug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

const replaceAll = (content: string, target: string, replacement: string): string =>
  content.split(target).join(replacement);

const injectImageUrls = async (
  zipPath: string,
  heroImageUrl: string | null,
  serviceImageUrls: string[]
): Promise<string> => {
  const zipBuffer = await fs.readFile(zipPath);
  const zip = await JSZip.loadAsync(zipBuffer);
  const indexFile = zip.file("index.html");

  if (!indexFile) {
    throw new Error(`index.html not found in bundle: ${zipPath}`);
  }

  let indexHtml = await indexFile.async("string");
  indexHtml = replaceAll(indexHtml, "{{HERO_IMAGE_URL}}", heroImageUrl ?? "https://picsum.photos/seed/fallback-hero/1600/900");
  indexHtml = replaceAll(
    indexHtml,
    "{{SERVICE_IMAGE_URL_1}}",
    serviceImageUrls[0] ?? "https://picsum.photos/seed/fallback-service-1/800/600"
  );
  indexHtml = replaceAll(
    indexHtml,
    "{{SERVICE_IMAGE_URL_2}}",
    serviceImageUrls[1] ?? "https://picsum.photos/seed/fallback-service-2/800/600"
  );
  indexHtml = replaceAll(
    indexHtml,
    "{{SERVICE_IMAGE_URL_3}}",
    serviceImageUrls[2] ?? "https://picsum.photos/seed/fallback-service-3/800/600"
  );

  zip.file("index.html", indexHtml);
  const nextBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const nextZipPath = path.join("/tmp", `${path.basename(zipPath, ".zip")}-ready.zip`);
  await fs.writeFile(nextZipPath, nextBuffer);
  return nextZipPath;
};

class FakeLocalDeployProvider implements DeployProvider {
  async deploy(zipPath: string, projectName: string): Promise<{ url: string }> {
    const demoRoot = path.join(workspaceRoot, "public", "demo");
    const projectDir = path.join(demoRoot, sanitizeSlug(projectName));
    await fs.mkdir(projectDir, { recursive: true });

    const zipBuffer = await fs.readFile(zipPath);
    const zip = await JSZip.loadAsync(zipBuffer);
    const writeOperations: Promise<void>[] = [];

    zip.forEach((relativePath, file) => {
      if (file.dir) {
        return;
      }

      writeOperations.push(
        (async () => {
          const destination = path.join(projectDir, relativePath);
          await fs.mkdir(path.dirname(destination), { recursive: true });
          const content = await file.async("nodebuffer");
          await fs.writeFile(destination, content);
        })()
      );
    });

    await Promise.all(writeOperations);
    return { url: `http://localhost:3000/demo/${sanitizeSlug(projectName)}` };
  }
}

class CloudflarePagesDeployProvider implements DeployProvider {
  private readonly config: CloudflareConfig;

  constructor(config: CloudflareConfig) {
    this.config = config;
  }

  async deploy(_zipPath: string, _projectName: string): Promise<{ url: string }> {
    // TODO: implement Cloudflare Pages deployment flow with API.
    // Required env vars: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_PROJECT_NAME.
    throw new Error(
      `Cloudflare deploy adapter is not implemented yet for project ${this.config.projectName}`
    );
  }
}

const resolveDeployProvider = (): DeployProvider => {
  const provider = (process.env.DEPLOY_PROVIDER ?? "local").toLowerCase();
  if (provider === "cloudflare") {
    const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
    const projectName = process.env.CLOUDFLARE_PROJECT_NAME ?? "";
    return new CloudflarePagesDeployProvider({ apiToken, accountId, projectName });
  }

  return new FakeLocalDeployProvider();
};

const processDeployJob = async (job: Job<DeployJob>): Promise<void> => {
  const { leadId } = job.data;
  const lead = await prisma.lead.findUnique({
    where: { id: leadId }
  });

  if (!lead) {
    throw new Error(`Lead not found: ${leadId}`);
  }

  const campaignId = lead.campaignId;
  if (lead.status !== LeadStatus.IMAGES_READY) {
    throw new Error(`Lead ${leadId} must be IMAGES_READY before deploy (current=${lead.status})`);
  }

  const siteGeneratedEvent = await prisma.event.findFirst({
    where: {
      campaignId,
      leadId,
      type: EventType.SITE_GENERATED
    },
    orderBy: { createdAt: "desc" },
    select: { metadata: true }
  });

  const zipPath = (siteGeneratedEvent?.metadata as { zipPath?: string } | undefined)?.zipPath;
  if (!zipPath) {
    throw new Error(`No generated site bundle found for lead ${leadId}`);
  }

  const injectedZipPath = await injectImageUrls(zipPath, lead.heroImageUrl, lead.serviceImageUrls);
  const deployProvider = resolveDeployProvider();
  const deployResult = await deployProvider.deploy(injectedZipPath, lead.id);

  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      demoUrl: deployResult.url,
      status: LeadStatus.DEPLOYED,
      lastError: null
    }
  });

  await prisma.event.create({
    data: {
      campaignId,
      leadId: lead.id,
      type: EventType.DEPLOYED,
      metadata: {
        url: deployResult.url
      }
    }
  });

  await enqueueEmail({ leadId: lead.id, step: 1 });
  logMessage(campaignId, lead.id, `deployed to ${deployResult.url} and queued email step 1`);
};

export const deployerWorker = new Worker<DeployJob>("deploy", processDeployJob, {
  connection,
  concurrency: workerConcurrency
});

deployerWorker.on("completed", (job) => {
  logMessage("unknown-campaign", job.data.leadId, `job ${job.id ?? "unknown"} completed`);
});

deployerWorker.on("failed", (job, err) => {
  const leadId = job?.data.leadId ?? "unknown-lead";
  logMessage("unknown-campaign", leadId, `job ${job?.id ?? "unknown"} failed: ${err.message}`);
});
