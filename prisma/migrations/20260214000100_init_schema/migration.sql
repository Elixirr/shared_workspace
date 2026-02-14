-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('CREATED', 'RUNNING', 'COMPLETE', 'FAILED');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM (
  'NEW',
  'SCRAPED',
  'ENRICHED',
  'SITE_GENERATED',
  'IMAGES_READY',
  'DEPLOYED',
  'EMAILED_1',
  'CALLED_1',
  'REPLIED',
  'BOOKED',
  'DO_NOT_CONTACT'
);

-- CreateEnum
CREATE TYPE "EventType" AS ENUM (
  'CAMPAIGN_CREATED',
  'LEAD_SCRAPED',
  'SCRAPE_COMPLETED',
  'LEAD_ENRICHED',
  'SITE_GENERATED',
  'IMAGES_READY',
  'DEPLOYED',
  'SITE_DEPLOYED',
  'EMAIL_SENT',
  'CALL_PLACED',
  'CALL_RESULT',
  'LEAD_REPLIED',
  'LEAD_BOOKED',
  'ERROR'
);

-- CreateTable
CREATE TABLE "Campaign" (
  "id" TEXT NOT NULL,
  "niche" TEXT NOT NULL,
  "city" TEXT NOT NULL,
  "limit" INTEGER NOT NULL,
  "status" "CampaignStatus" NOT NULL DEFAULT 'CREATED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "businessName" TEXT,
  "websiteUrl" TEXT,
  "phone" TEXT,
  "email" TEXT,
  "address" TEXT,
  "sourceUrl" TEXT,
  "demoUrl" TEXT,
  "heroImageUrl" TEXT,
  "serviceImageUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
  "doNotContact" BOOLEAN NOT NULL DEFAULT false,
  "emailSentCount" INTEGER NOT NULL DEFAULT 0,
  "callAttempts" INTEGER NOT NULL DEFAULT 0,
  "interested" BOOLEAN NOT NULL DEFAULT false,
  "booked" BOOLEAN NOT NULL DEFAULT false,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "leadId" TEXT,
  "type" "EventType" NOT NULL,
  "metadata" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Lead_campaignId_idx" ON "Lead"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_campaignId_websiteUrl_key" ON "Lead"("campaignId", "websiteUrl");

-- CreateIndex
CREATE INDEX "Event_campaignId_idx" ON "Event"("campaignId");

-- CreateIndex
CREATE INDEX "Event_leadId_idx" ON "Event"("leadId");

-- CreateIndex
CREATE INDEX "Event_type_idx" ON "Event"("type");

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_campaignId_fkey"
FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_campaignId_fkey"
FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_leadId_fkey"
FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
