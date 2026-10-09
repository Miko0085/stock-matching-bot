# Abu Dhabi Lead Matching Service

**Status: scaffolded 2026-10-05, built BY ANALOGY with
`dubai-lead-matching-service`.** This is the independent, Abu-Dhabi-only
matching contour (AGENTS.md §0,
`docs/MARKET_CONTOURS_AND_SOURCE_ROUTING.md`) — its own process, own port,
own `matching_abu_dhabi.*` schema, own AI parser, own deterministic
matcher, own Telegram delivery. It never queries Dubai's
`matching_dubai.*` tables or RF's `matching_moscow.*` tables, and neither
of those contours ever queries this one's tables (enforced by an
automated isolation test).

Unlike `rf-lead-matching-service` (which needed genuinely different
fields/semantics — rooms vs bedrooms, rubles vs AED, two-tier location
hierarchy), Abu Dhabi's business semantics are **identical to Dubai's**:
same AED currency, same field model (area/project/building, bedrooms,
bathrooms, size, plot size, furnishing), same 50/30/15/5 ranking weights,
same `FILTER FIRST, RANK SECOND` matcher. So the parser, matching
(`src/matching/*`), and normalization (`structured-request.js`) files are
near-verbatim ports of Dubai's own copied code (only the schema name
differs where SQL is involved), not a redesign — see the relevant ADR in
`docs/DECISIONS.md` for the full build rationale.

## What's real today

- **Own process** — `src/index.js`, its own Fastify app, own port
  (`ABU_DHABI_MATCHER_PORT`, default 8097).
- **Own schema** — `matching_abu_dhabi.*` (migration 0036). No Dubai table
  (`matching_dubai.*`) or RF table (`matching_moscow.*`) is ever
  queried — enforced by an automated test
  (`tests/integration/api.integration.test.js`).
- **Real AI parser** (`src/parser/`) — own prompt/schema/anti-hallucination
  guard (ported verbatim from Dubai, zero schema references), own OpenAI
  client, own interpretation cache
  (`matching_abu_dhabi.message_interpretation_cache`).
- **Real deterministic matcher** (`src/matching/`) — alias/location
  resolution, candidate query, hard filters, scoring (location/price/
  bedrooms/property type, weights 50/30/15/5, identical to Dubai's),
  `MATCH`/`NO_MATCH`/`INSUFFICIENT_CRITERIA` outcomes (no `STRONG_MATCH`
  tier — the active matcher, same rule as Dubai and RF).
- **Real source-routing gate** (`src/gates/source-routing.js`) — only
  `route_mode === 'ABU_DHABI'` sources are processed (deliberately no
  `BOTH`/`AUTO` support yet — `BOTH` is hardcoded to `['DUBAI','RF']` in
  Dubai's `route-resolver.js` and `AUTO` defaults to Dubai, both confirmed
  dead code for a 3rd contour); `DUBAI`/`RF`/`SAUDI`/`NONE` are rejected.
  Checked first, before the intake gate.
- **Real persistence** — `matching_abu_dhabi.match_runs` +
  `matching_abu_dhabi.match_results` (`UNIQUE(source_message_id,
  stock_id)`, upserts on rerun).
- **Real Telegram delivery** (`src/notifications/`) — a separate bot from
  Dubai's and RF's own (own token/chat, `ABU_DHABI_TELEGRAM_*` env vars),
  every successful match sent, never "top 3 only." Reuses Dubai's
  `formatMatchEntry`/`render.js` as a direct 1-line re-export (no custom
  formatting needed — Abu Dhabi's stock rows have the exact same field
  names Dubai's do).
- **Own Draft→Apply settings** (`src/repositories/config-repository.js`) —
  a thin schema-parameterized binding to Dubai's own config-repository
  code (`schema: 'matching_abu_dhabi'`), not a second implementation —
  same pattern RF's own config-repository.js already uses.
- **Own repositories, own config, own auth, own tests.** `src/services/
  pipeline.js` (the file the isolation test inspects) never imports from
  `../dubai-lead-matching-service/` or `../rf-lead-matching-service/`
  directly — reused code (intake gate, config-repository, Telegram
  sender, render helpers, provider adapters) goes through local
  thin-wrapper files instead; code that was never Dubai-specific
  (`src/core/aliases.js`, `content-dedup.js`) is imported directly from
  the shared root.
- **Own Dockerfile** — builds and starts independently (`docker build -f
  abu-dhabi-lead-matching-service/Dockerfile -t
  nika-abu-dhabi-lead-matching-service .` from the repo root, same
  build-context convention as the Dubai/RF services).

## Endpoints

- `GET /health` — `{ contour: "ABU_DHABI", database }`
- `POST /v1/webhooks/telegram`, `POST /v1/webhooks/whatsapp` — accepts the
  same minimal raw envelope shape as the Dubai/RF services, persists a
  run, and returns one of:
  - `{ status: "REJECTED", reason: "<route or gate reason>" }` — the
    source isn't routed to Abu Dhabi (`ingest.source_routes.route_mode`),
    or `v2_intake_cutover_enabled = true` and the pattern gate rejects it.
  - `{ status: "NOT_IMPLEMENTED", reason: "ABU_DHABI_MATCHER_DISABLED" }`
    — the seeded default while `v2_intake_cutover_enabled = false`: no
    gate evaluation, no AI call.
  - `{ status: "DUPLICATE" }` — the same author+text was seen again within
    the dedup window.
  - `{ status: "PARSER_ERROR" }` — the AI parser call failed after
    retries.
  - `{ status: "INSUFFICIENT_CRITERIA" }` — no location stated, or
    location alone with nothing else (price/bedrooms/property type) to
    narrow on.
  - `{ status: "NO_MATCH", reason: "<diagnosed reason>" }` — a real
    candidate search against `matching_abu_dhabi.stock_inventory` ran and
    nothing survived; the reason is diagnosable (`location_not_found`,
    `bedrooms_mismatch`, `over_budget`, etc. — see AGENTS.md §7).
  - `{ status: "MATCH", matches: [...] }` — one or more real surviving
    stock items, ranked by score.

Both require `X-API-Key: <ABU_DHABI_MATCHER_API_KEY>`, same convention as
the Dubai/RF services (independent implementation, see `src/api/auth.js`).

## Stock source

Stock/aliases are synced from a dedicated Google Sheet (same mechanism
Dubai itself originally used), never Joker CRM. See
`scripts/abu-dhabi-sheet-stock-sync-run.js` (Phase 3 of the build) for the
sync script and `.env.example` for the required
`ABU_DHABI_GOOGLE_SHEETS_*` variables.

## Not yet wired into live worker traffic

`telegram-worker/.env`'s `TELEGRAM_MONITOR_WEBHOOK_URL` and
`whatsapp-worker/.env`'s `WA_MONITOR_WEBHOOK_URL` still only point at the
Dubai service. This service only receives traffic for sources an operator
explicitly assigns `route_mode = 'ABU_DHABI'` via the dashboard's
`/sources` page.

## Tests

```bash
npm install
npm run test:unit         # pure pipeline logic + matching/parser logic, no DB
npm run test:integration  # real Postgres (disposable container or TEST_DATABASE_URL)
```
