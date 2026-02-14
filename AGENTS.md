# AGENTS.md

## Local Development

- Start infrastructure with Docker Compose: `docker compose up` (Postgres + Redis).
- Run API in dev mode: `pnpm dev`.
- Run workers in dev mode: `pnpm worker`.

## Safety Rules

- Never send real emails or place real calls in development.
- Provider integrations for email/calling must only be enabled when `ENV=production`.

## Lead Status Machine

`NEW -> SCRAPED -> ENRICHED -> SITE_GENERATED -> IMAGES_READY -> DEPLOYED -> EMAILED_1 -> CALLED_1 -> REPLIED -> BOOKED -> DO_NOT_CONTACT`

## Idempotency Rules

- Every worker must be safe to re-run.
- Use database locking and/or unique constraints to prevent duplicate side effects.
- Re-processing the same job must not create duplicate records, duplicate sends, or duplicate calls.

## Concurrency Rules

- Default worker concurrency is `5` jobs per worker.
- Concurrency must be configurable via environment variables.

## Logging Format

- Use this log format for worker messages:
  - `[campaignId][leadId][worker] message`

## Code Style

- TypeScript only.
- `strict` mode enabled.
- No `any`.
- Prefer small pure functions.
- Use clear interfaces and explicit types.
