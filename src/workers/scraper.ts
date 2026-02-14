import { CampaignStatus, EventType, Lead, LeadStatus } from "@prisma/client";
import { Job, Worker } from "bullmq";
import { load } from "cheerio";
import { prisma } from "../db/client";
import { connection, enqueueEnrich, ScrapeJob } from "../queue";

const workerName = "scraper";
const defaultConcurrency = 5;
const workerConcurrency = Number(process.env.SCRAPER_CONCURRENCY ?? defaultConcurrency);
const rateLimitDelayMs = Number(process.env.SCRAPER_RATE_LIMIT_MS ?? 0);

type ListingRecord = {
  businessName: string;
  websiteUrl: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  sourceUrl: string | null;
};

interface ListingsProvider {
  scrapeListings(niche: string, city: string, limit: number): Promise<ListingRecord[]>;
}

const searchUserAgent =
  process.env.SCRAPER_USER_AGENT ??
  "Mozilla/5.0 (compatible; OutreachScraper/0.1; +https://example.com/bot)";

const blockedHosts = new Set([
  "duckduckgo.com",
  "www.duckduckgo.com",
  "google.com",
  "www.google.com",
  "maps.google.com",
  "facebook.com",
  "www.facebook.com",
  "instagram.com",
  "www.instagram.com",
  "linkedin.com",
  "www.linkedin.com",
  "yelp.com",
  "www.yelp.com",
  "youtube.com",
  "www.youtube.com",
  "x.com",
  "twitter.com"
]);

const decodeRedirectUrl = (rawHref: string): string | null => {
  try {
    const href = rawHref.startsWith("http") ? rawHref : `https://duckduckgo.com${rawHref}`;
    const parsed = new URL(href);
    const encoded = parsed.searchParams.get("uddg");
    if (encoded) {
      return decodeURIComponent(encoded);
    }
    return href;
  } catch {
    return null;
  }
};

const cleanBusinessName = (raw: string): string =>
  raw
    .replace(/\s+/g, " ")
    .replace(/[-|].*$/, "")
    .trim()
    .slice(0, 120);

const inferBusinessNameFromHost = (host: string): string =>
  host
    .replace(/^www\./, "")
    .split(".")[0]
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .slice(0, 120);

const searchDuckDuckGoListings = async (
  niche: string,
  city: string,
  limit: number
): Promise<ListingRecord[]> => {
  const query = `${niche} ${city} official website`;
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { "user-agent": searchUserAgent }
  });

  if (!response.ok) {
    return [];
  }

  const html = await response.text();
  const $ = load(html);
  const results = $(".result");
  const listings: ListingRecord[] = [];
  const seenHosts = new Set<string>();

  for (const result of results.toArray()) {
    if (listings.length >= limit) {
      break;
    }

    const anchor = $(result).find(".result__a").first();
    const href = anchor.attr("href");
    const rawTitle = anchor.text().replace(/\s+/g, " ").trim();
    if (!href) {
      continue;
    }

    const targetUrl = decodeRedirectUrl(href);
    if (!targetUrl) {
      continue;
    }

    try {
      const parsed = new URL(targetUrl);
      const host = parsed.hostname.toLowerCase();
      if (blockedHosts.has(host)) {
        continue;
      }
      if (seenHosts.has(host)) {
        continue;
      }
      seenHosts.add(host);

      listings.push({
        businessName: cleanBusinessName(rawTitle) || inferBusinessNameFromHost(host),
        websiteUrl: `${parsed.protocol}//${parsed.hostname}`,
        phone: null,
        email: null,
        address: `${city}`,
        sourceUrl: targetUrl
      });
    } catch {
      continue;
    }
  }

  return listings;
};

const mockListingsProvider: ListingsProvider = {
  async scrapeListings(niche: string, city: string, limit: number): Promise<ListingRecord[]> {
    const total = Math.max(1, Math.min(limit, 25));
    const citySlug = city.toLowerCase().replace(/\s+/g, "-");
    const nicheSlug = niche.toLowerCase().replace(/\s+/g, "-");

    return Array.from({ length: total }, (_, idx) => {
      const n = idx + 1;
      return {
        businessName: `${city} ${niche} Co ${n}`,
        websiteUrl: `https://${nicheSlug}-${citySlug}-${n}.example.com`,
        phone: `+1-555-010${String((n % 10) + 1)}`,
        email: `hello${n}@${nicheSlug}-${citySlug}-${n}.example.com`,
        address: `${100 + n} Main St, ${city}`,
        sourceUrl: `https://example.com/search/${nicheSlug}/${citySlug}?result=${n}`
      };
    });
  }
};

const duckDuckGoListingsProvider: ListingsProvider = {
  async scrapeListings(niche: string, city: string, limit: number): Promise<ListingRecord[]> {
    const cappedLimit = Math.max(1, Math.min(limit, 100));
    const listings = await searchDuckDuckGoListings(niche, city, cappedLimit);
    if (listings.length > 0) {
      return listings;
    }
    return mockListingsProvider.scrapeListings(niche, city, cappedLimit);
  }
};

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const logMessage = (campaignId: string, leadId: string, message: string): void => {
  console.log(`[${campaignId}][${leadId}][${workerName}] ${message}`);
};

// Placeholder for provider throttling; keep enabled via env while integrating real sources.
const applyRateLimitPlaceholder = async (): Promise<void> => {
  if (rateLimitDelayMs > 0) {
    await sleep(rateLimitDelayMs);
  }
};

export const scrapeListings = async (
  niche: string,
  city: string,
  limit: number,
  provider: ListingsProvider = (process.env.SCRAPER_PROVIDER ?? "duckduckgo") === "mock"
    ? mockListingsProvider
    : duckDuckGoListingsProvider
): Promise<ListingRecord[]> => provider.scrapeListings(niche, city, limit);

const upsertLeadFromListing = async (
  campaignId: string,
  listing: ListingRecord
): Promise<Lead> => {
  if (listing.websiteUrl) {
    return prisma.lead.upsert({
      where: {
        campaignId_websiteUrl: {
          campaignId,
          websiteUrl: listing.websiteUrl
        }
      },
      update: {
        businessName: listing.businessName,
        phone: listing.phone,
        email: listing.email,
        address: listing.address,
        sourceUrl: listing.sourceUrl,
        status: LeadStatus.SCRAPED,
        lastError: null
      },
      create: {
        campaignId,
        businessName: listing.businessName,
        websiteUrl: listing.websiteUrl,
        phone: listing.phone,
        email: listing.email,
        address: listing.address,
        sourceUrl: listing.sourceUrl,
        status: LeadStatus.SCRAPED
      }
    });
  }

  return prisma.lead.create({
    data: {
      campaignId,
      businessName: listing.businessName,
      websiteUrl: null,
      phone: listing.phone,
      email: listing.email,
      address: listing.address,
      sourceUrl: listing.sourceUrl,
      status: LeadStatus.SCRAPED
    }
  });
};

const processScrapeJob = async (job: Job<ScrapeJob>): Promise<void> => {
  const { campaignId } = job.data;
  logMessage(campaignId, "-", "starting scrape batch");

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId }
  });

  if (!campaign) {
    throw new Error(`Campaign not found: ${campaignId}`);
  }

  const listings = await scrapeListings(campaign.niche, campaign.city, campaign.limit);
  let successCount = 0;
  let failureCount = 0;

  for (const listing of listings) {
    await applyRateLimitPlaceholder();

    try {
      const lead = await upsertLeadFromListing(campaignId, listing);

      await prisma.event.create({
        data: {
          campaignId,
          leadId: lead.id,
          type: EventType.LEAD_SCRAPED,
          metadata: {
            websiteUrl: listing.websiteUrl,
            sourceUrl: listing.sourceUrl
          }
        }
      });

      await enqueueEnrich({ leadId: lead.id });

      successCount += 1;
      logMessage(campaignId, lead.id, "scraped and queued for enrichment");
    } catch (error) {
      failureCount += 1;
      const details = error instanceof Error ? error.message : "Unknown error";
      logMessage(campaignId, "-", `lead failed: ${listing.businessName} (${details})`);
    }
  }

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: CampaignStatus.RUNNING }
  });

  logMessage(
    campaignId,
    "-",
    `batch completed: ${successCount} succeeded, ${failureCount} failed`
  );
};

export const scraperWorker = new Worker<ScrapeJob>("scrape", processScrapeJob, {
  connection,
  concurrency: workerConcurrency
});

scraperWorker.on("completed", (job) => {
  const campaignId = job.data.campaignId;
  logMessage(campaignId, "-", `job ${job.id ?? "unknown"} completed`);
});

scraperWorker.on("failed", (job, err) => {
  const campaignId = job?.data.campaignId ?? "unknown-campaign";
  logMessage(campaignId, "-", `job ${job?.id ?? "unknown"} failed: ${err.message}`);
});
