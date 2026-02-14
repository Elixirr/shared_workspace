import { EventType, LeadStatus } from "@prisma/client";
import { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../db/client";

const callWebhookSchema = z.object({
  leadId: z.string().optional(),
  campaignId: z.string().optional(),
  callId: z.string().optional(),
  status: z.string(),
  transcript: z.string().optional()
});

const hasOptOutIntent = (transcript: string): boolean => {
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

export const callWebhookHandler = async (req: Request, res: Response): Promise<void> => {
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

  let leadId: string | null = payload.leadId ?? null;
  let campaignId: string | null = payload.campaignId ?? null;

  if (leadId) {
    const lead = await prisma.lead.findUnique({
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

  await prisma.event.create({
    data: {
      campaignId,
      leadId,
      type: EventType.CALL_RESULT,
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
    await prisma.lead.update({
      where: { id: leadId },
      data: {
        doNotContact: true,
        status: LeadStatus.DO_NOT_CONTACT
      }
    });
  }

  res.json({
    ok: true,
    provider,
    optOutApplied: Boolean(leadId && optOut)
  });
};
