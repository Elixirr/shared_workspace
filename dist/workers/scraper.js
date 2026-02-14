"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scraperWorker = exports.scrapeListings = void 0;
const client_1 = require("@prisma/client");
const bullmq_1 = require("bullmq");
const client_2 = require("../db/client");
const queue_1 = require("../queue");
const workerName = "scraper";
const defaultConcurrency = 5;
const workerConcurrency = Number(process.env.SCRAPER_CONCURRENCY ?? defaultConcurrency);
const rateLimitDelayMs = Number(process.env.SCRAPER_RATE_LIMIT_MS ?? 0);
const mockListingsProvider = {
    async scrapeListings(niche, city, limit) {
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
const sleep = async (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
});
const logMessage = (campaignId, leadId, message) => {
    console.log(`[${campaignId}][${leadId}][${workerName}] ${message}`);
};
// Placeholder for provider throttling; keep enabled via env while integrating real sources.
const applyRateLimitPlaceholder = async () => {
    if (rateLimitDelayMs > 0) {
        await sleep(rateLimitDelayMs);
    }
};
const scrapeListings = async (niche, city, limit, provider = mockListingsProvider) => provider.scrapeListings(niche, city, limit);
exports.scrapeListings = scrapeListings;
const upsertLeadFromListing = async (campaignId, listing) => {
    if (listing.websiteUrl) {
        return client_2.prisma.lead.upsert({
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
                status: client_1.LeadStatus.SCRAPED,
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
                status: client_1.LeadStatus.SCRAPED
            }
        });
    }
    return client_2.prisma.lead.create({
        data: {
            campaignId,
            businessName: listing.businessName,
            websiteUrl: null,
            phone: listing.phone,
            email: listing.email,
            address: listing.address,
            sourceUrl: listing.sourceUrl,
            status: client_1.LeadStatus.SCRAPED
        }
    });
};
const processScrapeJob = async (job) => {
    const { campaignId } = job.data;
    logMessage(campaignId, "-", "starting scrape batch");
    const campaign = await client_2.prisma.campaign.findUnique({
        where: { id: campaignId }
    });
    if (!campaign) {
        throw new Error(`Campaign not found: ${campaignId}`);
    }
    const listings = await (0, exports.scrapeListings)(campaign.niche, campaign.city, campaign.limit);
    let successCount = 0;
    let failureCount = 0;
    for (const listing of listings) {
        await applyRateLimitPlaceholder();
        try {
            const lead = await upsertLeadFromListing(campaignId, listing);
            await client_2.prisma.event.create({
                data: {
                    campaignId,
                    leadId: lead.id,
                    type: client_1.EventType.LEAD_SCRAPED,
                    metadata: {
                        websiteUrl: listing.websiteUrl,
                        sourceUrl: listing.sourceUrl
                    }
                }
            });
            await (0, queue_1.enqueueEnrich)({ leadId: lead.id });
            successCount += 1;
            logMessage(campaignId, lead.id, "scraped and queued for enrichment");
        }
        catch (error) {
            failureCount += 1;
            const details = error instanceof Error ? error.message : "Unknown error";
            logMessage(campaignId, "-", `lead failed: ${listing.businessName} (${details})`);
        }
    }
    await client_2.prisma.campaign.update({
        where: { id: campaignId },
        data: { status: client_1.CampaignStatus.RUNNING }
    });
    logMessage(campaignId, "-", `batch completed: ${successCount} succeeded, ${failureCount} failed`);
};
exports.scraperWorker = new bullmq_1.Worker("scrape", processScrapeJob, {
    connection: queue_1.connection,
    concurrency: workerConcurrency
});
exports.scraperWorker.on("completed", (job) => {
    const campaignId = job.data.campaignId;
    logMessage(campaignId, "-", `job ${job.id ?? "unknown"} completed`);
});
exports.scraperWorker.on("failed", (job, err) => {
    const campaignId = job?.data.campaignId ?? "unknown-campaign";
    logMessage(campaignId, "-", `job ${job?.id ?? "unknown"} failed: ${err.message}`);
});
