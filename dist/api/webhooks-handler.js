"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.callWebhookHandler = void 0;
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const client_2 = require("../db/client");
const callWebhookSchema = zod_1.z.object({
    leadId: zod_1.z.string().optional(),
    campaignId: zod_1.z.string().optional(),
    callId: zod_1.z.string().optional(),
    status: zod_1.z.string(),
    transcript: zod_1.z.string().optional()
});
const hasOptOutIntent = (transcript) => {
    const text = transcript.toLowerCase();
    const phrases = [
        "do not call",
        "don't call",
        "stop calling",
        "remove me",
        "opt out",
        "unsubscribe"
    ];
    return phrases.some((phrase) => text.includes(phrase));
};
const callWebhookHandler = async (req, res) => {
    const parsed = callWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({
            error: "Invalid webhook payload",
            details: parsed.error.flatten()
        });
        return;
    }
    const payload = parsed.data;
    const provider = req.params.provider;
    let leadId = payload.leadId ?? null;
    let campaignId = payload.campaignId ?? null;
    if (leadId) {
        const lead = await client_2.prisma.lead.findUnique({
            where: { id: leadId },
            select: { id: true, campaignId: true }
        });
        if (!lead) {
            res.status(404).json({ error: "Lead not found" });
            return;
        }
        leadId = lead.id;
        campaignId = lead.campaignId;
    }
    if (!campaignId) {
        res.status(400).json({ error: "campaignId is required when leadId is not provided" });
        return;
    }
    const transcript = payload.transcript ?? "";
    const optOut = transcript.length > 0 ? hasOptOutIntent(transcript) : false;
    await client_2.prisma.event.create({
        data: {
            campaignId,
            leadId,
            type: client_1.EventType.CALL_RESULT,
            metadata: {
                provider,
                callId: payload.callId ?? null,
                status: payload.status,
                transcript: transcript || null,
                optOut
            }
        }
    });
    if (leadId && optOut) {
        await client_2.prisma.lead.update({
            where: { id: leadId },
            data: {
                doNotContact: true,
                status: client_1.LeadStatus.DO_NOT_CONTACT
            }
        });
    }
    res.json({
        ok: true,
        provider,
        optOutApplied: Boolean(leadId && optOut)
    });
};
exports.callWebhookHandler = callWebhookHandler;
