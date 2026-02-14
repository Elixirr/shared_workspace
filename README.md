# Contractor Outreach Pipeline (Scaffold)

Node.js + TypeScript backend scaffold for an automated outreach pipeline.

## Stack

- Express API
- BullMQ + Redis for jobs
- Postgres + Prisma ORM
- Modular workers for scrape/crawl/generate/deploy/email/call steps

## Project Structure

```text
src/
  api/
    index.ts
    command-handler.ts
  workers/
    scraper.ts
    crawler.ts
    site-generator.ts
    deployer.ts
    emailer.ts
    caller.ts
  db/
    schema.prisma
    client.ts
  queue/
    index.ts
prisma/
  schema.prisma
```

## Prerequisites

- Node.js 20+
- Redis running locally (or set `REDIS_URL`)
- Postgres running locally (or set `DATABASE_URL`)

## Setup

```bash
cp .env.example .env
npm install
npm run prisma:generate
npm run prisma:migrate -- --name init
```

### Optional: AI Copy Personalization

Set these in `.env` to let `site-generator` call an OpenAI-compatible API and produce lead-specific copy from scraped data:

```bash
AI_COPY_ENABLED=true
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-4o-mini
# optional override for OpenAI-compatible providers
OPENAI_BASE_URL=https://api.openai.com/v1
```

If AI is disabled or fails, the worker automatically falls back to deterministic template copy.

## Run API

```bash
npm run dev
```

Server defaults to `http://localhost:3000`.

## Quick Git Save

Commit + push with one command:

```bash
./scripts/save.sh "your commit message"
```

If you omit the message, it auto-generates one with a timestamp:

```bash
./scripts/save.sh
```

## Initial Campaign Command Endpoint

`POST /campaigns`

Payload:

```json
{
  "niche": "roofers",
  "city": "Dallas",
  "limit": 100
}
```

Behavior:

1. Validates payload.
2. Creates a `Campaign` row in Postgres.
3. Queues a `scrape-businesses` BullMQ job with campaign parameters.
4. Returns `202 Accepted` with campaign data.

## Next Build Steps

- Implement scraper to persist leads.
- Add queue chain for crawl -> generate -> deploy -> email -> call.
- Add webhook/event ingestion for email opens and replies.
- Build metrics endpoint for dashboard counters.
