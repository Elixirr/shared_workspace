"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCampaignMetricsHandler = exports.createCampaignHandler = exports.formatCampaignStatus = void 0;
const zod_1 = require("zod");
const client_1 = require("@prisma/client");
const client_2 = require("../db/client");
const queue_1 = require("../queue");
const campaignCommandSchema = zod_1.z.object({
    niche: zod_1.z.string().min(2),
    city: zod_1.z.string().min(2),
    limit: zod_1.z.number().int().min(1).max(1000)
});
const formatCampaignStatus = (metrics) => ({
    line1: `Found ${metrics.total} ${metrics.niche} in ${metrics.city}`,
    line2: `${metrics.liveSites} live · ${metrics.emailed} emailed · ${metrics.called} called`,
    line3: `${metrics.interested} interested · ${metrics.booked} booked`
});
exports.formatCampaignStatus = formatCampaignStatus;
const createCampaignHandler = async (req, res) => {
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
        const campaign = await client_2.prisma.campaign.create({
            data: {
                niche,
                city,
                limit,
                status: client_1.CampaignStatus.RUNNING,
                events: {
                    create: {
                        type: client_1.EventType.CAMPAIGN_CREATED,
                        metadata: {
                            niche,
                            city,
                            limit
                        }
                    }
                }
            }
        });
        await (0, queue_1.enqueueScrape)({ campaignId: campaign.id });
        res.status(202).json({
            campaignId: campaign.id,
            message: "Pipeline running..."
        });
    }
    catch (error) {
        res.status(500).json({
            error: "Failed to create campaign",
            details: error instanceof Error ? error.message : "Unknown error"
        });
    }
};
exports.createCampaignHandler = createCampaignHandler;
const liveSiteStatuses = [
    client_1.LeadStatus.DEPLOYED,
    client_1.LeadStatus.EMAILED_1,
    client_1.LeadStatus.CALLED_1,
    client_1.LeadStatus.REPLIED,
    client_1.LeadStatus.BOOKED,
    client_1.LeadStatus.DO_NOT_CONTACT
];
const getCampaignMetricsHandler = async (req, res) => {
    const idParam = req.params.id;
    const campaignId = Array.isArray(idParam) ? idParam[0] : idParam;
    if (!campaignId) {
        res.status(400).json({ error: "Campaign id is required" });
        return;
    }
    try {
        const campaign = await client_2.prisma.campaign.findUnique({
            where: { id: campaignId },
            select: { id: true, niche: true, city: true }
        });
        if (!campaign) {
            res.status(404).json({ error: "Campaign not found" });
            return;
        }
        const [leadsTotal, liveSites, emailed, called, interested, booked, doNotContact] = await Promise.all([
            client_2.prisma.lead.count({ where: { campaignId } }),
            client_2.prisma.lead.count({
                where: { campaignId, status: { in: liveSiteStatuses } }
            }),
            client_2.prisma.lead.count({ where: { campaignId, emailSentCount: { gt: 0 } } }),
            client_2.prisma.lead.count({ where: { campaignId, callAttempts: { gt: 0 } } }),
            client_2.prisma.lead.count({ where: { campaignId, interested: true } }),
            client_2.prisma.lead.count({ where: { campaignId, booked: true } }),
            client_2.prisma.lead.count({ where: { campaignId, doNotContact: true } })
        ]);
        const statusLines = (0, exports.formatCampaignStatus)({
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
    }
    catch (error) {
        res.status(500).json({
            error: "Failed to fetch metrics",
            details: error instanceof Error ? error.message : "Unknown error"
        });
    }
};
exports.getCampaignMetricsHandler = getCampaignMetricsHandler;
