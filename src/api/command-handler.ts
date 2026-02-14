import { Request, Response } from "express";
import { z } from "zod";
import { CampaignStatus, EventType, LeadStatus } from "@prisma/client";
import { prisma } from "../db/client";
import { enqueueScrape } from "../queue";

const campaignCommandSchema = z.object({
  niche: z.string().min(2),
  city: z.string().min(2),
  limit: z.number().int().min(1).max(1000)
});

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

    const { niche, city, limit } = parsed.data;

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
              limit
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
