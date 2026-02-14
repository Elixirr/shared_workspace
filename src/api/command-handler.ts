import { Request, Response } from "express";
import { load } from "cheerio";
import { z } from "zod";
import { CampaignStatus, EventType, LeadStatus } from "@prisma/client";
import { prisma } from "../db/client";
import { enqueueEnrich, enqueueScrape, enqueueSite } from "../queue";

const campaignCommandSchema = z.object({
  niche: z.string().min(2),
  city: z.string().min(2),
  limit: z.number().int().min(1).max(1000),
  sheetDataUrl: z.string().url().optional()
});

const oneLeadSearchSchema = z.object({
  niche: z.string().min(2),
  city: z.string().min(2),
  sheetDataUrl: z.string().url().optional()
});

const manualOneLeadSchema = z.object({
  niche: z.string().min(2),
  city: z.string().min(2),
  businessName: z.string().min(2),
  websiteUrl: z.string().url(),
  sheetDataUrl: z.string().url().optional()
});

type SearchLeadCandidate = {
  businessName: string;
  websiteUrl: string;
  sourceUrl: string;
};

type CampaignMetricsSummary = {
  total: number;
  niche: string;
  city: string;
  liveSites: number;
  emailed: number;
  called: number;
  interested: number;
  booked: number;
};

export const formatCampaignStatus = (
  metrics: CampaignMetricsSummary
): { line1: string; line2: string; line3: string } => ({
  line1: `Found ${metrics.total} ${metrics.niche} in ${metrics.city}`,
  line2: `${metrics.liveSites} live · ${metrics.emailed} emailed · ${metrics.called} called`,
  line3: `${metrics.interested} interested · ${metrics.booked} booked`
});

export const createCampaignHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = campaignCommandSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid campaign command payload",
        details: parsed.error.flatten()
      });
      return;
    }

    const { niche, city, limit, sheetDataUrl } = parsed.data;

    // Create campaign and first event together for consistency.
    const campaign = await prisma.campaign.create({
      data: {
        niche,
        city,
        limit,
        status: CampaignStatus.RUNNING,
        events: {
          create: {
            type: EventType.CAMPAIGN_CREATED,
            metadata: {
              niche,
              city,
              limit,
              sheetDataUrl: sheetDataUrl ?? null
            }
          }
        }
      }
    });

    await enqueueScrape({ campaignId: campaign.id });

    res.status(202).json({
      campaignId: campaign.id,
      message: "Pipeline running..."
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to create campaign",
      details: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

const blockedHosts = new Set([
  "duckduckgo.com",
  "www.duckduckgo.com",
  "maps.google.com",
  "google.com",
  "www.google.com",
  "facebook.com",
  "www.facebook.com",
  "instagram.com",
  "www.instagram.com",
  "yelp.com",
  "www.yelp.com",
  "linkedin.com",
  "www.linkedin.com"
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

const searchOneLeadFromWeb = async (niche: string, city: string): Promise<SearchLeadCandidate | null> => {
  const query = `${niche} ${city} official website`;
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; OutreachSearchBot/0.1; +https://example.com/bot)"
    }
  });

  if (!response.ok) {
    return null;
  }

  const html = await response.text();
  const $ = load(html);
  const results = $(".result");

  for (const result of results.toArray()) {
    const anchor = $(result).find(".result__a").first();
    const title = anchor.text().replace(/\s+/g, " ").trim();
    const href = anchor.attr("href");
    if (!href || !title) {
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

      return {
        businessName: title.slice(0, 120),
        websiteUrl: `${parsed.protocol}//${parsed.hostname}`,
        sourceUrl: targetUrl
      };
    } catch {
      continue;
    }
  }

  return null;
};

export const searchOneLeadAndCreateCampaignHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const parsed = oneLeadSearchSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid search payload",
        details: parsed.error.flatten()
      });
      return;
    }

    const { niche, city, sheetDataUrl } = parsed.data;
    const candidate = await searchOneLeadFromWeb(niche, city);

    if (!candidate) {
      res.status(404).json({ error: "No lead found for this niche/city search" });
      return;
    }

    const campaign = await prisma.campaign.create({
      data: {
        niche,
        city,
        limit: 1,
        status: CampaignStatus.RUNNING,
        events: {
          create: {
            type: EventType.CAMPAIGN_CREATED,
            metadata: {
              niche,
              city,
              mode: "search-one",
              sheetDataUrl: sheetDataUrl ?? null
            }
          }
        }
      }
    });

    const lead = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        businessName: candidate.businessName,
        websiteUrl: candidate.websiteUrl,
        sourceUrl: candidate.sourceUrl,
        status: LeadStatus.SCRAPED
      }
    });

    await prisma.event.create({
      data: {
        campaignId: campaign.id,
        leadId: lead.id,
        type: EventType.LEAD_SCRAPED,
        metadata: {
          sourceUrl: candidate.sourceUrl,
          websiteUrl: candidate.websiteUrl,
          mode: "search-one"
        }
      }
    });

    await enqueueEnrich({ leadId: lead.id });

    res.status(202).json({
      campaignId: campaign.id,
      leadId: lead.id,
      businessName: candidate.businessName,
      websiteUrl: candidate.websiteUrl,
      message: "Lead found and pipeline started"
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to search lead and start pipeline",
      details: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

export const createManualOneLeadCampaignHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const parsed = manualOneLeadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid manual lead payload",
        details: parsed.error.flatten()
      });
      return;
    }

    const { niche, city, businessName, websiteUrl, sheetDataUrl } = parsed.data;

    const campaign = await prisma.campaign.create({
      data: {
        niche,
        city,
        limit: 1,
        status: CampaignStatus.RUNNING,
        events: {
          create: {
            type: EventType.CAMPAIGN_CREATED,
            metadata: {
              niche,
              city,
              mode: "manual-one",
              sheetDataUrl: sheetDataUrl ?? null
            }
          }
        }
      }
    });

    const lead = await prisma.lead.create({
      data: {
        campaignId: campaign.id,
        businessName,
        websiteUrl,
        sourceUrl: websiteUrl,
        status: LeadStatus.SCRAPED
      }
    });

    await prisma.event.create({
      data: {
        campaignId: campaign.id,
        leadId: lead.id,
        type: EventType.LEAD_SCRAPED,
        metadata: {
          sourceUrl: websiteUrl,
          websiteUrl,
          mode: "manual-one"
        }
      }
    });

    await enqueueEnrich({ leadId: lead.id });

    res.status(202).json({
      campaignId: campaign.id,
      leadId: lead.id,
      businessName,
      websiteUrl,
      message: "Manual lead added and pipeline started"
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to create manual lead campaign",
      details: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

const liveSiteStatuses: LeadStatus[] = [
  LeadStatus.DEPLOYED,
  LeadStatus.EMAILED_1,
  LeadStatus.CALLED_1,
  LeadStatus.REPLIED,
  LeadStatus.BOOKED,
  LeadStatus.DO_NOT_CONTACT
];

export const getCampaignMetricsHandler = async (req: Request, res: Response): Promise<void> => {
  const idParam = req.params.id;
  const campaignId = Array.isArray(idParam) ? idParam[0] : idParam;

  if (!campaignId) {
    res.status(400).json({ error: "Campaign id is required" });
    return;
  }

  try {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, niche: true, city: true }
    });

    if (!campaign) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    const [
      leadsTotal,
      liveSites,
      emailed,
      called,
      interested,
      booked,
      doNotContact
    ] = await Promise.all([
      prisma.lead.count({ where: { campaignId } }),
      prisma.lead.count({
        where: { campaignId, status: { in: liveSiteStatuses } }
      }),
      prisma.lead.count({ where: { campaignId, emailSentCount: { gt: 0 } } }),
      prisma.lead.count({ where: { campaignId, callAttempts: { gt: 0 } } }),
      prisma.lead.count({ where: { campaignId, interested: true } }),
      prisma.lead.count({ where: { campaignId, booked: true } }),
      prisma.lead.count({ where: { campaignId, doNotContact: true } })
    ]);

    const statusLines = formatCampaignStatus({
      total: leadsTotal,
      niche: campaign.niche,
      city: campaign.city,
      liveSites,
      emailed,
      called,
      interested,
      booked
    });

    res.json({
      leadsTotal,
      liveSites,
      emailed,
      called,
      interested,
      booked,
      doNotContact,
      line1: statusLines.line1,
      line2: statusLines.line2,
      line3: statusLines.line3
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch metrics",
      details: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

export const getCampaignLeadsHandler = async (req: Request, res: Response): Promise<void> => {
  const idParam = req.params.id;
  const campaignId = Array.isArray(idParam) ? idParam[0] : idParam;

  if (!campaignId) {
    res.status(400).json({ error: "Campaign id is required" });
    return;
  }

  try {
    const leads = await prisma.lead.findMany({
      where: { campaignId },
      select: {
        id: true,
        businessName: true,
        websiteUrl: true,
        email: true,
        phone: true,
        status: true,
        demoUrl: true,
        createdAt: true
      },
      orderBy: { createdAt: "desc" }
    });

    res.json({ campaignId, leads });
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch campaign leads",
      details: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

export const regenerateLeadDemoHandler = async (req: Request, res: Response): Promise<void> => {
  const idParam = req.params.id;
  const leadId = Array.isArray(idParam) ? idParam[0] : idParam;

  if (!leadId) {
    res.status(400).json({ error: "Lead id is required" });
    return;
  }

  try {
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, campaignId: true }
    });

    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }

    await enqueueEnrich({ leadId: lead.id });

    res.status(202).json({
      leadId: lead.id,
      campaignId: lead.campaignId,
      message: "Lead re-enrichment and site regeneration queued"
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to queue site regeneration",
      details: error instanceof Error ? error.message : "Unknown error"
    });
  }
};
