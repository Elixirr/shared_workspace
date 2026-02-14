"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deployerWorker = void 0;
const client_1 = require("@prisma/client");
const bullmq_1 = require("bullmq");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const jszip_1 = __importDefault(require("jszip"));
const client_2 = require("../db/client");
const queue_1 = require("../queue");
const workerName = "deployer";
const defaultConcurrency = 5;
const workerConcurrency = Number(process.env.DEPLOYER_CONCURRENCY ?? defaultConcurrency);
const workspaceRoot = process.cwd();
const logMessage = (campaignId, leadId, message) => {
    console.log(`[${campaignId}][${leadId}][${workerName}] ${message}`);
};
const sanitizeSlug = (value) => value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
const replaceAll = (content, target, replacement) => content.split(target).join(replacement);
const injectImageUrls = async (zipPath, heroImageUrl, serviceImageUrls) => {
    const zipBuffer = await node_fs_1.promises.readFile(zipPath);
    const zip = await jszip_1.default.loadAsync(zipBuffer);
    const indexFile = zip.file("index.html");
    if (!indexFile) {
        throw new Error(`index.html not found in bundle: ${zipPath}`);
    }
    let indexHtml = await indexFile.async("string");
    indexHtml = replaceAll(indexHtml, "{{HERO_IMAGE_URL}}", heroImageUrl ?? "https://picsum.photos/seed/fallback-hero/1600/900");
    indexHtml = replaceAll(indexHtml, "{{SERVICE_IMAGE_URL_1}}", serviceImageUrls[0] ?? "https://picsum.photos/seed/fallback-service-1/800/600");
    indexHtml = replaceAll(indexHtml, "{{SERVICE_IMAGE_URL_2}}", serviceImageUrls[1] ?? "https://picsum.photos/seed/fallback-service-2/800/600");
    indexHtml = replaceAll(indexHtml, "{{SERVICE_IMAGE_URL_3}}", serviceImageUrls[2] ?? "https://picsum.photos/seed/fallback-service-3/800/600");
    zip.file("index.html", indexHtml);
    const nextBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const nextZipPath = node_path_1.default.join("/tmp", `${node_path_1.default.basename(zipPath, ".zip")}-ready.zip`);
    await node_fs_1.promises.writeFile(nextZipPath, nextBuffer);
    return nextZipPath;
};
class FakeLocalDeployProvider {
    async deploy(zipPath, projectName) {
        const demoRoot = node_path_1.default.join(workspaceRoot, "public", "demo");
        const projectDir = node_path_1.default.join(demoRoot, sanitizeSlug(projectName));
        await node_fs_1.promises.mkdir(projectDir, { recursive: true });
        const zipBuffer = await node_fs_1.promises.readFile(zipPath);
        const zip = await jszip_1.default.loadAsync(zipBuffer);
        const writeOperations = [];
        zip.forEach((relativePath, file) => {
            if (file.dir) {
                return;
            }
            writeOperations.push((async () => {
                const destination = node_path_1.default.join(projectDir, relativePath);
                await node_fs_1.promises.mkdir(node_path_1.default.dirname(destination), { recursive: true });
                const content = await file.async("nodebuffer");
                await node_fs_1.promises.writeFile(destination, content);
            })());
        });
        await Promise.all(writeOperations);
        return { url: `http://localhost:3000/demo/${sanitizeSlug(projectName)}` };
    }
}
class CloudflarePagesDeployProvider {
    config;
    constructor(config) {
        this.config = config;
    }
    async deploy(_zipPath, _projectName) {
        // TODO: implement Cloudflare Pages deployment flow with API.
        // Required env vars: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_PROJECT_NAME.
        throw new Error(`Cloudflare deploy adapter is not implemented yet for project ${this.config.projectName}`);
    }
}
const resolveDeployProvider = () => {
    const provider = (process.env.DEPLOY_PROVIDER ?? "local").toLowerCase();
    if (provider === "cloudflare") {
        const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
        const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
        const projectName = process.env.CLOUDFLARE_PROJECT_NAME ?? "";
        return new CloudflarePagesDeployProvider({ apiToken, accountId, projectName });
    }
    return new FakeLocalDeployProvider();
};
const processDeployJob = async (job) => {
    const { leadId } = job.data;
    const lead = await client_2.prisma.lead.findUnique({
        where: { id: leadId }
    });
    if (!lead) {
        throw new Error(`Lead not found: ${leadId}`);
    }
    const campaignId = lead.campaignId;
    if (lead.status !== client_1.LeadStatus.IMAGES_READY) {
        throw new Error(`Lead ${leadId} must be IMAGES_READY before deploy (current=${lead.status})`);
    }
    const siteGeneratedEvent = await client_2.prisma.event.findFirst({
        where: {
            campaignId,
            leadId,
            type: client_1.EventType.SITE_GENERATED
        },
        orderBy: { createdAt: "desc" },
        select: { metadata: true }
    });
    const zipPath = siteGeneratedEvent?.metadata?.zipPath;
    if (!zipPath) {
        throw new Error(`No generated site bundle found for lead ${leadId}`);
    }
    const injectedZipPath = await injectImageUrls(zipPath, lead.heroImageUrl, lead.serviceImageUrls);
    const deployProvider = resolveDeployProvider();
    const deployResult = await deployProvider.deploy(injectedZipPath, lead.id);
    await client_2.prisma.lead.update({
        where: { id: lead.id },
        data: {
            demoUrl: deployResult.url,
            status: client_1.LeadStatus.DEPLOYED,
            lastError: null
        }
    });
    await client_2.prisma.event.create({
        data: {
            campaignId,
            leadId: lead.id,
            type: client_1.EventType.DEPLOYED,
            metadata: {
                url: deployResult.url
            }
        }
    });
    await (0, queue_1.enqueueEmail)({ leadId: lead.id, step: 1 });
    logMessage(campaignId, lead.id, `deployed to ${deployResult.url} and queued email step 1`);
};
exports.deployerWorker = new bullmq_1.Worker("deploy", processDeployJob, {
    connection: queue_1.connection,
    concurrency: workerConcurrency
});
exports.deployerWorker.on("completed", (job) => {
    logMessage("unknown-campaign", job.data.leadId, `job ${job.id ?? "unknown"} completed`);
});
exports.deployerWorker.on("failed", (job, err) => {
    const leadId = job?.data.leadId ?? "unknown-lead";
    logMessage("unknown-campaign", leadId, `job ${job?.id ?? "unknown"} failed: ${err.message}`);
});
