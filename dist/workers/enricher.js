"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enricherWorker = void 0;
const client_1 = require("@prisma/client");
const bullmq_1 = require("bullmq");
const cheerio_1 = require("cheerio");
const client_2 = require("../db/client");
const queue_1 = require("../queue");
const workerName = "enricher";
const defaultConcurrency = 5;
const workerConcurrency = Number(process.env.ENRICHER_CONCURRENCY ?? defaultConcurrency);
const fetchTimeoutMs = Number(process.env.ENRICHER_FETCH_TIMEOUT_MS ?? 7000);
const userAgent = process.env.ENRICHER_USER_AGENT ??
    "Mozilla/5.0 (compatible; OutreachBot/0.1; +https://example.com/bot)";
const logMessage = (campaignId, leadId, message) => {
    console.log(`[${campaignId}][${leadId}][${workerName}] ${message}`);
};
const withHttpProtocol = (url) => {
    if (/^https?:\/\//i.test(url)) {
        return url;
    }
    return `https://${url}`;
};
const toAbsoluteUrl = (baseUrl, path) => {
    const base = new URL(baseUrl);
    return new URL(path, `${base.protocol}//${base.host}`).toString();
};
const safeFetchHtml = async (url) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), fetchTimeoutMs);
    try {
        const response = await fetch(url, {
            method: "GET",
            headers: { "user-agent": userAgent },
            signal: controller.signal
        });
        if (!response.ok) {
            return null;
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("text/html")) {
            return null;
        }
        const html = await response.text();
        const $ = (0, cheerio_1.load)(html);
        const text = $.root().text().replace(/\s+/g, " ").trim();
        return { url, html, text };
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timeoutId);
    }
};
const bestGuessPhone = (text) => {
    const match = text.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/);
    return match ? match[0].trim() : null;
};
const bestGuessEmail = (text) => {
    const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    return match ? match[0].trim().toLowerCase() : null;
};
const extractServiceKeywords = (htmlList) => {
    const stopWords = new Set([
        "home",
        "about",
        "contact",
        "services",
        "service",
        "blog",
        "gallery",
        "testimonials",
        "reviews",
        "quote",
        "free quote"
    ]);
    const keywords = new Set();
    for (const html of htmlList) {
        const $ = (0, cheerio_1.load)(html);
        $("h1, h2, h3, nav a").each((_idx, el) => {
            const raw = $(el).text().replace(/\s+/g, " ").trim().toLowerCase();
            if (!raw) {
                return;
            }
            const cleaned = raw.replace(/[^a-z0-9\s&/-]/g, "").trim();
            if (!cleaned) {
                return;
            }
            const words = cleaned.split(/\s+/);
            if (words.length > 5) {
                return;
            }
            if (stopWords.has(cleaned)) {
                return;
            }
            if (cleaned.length < 3) {
                return;
            }
            keywords.add(cleaned);
        });
    }
    return Array.from(keywords).slice(0, 8);
};
const extractClaims = (text) => {
    const lowered = text.toLowerCase();
    const claims = [];
    if (lowered.includes("licensed")) {
        claims.push("licensed");
    }
    if (lowered.includes("insured")) {
        claims.push("insured");
    }
    if (lowered.includes("free estimate") || lowered.includes("free estimates")) {
        claims.push("free estimates");
    }
    return claims;
};
const crawlLeadWebsite = async (websiteUrl) => {
    const normalizedBaseUrl = withHttpProtocol(websiteUrl);
    const pageUrls = [
        normalizedBaseUrl,
        toAbsoluteUrl(normalizedBaseUrl, "/services"),
        toAbsoluteUrl(normalizedBaseUrl, "/contact")
    ];
    const pages = [];
    for (const pageUrl of pageUrls) {
        const page = await safeFetchHtml(pageUrl);
        if (page) {
            pages.push(page);
        }
    }
    const combinedText = pages.map((p) => p.text).join(" ");
    const serviceKeywords = extractServiceKeywords(pages.map((p) => p.html));
    const claims = extractClaims(combinedText);
    return {
        phone: bestGuessPhone(combinedText),
        email: bestGuessEmail(combinedText),
        serviceKeywords,
        claims,
        pagesVisited: pages.map((p) => p.url)
    };
};
const processEnrichJob = async (job) => {
    const { leadId } = job.data;
    const lead = await client_2.prisma.lead.findUnique({
        where: { id: leadId }
    });
    if (!lead) {
        throw new Error(`Lead not found: ${leadId}`);
    }
    const campaignId = lead.campaignId;
    if (lead.doNotContact) {
        logMessage(campaignId, leadId, "skipped enrichment (doNotContact=true)");
        return;
    }
    if (!lead.websiteUrl) {
        await client_2.prisma.lead.update({
            where: { id: leadId },
            data: {
                status: client_1.LeadStatus.ENRICHED,
                lastError: "no website"
            }
        });
        await client_2.prisma.event.create({
            data: {
                campaignId,
                leadId,
                type: client_1.EventType.LEAD_ENRICHED,
                metadata: {
                    reason: "no website",
                    serviceKeywords: [],
                    claims: [],
                    pagesVisited: []
                }
            }
        });
        await (0, queue_1.enqueueSite)({ leadId });
        logMessage(campaignId, leadId, "enriched without website; queued generic site generation");
        return;
    }
    try {
        const extracted = await crawlLeadWebsite(lead.websiteUrl);
        const phone = extracted.phone ?? lead.phone;
        const email = extracted.email ?? lead.email;
        await client_2.prisma.lead.update({
            where: { id: leadId },
            data: {
                phone,
                email,
                status: client_1.LeadStatus.ENRICHED,
                lastError: extracted.pagesVisited.length > 0 ? null : "crawl yielded no html pages"
            }
        });
        await client_2.prisma.event.create({
            data: {
                campaignId,
                leadId,
                type: client_1.EventType.LEAD_ENRICHED,
                metadata: {
                    phone,
                    email,
                    serviceKeywords: extracted.serviceKeywords,
                    claims: extracted.claims,
                    pagesVisited: extracted.pagesVisited
                }
            }
        });
        await (0, queue_1.enqueueSite)({ leadId });
        logMessage(campaignId, leadId, `enriched; pages=${extracted.pagesVisited.length}, services=${extracted.serviceKeywords.length}`);
    }
    catch (error) {
        const details = error instanceof Error ? error.message : "unknown enrichment error";
        await client_2.prisma.lead.update({
            where: { id: leadId },
            data: {
                status: client_1.LeadStatus.ENRICHED,
                lastError: details
            }
        });
        await client_2.prisma.event.create({
            data: {
                campaignId,
                leadId,
                type: client_1.EventType.LEAD_ENRICHED,
                metadata: {
                    error: details,
                    serviceKeywords: [],
                    claims: [],
                    pagesVisited: []
                }
            }
        });
        await (0, queue_1.enqueueSite)({ leadId });
        logMessage(campaignId, leadId, `enrichment fallback path used (${details})`);
    }
};
exports.enricherWorker = new bullmq_1.Worker("enrich", processEnrichJob, {
    connection: queue_1.connection,
    concurrency: workerConcurrency
});
exports.enricherWorker.on("completed", (job) => {
    logMessage("unknown-campaign", job.data.leadId, `job ${job.id ?? "unknown"} completed`);
});
exports.enricherWorker.on("failed", (job, err) => {
    const leadId = job?.data.leadId ?? "unknown-lead";
    logMessage("unknown-campaign", leadId, `job ${job?.id ?? "unknown"} failed: ${err.message}`);
});
