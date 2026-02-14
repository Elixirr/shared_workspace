import { EventType, LeadStatus } from "@prisma/client";
import { Job, Worker } from "bullmq";
import { load } from "cheerio";
import { prisma } from "../db/client";
import { connection, EnrichJob, enqueueSite } from "../queue";

const workerName = "enricher";
const defaultConcurrency = 5;
const workerConcurrency = Number(process.env.ENRICHER_CONCURRENCY ?? defaultConcurrency);
const fetchTimeoutMs = Number(process.env.ENRICHER_FETCH_TIMEOUT_MS ?? 7000);
const placeholderWebsiteUrl =
  process.env.PLACEHOLDER_WEBSITE_URL ?? "https://www.kirnconstruction.com/";
const userAgent =
  process.env.ENRICHER_USER_AGENT ??
  "Mozilla/5.0 (compatible; OutreachBot/0.1; +https://example.com/bot)";

type PageResult = {
  url: string;
  html: string;
  text: string;
};

type ExtractionSummary = {
  phone: string | null;
  email: string | null;
  serviceKeywords: string[];
  claims: string[];
  brandColors: string[];
  summary: string;
  pagesVisited: string[];
};

const logMessage = (campaignId: string, leadId: string, message: string): void => {
  console.log(`[${campaignId}][${leadId}][${workerName}] ${message}`);
};

const withHttpProtocol = (url: string): string => {
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  return `https://${url}`;
};

const toAbsoluteUrl = (baseUrl: string, path: string): string => {
  const base = new URL(baseUrl);
  return new URL(path, `${base.protocol}//${base.host}`).toString();
};

const isMockWebsiteUrl = (websiteUrl: string): boolean => {
  try {
    const host = new URL(withHttpProtocol(websiteUrl)).hostname.toLowerCase();
    return host === "example.com" || host.endsWith(".example.com");
  } catch {
    return false;
  }
};

const safeFetchHtml = async (url: string): Promise<PageResult | null> => {
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
    const $ = load(html);
    const text = $.root().text().replace(/\s+/g, " ").trim();
    return { url, html, text };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
};

const bestGuessPhone = (text: string): string | null => {
  const match = text.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/);
  return match ? match[0].trim() : null;
};

const bestGuessEmail = (text: string): string | null => {
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0].trim().toLowerCase() : null;
};

const extractServiceKeywords = (htmlList: string[]): string[] => {
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

  const keywords = new Set<string>();
  for (const html of htmlList) {
    const $ = load(html);
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

const extractClaims = (text: string): string[] => {
  const lowered = text.toLowerCase();
  const claims: string[] = [];
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

const normalizeHexColor = (color: string): string => {
  const cleaned = color.toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(cleaned)) {
    return `#${cleaned[1]}${cleaned[1]}${cleaned[2]}${cleaned[2]}${cleaned[3]}${cleaned[3]}`;
  }
  return cleaned;
};

const hexToRgb = (hex: string): { r: number; g: number; b: number } | null => {
  const normalized = normalizeHexColor(hex);
  const match = /^#([0-9a-f]{6})$/.exec(normalized);
  if (!match) {
    return null;
  }
  const value = match[1];
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16)
  };
};

const isUsableBrandColor = (hex: string): boolean => {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    return false;
  }

  const { r, g, b } = rgb;
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  const maxDiff = Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b));

  // Drop near-white / near-black and mostly grayscale colors.
  if (brightness < 30 || brightness > 235) {
    return false;
  }
  if (maxDiff < 12) {
    return false;
  }

  return true;
};

const extractBrandColors = (htmlList: string[]): string[] => {
  const counts = new Map<string, number>();
  const hexPattern = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g;

  for (const html of htmlList) {
    const matches = html.match(hexPattern) ?? [];
    for (const raw of matches) {
      const normalized = normalizeHexColor(raw);
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
  }

  const sorted = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([color]) => color);

  const usable = sorted.filter(isUsableBrandColor);
  const palette = (usable.length > 0 ? usable : sorted).slice(0, 3);
  return palette;
};

const extractSummary = (text: string): string => {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "";
  }

  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 30 && line.length < 220);

  return sentences.slice(0, 2).join(" ").slice(0, 380);
};

const crawlLeadWebsite = async (websiteUrl: string): Promise<ExtractionSummary> => {
  const normalizedBaseUrl = withHttpProtocol(websiteUrl);
  const pageUrls = [
    normalizedBaseUrl,
    toAbsoluteUrl(normalizedBaseUrl, "/services"),
    toAbsoluteUrl(normalizedBaseUrl, "/contact")
  ];

  const pages: PageResult[] = [];
  for (const pageUrl of pageUrls) {
    const page = await safeFetchHtml(pageUrl);
    if (page) {
      pages.push(page);
    }
  }

  const combinedText = pages.map((p) => p.text).join(" ");
  const htmlList = pages.map((p) => p.html);
  const serviceKeywords = extractServiceKeywords(htmlList);
  const claims = extractClaims(combinedText);
  const brandColors = extractBrandColors(htmlList);
  const summary = extractSummary(combinedText);

  return {
    phone: bestGuessPhone(combinedText),
    email: bestGuessEmail(combinedText),
    serviceKeywords,
    claims,
    brandColors,
    summary,
    pagesVisited: pages.map((p) => p.url)
  };
};

const processEnrichJob = async (job: Job<EnrichJob>): Promise<void> => {
  const { leadId } = job.data;

  const lead = await prisma.lead.findUnique({
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

  const usePlaceholder =
    !lead.websiteUrl || isMockWebsiteUrl(lead.websiteUrl);
  const websiteToCrawl = usePlaceholder
    ? placeholderWebsiteUrl
    : lead.websiteUrl;
  if (!websiteToCrawl) {
    throw new Error("No website available for enrichment");
  }

  try {
    const extracted = await crawlLeadWebsite(websiteToCrawl);
    const phone = extracted.phone ?? lead.phone;
    const email = extracted.email ?? lead.email;

    await prisma.lead.update({
      where: { id: leadId },
      data: {
        phone,
        email,
        status: LeadStatus.ENRICHED,
        lastError:
          extracted.pagesVisited.length > 0
            ? usePlaceholder
              ? `placeholder crawl used (${placeholderWebsiteUrl})`
              : null
            : "crawl yielded no html pages"
      }
    });

    await prisma.event.create({
      data: {
        campaignId,
        leadId,
        type: EventType.LEAD_ENRICHED,
        metadata: {
          phone,
          email,
          serviceKeywords: extracted.serviceKeywords,
          claims: extracted.claims,
          brandColors: extracted.brandColors,
          summary: extracted.summary,
          placeholderUsed: usePlaceholder,
          crawledFromUrl: websiteToCrawl,
          pagesVisited: extracted.pagesVisited
        }
      }
    });

    await enqueueSite({ leadId });
    logMessage(
      campaignId,
      leadId,
      `enriched; pages=${extracted.pagesVisited.length}, services=${extracted.serviceKeywords.length}, source=${websiteToCrawl}`
    );
  } catch (error) {
    const details = error instanceof Error ? error.message : "unknown enrichment error";

    await prisma.lead.update({
      where: { id: leadId },
      data: {
        status: LeadStatus.ENRICHED,
        lastError: details
      }
    });

    await prisma.event.create({
      data: {
        campaignId,
        leadId,
        type: EventType.LEAD_ENRICHED,
        metadata: {
          error: details,
          serviceKeywords: [],
          claims: [],
          brandColors: [],
          summary: "",
          pagesVisited: []
        }
      }
    });

    await enqueueSite({ leadId });
    logMessage(campaignId, leadId, `enrichment fallback path used (${details})`);
  }
};

export const enricherWorker = new Worker<EnrichJob>("enrich", processEnrichJob, {
  connection,
  concurrency: workerConcurrency
});

enricherWorker.on("completed", (job) => {
  logMessage("unknown-campaign", job.data.leadId, `job ${job.id ?? "unknown"} completed`);
});

enricherWorker.on("failed", (job, err) => {
  const leadId = job?.data.leadId ?? "unknown-lead";
  logMessage("unknown-campaign", leadId, `job ${job?.id ?? "unknown"} failed: ${err.message}`);
});
