# RF (Moscow) Lead Matching Service

**Status: real matching implemented (2026-09-29, ADR-038).** This is the
independent, RF-only matching contour (AGENTS.md §0,
`docs/MARKET_CONTOURS_AND_SOURCE_ROUTING.md`) — its own process, own port,
own `matching_moscow.*` schema, own AI parser, own deterministic matcher,
own Telegram delivery. It never queries Dubai's `matching_dubai.*` tables
and Dubai never queries this contour's tables (enforced by an automated
isolation test).

The real business logic — fields, location tiers, scoring weights, hard
filters, aliasing, source routing — was ported from `dubai-lead-matching-service`'s
own shipped code (not the historical `AGENTS.md` pilot-v1 spec, see
ADR-037) and adapted to Moscow's own criteria and settings. See ADR-038 in
`docs/DECISIONS.md` for the full design/rationale, including the
deliberate divergences from Dubai (bedrooms sparsity, two-tier location
hierarchy, settings-gated criteria).

## What's real today

- **Own process** — `src/index.js`, its own Fastify app, own port
  (`RF_MATCHER_PORT`, default 8096).
- **Own schema** — `matching_moscow.*` (migrations 0018/0025/0028-0032).
  No Dubai table (`matching_dubai.*`) is ever queried — enforced by an
  automated test (`tests/integration/api.integration.test.js`).
- **Real AI parser** (`src/parser/`) — own prompt/schema/anti-hallucination
  guard, own OpenAI client, own interpretation cache
  (`matching_moscow.message_interpretation_cache`).
- **Real deterministic matcher** (`src/matching/`) — alias resolution,
  candidate query, hard filters, scoring (location/price/rooms/property
  type, weights 50/30/15/5, mirroring Dubai's own shape), `MATCH`/`NO_MATCH`/
  `INSUFFICIENT_CRITERIA` outcomes (no `STRONG_MATCH` tier). Every
  criterion is additionally gated by its own `joker_*_enabled` runtime
  setting (`/settings?market=moscow`) — an operator-disabled criterion is
  never hard-filtered.
- **Real source-routing gate** (`src/gates/source-routing.js`) — only
  `route_mode IN ('RF', 'BOTH')` sources are processed; `AUTO`/`DUBAI`/
  `SAUDI`/`NONE` are rejected. Checked first, before the intake gate.
- **Real persistence** — `matching_moscow.match_runs` (widened
  `result_status` CHECK, migration 0032) + `matching_moscow.match_results`
  (`UNIQUE(source_message_id, stock_joker_object_id)`, upserts on rerun).
- **Real Telegram delivery** (`src/notifications/`) — a separate bot from
  Dubai's own (own token/chat, `RF_TELEGRAM_*` env vars), every successful
  match sent, never "top 3 only."
- **Own repositories, own config, own auth, own tests.** `src/services/
  pipeline.js` (the file the isolation test inspects) never imports from
  `../dubai-lead-matching-service/` directly — reused Dubai code (intake gate,
  config-repository, Telegram sender, render helpers, provider adapters)
  goes through local thin-wrapper files instead; code that was never
  Dubai-specific (`src/core/aliases.js`, `content-dedup.js`, `ai-usage.js`)
  is imported directly from the shared root.
- **Own Dockerfile** — builds and starts independently (`docker build -f
  rf-lead-matching-service/Dockerfile -t nika-rf-lead-matching-service .`
  from the `nika-matching-pilot-starter/` directory, same build-context
  convention as the Dubai service).

## Endpoints

- `GET /health` — `{ contour: "RF", matching_implemented: true, database }`
- `POST /v1/webhooks/telegram`, `POST /v1/webhooks/whatsapp` — accepts the
  same minimal raw envelope shape as the Dubai service (own copy of the
  validation schema, not imported), persists a run, and returns one of:
  - `{ status: "REJECTED", reason: "<route or gate reason>" }` — the
    source isn't routed to RF (`ingest.source_routes.route_mode`), or
    `v2_intake_cutover_enabled = true` and the pattern gate rejects it.
  - `{ status: "NOT_IMPLEMENTED", reason: "RF_MATCHER_DISABLED" }` — the
    seeded default while `v2_intake_cutover_enabled = false`: no gate
    evaluation, no AI call, byte-identical to this service's first
    version.
  - `{ status: "DUPLICATE" }` — the same author+text was seen again within
    the dedup window.
  - `{ status: "PARSER_ERROR" }` — the AI parser call failed after
    retries.
  - `{ status: "INSUFFICIENT_CRITERIA" }` — no location stated, or
    location alone with nothing else (price/rooms/property type) to
    narrow on.
  - `{ status: "NO_MATCH", reason: "<diagnosed reason>" }` — a real
    candidate search against `matching_moscow.stock_inventory` ran and
    nothing survived; the reason is diagnosable (`location_not_found`,
    `rooms_mismatch`, `all_candidates_over_budget`, etc.).
  - `{ status: "MATCH", matches: [...] }` — one or more real surviving
    stock items, ranked by score.

Both require `X-API-Key: <RF_MATCHER_API_KEY>`, same convention as the
Dubai service (independent implementation, see `src/api/auth.js`).

## Not yet wired into live worker traffic

`telegram-worker/.env`'s `TELEGRAM_MONITOR_WEBHOOK_URL` and
`whatsapp-worker/.env`'s `WA_MONITOR_WEBHOOK_URL` still only point at the
Dubai service (port 8095). This service is running and fully functional
(migration 0032 applied, aliases seeded), but no live Telegram/WhatsApp
event reaches it until those two worker `.env` files are updated —
deliberately held back pending explicit go-ahead, since it puts this
service in the path of real production messages.

## Tests

```bash
npm install
npm run test:unit         # pure pipeline logic + matching/parser logic, no DB
npm run test:integration  # real Postgres (disposable container or TEST_DATABASE_URL)
```
