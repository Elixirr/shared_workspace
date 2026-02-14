"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.siteGeneratorWorker = void 0;
const client_1 = require("@prisma/client");
const bullmq_1 = require("bullmq");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const jszip_1 = __importDefault(require("jszip"));
const client_2 = require("../db/client");
const queue_1 = require("../queue");
const workerName = "site-generator";
const defaultConcurrency = 5;
const workerConcurrency = Number(process.env.SITE_GENERATOR_CONCURRENCY ?? defaultConcurrency);
const logMessage = (campaignId, leadId, message) => {
    console.log(`[${campaignId}][${leadId}][${workerName}] ${message}`);
};
const sanitizeFileSegment = (value) => value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
const buildIndexHtml = (input) => {
    const servicesMarkup = input.services.length > 0
        ? input.services.map((service) => `<li>${service}</li>`).join("\n")
        : "<li>Residential service</li><li>Commercial service</li><li>Repairs and maintenance</li>";
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${input.businessName} | ${input.city}</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <header class="hero">
      <div class="hero-overlay"></div>
      <div class="hero-content">
        <p class="eyebrow">Local ${input.city} Pros</p>
        <h1>${input.businessName}</h1>
        <p class="subtitle">Trusted local service with fast response and clear pricing.</p>
        <a class="cta-button" href="#contact">Get a Free Estimate</a>
      </div>
      <img class="hero-image" src="{{HERO_IMAGE_URL}}" alt="Hero image placeholder" />
    </header>
    <main>
      <section>
        <h2>Services</h2>
        <ul class="services-list">
          ${servicesMarkup}
        </ul>
        <div class="service-gallery">
          <img src="{{SERVICE_IMAGE_URL_1}}" alt="Service example 1" />
          <img src="{{SERVICE_IMAGE_URL_2}}" alt="Service example 2" />
          <img src="{{SERVICE_IMAGE_URL_3}}" alt="Service example 3" />
        </div>
      </section>
      <section id="contact">
        <h2>Contact</h2>
        <p>Call us: ${input.phone ?? "555-000-0000"}</p>
        <p>Email: ${input.email ?? "hello@example.com"}</p>
      </section>
    </main>
  </body>
</html>
`;
};
const buildStyleCss = () => `:root {
  --bg: #f7f3ea;
  --text: #1f2937;
  --brand: #0f766e;
  --brand-dark: #115e59;
  --surface: #ffffff;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: "Trebuchet MS", "Segoe UI", sans-serif;
  color: var(--text);
  background: linear-gradient(180deg, #fffaf0 0%, var(--bg) 100%);
}

.hero {
  position: relative;
  min-height: 60vh;
  padding: 3rem 1.5rem;
  display: grid;
  align-items: center;
  overflow: hidden;
}

.hero-overlay {
  position: absolute;
  inset: 0;
  background: radial-gradient(circle at top right, rgba(15, 118, 110, 0.18), transparent 55%);
}

.hero-content {
  position: relative;
  z-index: 2;
  max-width: 42rem;
}

.eyebrow {
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin: 0 0 0.5rem;
}

h1 {
  margin: 0;
  font-size: clamp(2rem, 5vw, 4rem);
}

.subtitle {
  font-size: 1.1rem;
  line-height: 1.6;
}

.cta-button {
  display: inline-block;
  margin-top: 1rem;
  padding: 0.8rem 1.2rem;
  color: white;
  background: var(--brand);
  border-radius: 0.5rem;
  text-decoration: none;
}

.cta-button:hover {
  background: var(--brand-dark);
}

.hero-image {
  width: 100%;
  max-height: 320px;
  object-fit: cover;
  border-radius: 1rem;
  margin-top: 1.5rem;
  position: relative;
  z-index: 1;
}

main {
  display: grid;
  gap: 1.5rem;
  padding: 1.5rem;
  max-width: 900px;
  margin: 0 auto 2rem;
}

section {
  background: var(--surface);
  border-radius: 0.75rem;
  padding: 1.25rem;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.08);
}

.services-list {
  margin: 0;
  padding-left: 1rem;
}

.service-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.75rem;
  margin-top: 1rem;
}

.service-gallery img {
  width: 100%;
  height: 140px;
  object-fit: cover;
  border-radius: 0.5rem;
}
`;
const writeZip = async (zipPath, files) => {
    const zip = new jszip_1.default();
    Object.entries(files).forEach(([name, content]) => {
        zip.file(name, content);
    });
    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    await node_fs_1.promises.writeFile(zipPath, buffer);
};
const fakeOpenClawClient = {
    async generateSite(input) {
        const safeLeadId = sanitizeFileSegment(input.leadId);
        const zipPath = node_path_1.default.join("/tmp", `${safeLeadId}.zip`);
        const files = {
            "index.html": buildIndexHtml(input),
            "style.css": buildStyleCss()
        };
        await writeZip(zipPath, files);
        return {
            zipPath,
            summary: `Generated MVP static site bundle for ${input.businessName}`
        };
    }
};
const openClawClient = fakeOpenClawClient;
const processSiteJob = async (job) => {
    const { leadId } = job.data;
    const lead = await client_2.prisma.lead.findUnique({
        where: { id: leadId },
        include: { campaign: true }
    });
    if (!lead) {
        throw new Error(`Lead not found: ${leadId}`);
    }
    const campaignId = lead.campaignId;
    const servicesFromEvents = await client_2.prisma.event.findMany({
        where: {
            campaignId,
            leadId,
            type: client_1.EventType.LEAD_ENRICHED
        },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { metadata: true }
    });
    const latestMetadata = servicesFromEvents[0]?.metadata;
    const services = Array.isArray(latestMetadata?.serviceKeywords)
        ? latestMetadata.serviceKeywords.filter((item) => typeof item === "string")
        : [];
    const output = await openClawClient.generateSite({
        leadId: lead.id,
        businessName: lead.businessName ?? "Local Contractor",
        city: lead.campaign.city,
        services,
        phone: lead.phone,
        email: lead.email
    });
    await client_2.prisma.lead.update({
        where: { id: lead.id },
        data: {
            status: client_1.LeadStatus.SITE_GENERATED,
            lastError: null
        }
    });
    await client_2.prisma.event.create({
        data: {
            campaignId,
            leadId: lead.id,
            type: client_1.EventType.SITE_GENERATED,
            metadata: {
                zipPath: output.zipPath,
                summary: output.summary
            }
        }
    });
    await (0, queue_1.enqueueImage)({ leadId: lead.id });
    logMessage(campaignId, lead.id, `site generated at ${output.zipPath}`);
};
exports.siteGeneratorWorker = new bullmq_1.Worker("site", processSiteJob, {
    connection: queue_1.connection,
    concurrency: workerConcurrency
});
exports.siteGeneratorWorker.on("completed", (job) => {
    logMessage("unknown-campaign", job.data.leadId, `job ${job.id ?? "unknown"} completed`);
});
exports.siteGeneratorWorker.on("failed", (job, err) => {
    const leadId = job?.data.leadId ?? "unknown-lead";
    logMessage("unknown-campaign", leadId, `job ${job?.id ?? "unknown"} failed: ${err.message}`);
});
