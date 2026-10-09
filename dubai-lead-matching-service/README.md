# Nika Lead Matching Service

A standalone service that takes a raw Telegram/WhatsApp message and turns it
into a deterministic, persisted stock match — with **no runtime dependency
on n8n**. It exists alongside the current production pipeline (n8n +
`src/core/*.js`), not in place of it; see [Relationship to the current
production pipeline](#relationship-to-the-current-production-pipeline)
below.

```text
Telegram Worker ─┐
WhatsApp Worker ─┼──► raw webhook ──► Lead Matching Service ──► MatchResult
Future Worker ───┘                         │
                                            ├─ Provider Adapter
                                            ├─ Primary Lead Gate (cheap regex pre-filter)
                                            ├─ Deduplication
                                            ├─ AI Classification + Parsing (OpenAI, one call)
                                            ├─ StructuredRequest
                                            ├─ Alias Resolution
                                            ├─ SQL Candidate Retrieval (PostgreSQL)
                                            ├─ Hard Filters (FILTER FIRST)
                                            ├─ Ranking (RANK SECOND — never decides admissibility)
                                            └─ Persistence (matching.match_runs / match_results)
```

## What this is NOT (out of scope for this service, TZ 4/19)

- Telegram/WhatsApp **transport delivery** (sending a notification) — that's
  a future Notification Router, a separate layer.
- Google Sheets Match Log, broker personal routing, Joker sync/routing,
  dashboard UI, channel health UI, QR/session management, Telegram bot
  management. All of that stays exactly where it is today.
- n8n. This service never calls n8n and n8n never calls it (yet — see
  [cutover](#recommended-next-steps)).

## Quick start

```bash
cd lead-matching-service
npm install
cp .env.example .env   # fill in DATABASE_URL and OPENAI_API_KEY
npm run dev             # or: npm start
curl http://127.0.0.1:8095/health
```

## Configuration (`.env`)

| Var | Meaning |
|---|---|
| `MATCHER_HOST` / `MATCHER_PORT` | Bind address. Defaults to `127.0.0.1` — internal service, not meant to be internet-facing directly. |
| `MATCHER_API_KEY` | Shared secret, sent as `X-API-Key`. If blank, the service runs unauthenticated (fine for local dev bound to 127.0.0.1, never for anything reachable beyond localhost). `/health` never requires it. |
| `DATABASE_URL` | Points at the **same** `matching` schema `nika-matching-pilot-starter` already uses. No separate database, no separate stock storage. |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | Used for the single classification+parsing call per message. |
| `MATCH_PRICE_TOLERANCE_PCT` | Ceiling tolerance for the budget hard filter (default 10 — see [Matching algorithm](#matching-algorithm)). |
| `DEDUP_WINDOW_HOURS` | How far back to check for a duplicate (same author + same text) before calling the AI at all. |
| `MATCH_DEBUG` | When `true`, API responses include a `debug` block with the full candidate/score breakdown. Never enable in a shared/production deployment — it's a diagnostic aid, not a data-minimization-safe default. |
| `RUN_OPENAI_LIVE_TESTS` | `false` by default (TZ 86) — unit/regression tests never call the real OpenAI API unless this is explicitly `true`. |
| `TELEGRAM_NOTIFY_QUALIFIED_NO_MATCH` / `TELEGRAM_NOTIFY_NEEDS_CRITERIA` | Both `false` by default — see [Qualified-buyer visibility](#qualified-buyer-visibility-feature-flagged-default-off). |

## API

### `POST /v1/webhooks/messages` (and `/v1/webhooks/telegram`, `/v1/webhooks/whatsapp`)

The main production entry point. Accepts the raw payload a worker sends
(see [Raw contracts](#raw-provider-contracts) below), runs the full
pipeline, and returns the `MatchResult` synchronously (TZ 80: a worker
treats any `2xx` as "accepted/processed" and never needs to inspect the
match result for its own logic).

```bash
curl -X POST http://127.0.0.1:8095/v1/webhooks/telegram \
  -H "Content-Type: application/json" -H "X-API-Key: $MATCHER_API_KEY" \
  -d '{
    "chat_id": "-1001234567890",
    "message_id": "308394",
    "sender_id": "1559760609",
    "sender_name": "Igor",
    "text": "My client is looking for a 2BR in Business Bay, budget up to AED 2.5M.",
    "chat_name": "Dubai Brokers",
    "source_url": "https://t.me/dubai_brokers/308394"
  }'
```

An invalid payload (missing `text`/`chat_id`/`message_id`, or an
unsupported `provider`) returns `400` with a machine-readable
`error.code` **before** anything is persisted or any AI call is made
(TZ 14).

### `POST /v1/match`

Accepts an already-built [`StructuredRequest`](#structuredrequest-schema)
and skips the adapter/gate/dedup/OpenAI stages entirely. This is the entry
point for tests, manual debugging, the dashboard, and a future Joker
integration (TZ 31, 117) — anything that already knows what it wants
matched, without going through a raw chat message first.

```bash
curl -X POST http://127.0.0.1:8095/v1/match \
  -H "Content-Type: application/json" -H "X-API-Key: $MATCHER_API_KEY" \
  -d '{
    "request_id": "manual:1",
    "source": {"provider": "telegram", "original_text": "Need 2BR in Business Bay"},
    "area": "Business Bay",
    "bedrooms_min": 2,
    "bedrooms_max": 2
  }'
```

### `GET /health`

```json
{ "status": "ok", "database": "ok", "openai": "configured", "matcher_version": "lead-matching-service-v1" }
```

Never makes a live OpenAI call — `openai` only reflects whether a key is
configured, not whether it's valid or has quota.

## Raw provider contracts

**Telegram** (`worker_api.py`'s webhook shape, TZ 10):
```json
{"chat_id": "-100...", "message_id": "308394", "sender_id": "...", "sender_name": "...", "sender_username": "...", "text": "...", "posted_at": "...", "chat_name": "...", "source_url": "..."}
```

**WhatsApp** (`whatsapp-worker`'s shape, TZ 11 — including the LID/
`sender_id_alt` convention `whatsapp-worker` already uses for phone
resolution):
```json
{"chat_id": "120363...@g.us", "message_id": "...", "sender_id": "...@lid", "sender_id_alt": "...@s.whatsapp.net", "sender_name": "...", "text": "..."}
```

Both are normalized by their respective adapter (`src/adapters/`) into one
`UnifiedRawMessage` shape (`src/adapters/unified-message-schema.js`).
**`original_text` is carried through completely unmodified** from this
point all the way to persistence and the API response — never trimmed,
translated, summarized, or rewritten (TZ 8, 13, 110).

## Algorithm

### 1. Primary Lead Gate (`src/gates/primary-lead-gate.js`)

A cheap, deterministic pre-filter that runs before the OpenAI call. It
rejects **only** clear off-topic junk (roommate-wanted posts, nail-salon
ads, empty text) — it does **not** try to decide buyer-vs-advertisement or
who the demand belongs to. That decision belongs entirely to the AI
(TZ 15, 19). This is a deliberate fix over the old production gate, whose
weighted "contains `client`/`looking`/`buyer`/`requirements`" rule had no
concept of *direction* — see [Known deviations](#known-deviations-from-the-tz-worth-reading)
below for the real incident this addresses.

### 2. Deduplication (`src/gates/dedup.js`)

`computeContentHash` (reused verbatim from `src/core/content-dedup.js`,
so it hashes identically to whatever the old n8n pipeline already wrote)
hashes `normalize(author) + "::" + normalize(text)`. If a `match_runs` row
with the same hash exists within `DEDUP_WINDOW_HOURS`, the message is
persisted as `DUPLICATE` and never reaches the AI. Because `content_hash`
is the same column the old pipeline writes to, **dedup is shared across
both pipelines** — the same real duplicate posted while both systems are
running side by side is only ever processed once, by whichever one sees it
first.

### 3. AI Classification + Parsing (`src/parser/`)

One OpenAI call (`openai-client.js`, prompt in `prompt.js`) returns both:

- **`message_class`**: `buyer_request | seller_request | inventory_ad | broker_solicitation | general_advertisement | other | unknown`
- **`demand_owner`**: `sender | recipient | unknown` — *whose* requirement this is, independent of which buyer-sounding words appear in the text.
- Extraction fields (`area`, `project`, `building`, `property_type`, `bedrooms_min/max`, `budget_min/max`, `furnishing`, `cash_buyer`, `confidence`) — populated only when `message_class = buyer_request`.

**Matching only ever runs when `message_class = buyer_request AND
demand_owner = sender`** (TZ 26-27). This is the actual fix for the real
"Have a client looking to buy? Send us your client's requirements"
broker-solicitation incident — see below.

A deterministic guard (`src/parser/anti-hallucination.js`) then strips
`area`/`project`/`building` if that exact value doesn't literally appear
anywhere in the source text — a real, observed `gpt-4o-mini` behavior is
filling in a plausible-sounding area for a named project from its own
training data even when explicitly told not to infer it. Never trust the
AI's own claim about what the text says; verify it.

Output is validated/coerced defensively (`src/parser/schema.js`) — the AI's
JSON is untrusted input, same posture as the rest of this pipeline: an
invalid enum or malformed number is dropped to `null`/`'unknown'` with a
warning, never trusted as-is.

### 4. Matching core — **FILTER FIRST, RANK SECOND** (`src/matching/`)

This is the architectural rule the whole module is built around: **score
never decides whether a candidate is admissible.** A candidate either
passes every *active* hard filter or it is excluded before scoring ever
runs. Score (`src/matching/scoring.js`) only orders the survivors.

**Location hierarchy** (`src/matching/location.js`) — use the most
specific level stated, and *only* that level:

```text
Building stated  -> candidate pool = exact building (SQL-level, TZ 40)
else Project     -> candidate pool = exact project_community (TZ 41)
else Area        -> candidate pool = exact area (TZ 42)
else             -> INSUFFICIENT_CRITERIA (location_unspecified)
```

A resolved-but-different building/project/area **structurally cannot**
enter the candidate pool — it's excluded by the SQL `WHERE` clause itself
(`src/matching/candidate-query.js`), not by a score penalty applied after
the fact. This is what makes the "The Edge" regression (see below)
impossible to reintroduce by accident.

**Minimum specificity** (TZ 48-49): automatic matching requires Location +
at least one of budget/bedrooms/property_type. Location alone (`"Business
Bay"`) is `INSUFFICIENT_CRITERIA` — otherwise it would match the entire
area's stock.

**Hard filters** (`src/matching/hard-filters.js`, pure functions, unit
tested independent of any database):

| Filter | Rule | Missing-value behavior |
|---|---|---|
| Transaction type | request `SALE`/`RENT` mapped through `src/matching/transaction-semantics.js` to the real stock vocabulary — see "RENT price semantics" below | inactive (never filters) if request doesn't state one |
| Location | exact building/project/area (or, for area, **any** of several acceptable areas — see "Multi-area" below), per hierarchy above | n/a — always active once Location is provided |
| Property type | exact match after alias resolution | inactive if not stated; **blocks** if stock has no `property_type` on record (unverifiable) |
| Budget | `price <= budget_max × (1 + tolerance)`; `price >= budget_min` **with no tolerance discount on the floor** (TZ 50-51 — a real, deliberate asymmetry, not a bug). `price` is `selling_price` for SALE, `annual_rent` for RENT — never the other field. | inactive if neither bound stated; blocks if stock has no price for the request's transaction type |
| Bedrooms / Bathrooms / Size sqft / Plot size sqft | inclusive range (a single "2BR" sets both ends the same; "3BR+" leaves max open) | inactive if neither bound stated; blocks if stock has no value on record |
| Furnishing | exact match, no partial credit for Semi-Furnished | inactive if not stated; blocks if stock has no `furnishing` on record |

**"Blocks" is a conservative default, not proof of a mismatch.** A hard
filter treats "stock has no value on record" the same as "doesn't satisfy
the request" for admissibility (final principle 3: *missing ≠ confirmed
mismatch, but still unverifiable, so it still can't be confirmed a match*).
`match_diagnostics` (below) is what actually distinguishes the two for
reporting — real live data as of this writing: 93 of 94 ACTIVE stock rows
have no `furnishing` value at all, so a furnishing-specific request's
NO_MATCH is very often a **data gap**, not a genuine mismatch. The filter
itself is never relaxed to compensate — see final principle 9.

### RENT price semantics (P0 fix)

Stock stores a sale listing's price in `selling_price` and a rental's in
`annual_rent` — a `RENT_YEARLY` row's `selling_price` is always `NULL`, and
a `SALE` row's `annual_rent` is always `NULL`. The request schema only ever
produces `transaction_type: 'SALE' | 'RENT' | null` (never `'RENT_YEARLY'`
literally). `src/matching/transaction-semantics.js` is the ONE place that
maps between them:

```text
request 'SALE' -> stock transaction_type IN ('SALE')       -> price field: selling_price
request 'RENT' -> stock transaction_type IN ('RENT_YEARLY') -> price field: annual_rent
```

Both `hard-filters.js` (JS defense-in-depth) and `candidate-query.js` (SQL)
call this SAME module — they can never diverge on what counts as a
compatible transaction or which price column to compare (a real, confirmed
release blocker before this fix: a bare `stock.transaction_type ===
request.transaction_type` check meant every RENT request was rejected
outright, on top of comparing its budget against the always-NULL
`selling_price`). Only `SALE`/`RENT_YEARLY` are supported because those are
the only two values that actually exist in `stock_inventory` — confirmed
live via `SELECT DISTINCT transaction_type FROM matching.stock_inventory`.

### Multi-area (a buyer naming several acceptable areas)

A buyer message often names more than one acceptable area ("Dubai Silicon
Oasis, Warsan, Al Furjan or Bur Dubai"). `StructuredRequest.area` (singular)
stays for backward compatibility; `StructuredRequest.areas` (array) is the
canonical internal representation — a single-area request is just a
one-element array. Each named area is resolved **independently** through
the location dictionary (below), and the areas that DO resolve are OR'd
together at the SQL level (`area = ANY(ARRAY[...])`, safely parameterized)
— every other criterion stays AND'd as normal. An unresolved option is
never silently dropped: it's carried in diagnostics as
`unresolved_location_options`, and if it's the reason nothing could be
checked, `no_match_reason` is `partial_location_resolution_no_match`
(distinct from the plain `no_stock_in_area`, which means every named area
WAS checked and there's genuinely no stock). If every named area is
unresolved, the result is `location_not_found` — checked against all of
them, never just the first. Building/project stay single-value; naming
several specific buildings/projects isn't a pattern this pass handles.

### Location dictionary — alias vs. canonical (`src/matching/location-dictionary.js`)

Reuses `src/core/aliases.js`'s existing engine (`buildAliasIndex`/
`resolveAlias`) verbatim rather than a second parallel resolver. It layers
one more source on top:

1. **`alias`** — an explicit row in `matching.matching_aliases`.
2. **`canonical`** — the raw value already equals a real, distinct value
   seen in `matching.stock_inventory` (`area`/`project_community`/
   `building`), even with zero alias rows for it.

This closes a confirmed gap: `matching_aliases` had (and may still have)
**zero** `type='project'` rows, despite dozens of ACTIVE stock rows having
a real `project_community`. Before this fix, every one of those genuine
project names would resolve as "unrecognized" purely for lack of an alias
row nobody had ever needed to create. The canonical layer never writes
anything back to `matching_aliases` — it's derived read-only from stock at
cache-refresh time (same TTL-bounded cache pattern as the alias index) and
is never treated as proof of synonym coverage, only of "this exact spelling
is real." Both layers together are "does this raw name mean something we
know" — separate from "do we currently HAVE stock there," which is what the
hard-filter/candidate-query layer answers next (final principles 1-2, 7-8).

Neither layer ever fuzzy-matches, and neither ever broadens a specific
project/building to its parent area when unresolved — see "The Edge"
regression below, which this multi-area work doesn't touch or weaken.

**Ranking** (`src/matching/scoring.js`) — only survivors are ever scored.
Each criterion the request didn't state is excluded from the weighted
average entirely (TZ 58-59), not given full or zero credit:

| Component | Weight | Score |
|---|---|---|
| Location | 50 | Building match = 100, Project match = 95, Area match = 80 |
| Budget | 30 | at/under ceiling = 100, 0-5% over = 75, 5-10% over = 50 (>10% already hard-filtered out) |
| Bedrooms | 15 | 100 if active and compatible |
| Property Type | 5 | 100 if active and compatible |

`total = round(Σ(active weight × score) / Σ(active weight))`.

### 5. Candidate retrieval — pushed to SQL (`src/repositories/stock-repository.js`)

The old anti-pattern (`SELECT * FROM stock_inventory WHERE status='ACTIVE'`
— the whole table, every request, filtered in Node) is gone. The location
+ transaction/property/budget/bedrooms filters are pushed into the `WHERE`
clause (`candidate-query.js`). A second, narrower diagnostic query (scoped
to the SAME resolved location, nothing broader) only runs when the first
query returns zero rows, to produce a specific `no_match_reason`
(`transaction_mismatch` / `property_type_mismatch` / `bedrooms_mismatch` /
`over_budget`) instead of a generic "nothing found."

### 6. Persistence (`src/repositories/match-repository.js`)

Reuses the existing `matching.match_runs` / `matching.match_results`
tables (schema `matching`, same database `nika-matching-pilot-starter`
already uses — no new database, no duplicate stock storage). One additive
migration was required: `sql/migrations/0014_lead_matching_service_support.sql`
widens `match_runs.result_status`'s CHECK constraint (this service's
`REJECTED`/`DUPLICATE`/`PARSER_ERROR`/`INSUFFICIENT_CRITERIA` didn't fit
the old `STRONG_MATCH|MATCH|NO_MATCH|ERROR` list) and adds nullable
`provider`/`source_url`/`group_name`/`original_text` columns (the old
pipeline only ever had these inside a JSONB blob; this service needs
`original_text` queryable and guaranteed to survive 1:1 — TZ 68, 110).
Both changes are additive and backward-compatible — the old pipeline's
existing rows and future writes are unaffected.

`UNIQUE(source_message_id, stock_id)` still governs `match_results` —
rerunning the same request `UPSERT`s instead of duplicating (TZ 70).

## Valid buyer vs. match-eligible (final principle 4)

A buyer who names no criteria beyond a location (or no location at all) is
still a genuine buyer — `INSUFFICIENT_CRITERIA` is not the same claim as
"not a buyer" (`REJECTED`). `match_runs` still persists the full parsed
request for an `INSUFFICIENT_CRITERIA` row, and `match_diagnostics.request`
lists exactly what was `provided_fields` vs. `missing_required_fields`
(the same bar as `hasMinimumSpecificity()`: budget/bedrooms/property_type).
`no_match_reason` distinguishes `location_unspecified` (no location named
at all — a real buyer, just under-specified) from `location_not_found` (a
location WAS named, but wasn't recognized) — these must never be conflated
into one generic "insufficient" bucket.

## Match diagnostics (`src/matching/diagnostics.js`, migration `0019`)

An additive, nullable `matching.match_runs.match_diagnostics JSONB` column
— `NULL` forever for legacy `pilot-v1` rows (that writer never populates
it; nothing about it is required for `pilot-v1` to keep working), populated
only for a genuine buyer-path request that reaches the current matcher
(never for `REJECTED`/`DUPLICATE`/`PARSER_ERROR`, and only a lightweight
shape for `INSUFFICIENT_CRITERIA`/`location_not_found`, which never had a
real candidate pool to measure). Shape:

```json
{
  "version": "1",
  "request": { "provided_fields": ["transaction_type", "area", "bedrooms", "budget"], "missing_required_fields": [] },
  "location": { "requested": ["Dubai Silicon Oasis", "Bur Dubai"], "resolved": ["Dubai Silicon Oasis"], "unresolved": ["Bur Dubai"], "partial_resolution": true },
  "stock": { "active": 94, "after_location": 7, "after_transaction": 7, "after_property_type": 5, "after_bedrooms": 3, "after_budget": 1, "after_bathrooms": 1, "after_size": 1, "after_plot_size": 1, "after_furnishing": 0 },
  "missing_stock_data": { "furnishing": { "field": "furnishing", "candidate_rows_before": 1, "missing_value_rows": 1, "explicit_mismatch_rows": 0 } },
  "first_zero_stage": "furnishing",
  "first_data_gap_stage": "furnishing"
}
```

`stock.active` is the citywide ACTIVE count; every `after_*` field is a
**cumulative** count following the fixed order `location → transaction →
property_type → bedrooms → budget → bathrooms → size → plot_size →
furnishing` — computed via **one** aggregate SQL query
(`count(*) FILTER (WHERE ...)` per stage, never N separate `SELECT
count(*)` calls, given real traffic volume). `missing_stock_data` exists
only for fields the request actually stated a requirement for, and
separates "stock has no value on record at all" from "stock has a value
that doesn't satisfy the request" (final principles 3, 7-8) — the hard
filter itself still blocks on either (never relaxed), this is reporting
only. `first_zero_stage` is the first stage where the cumulative count hit
zero; `first_data_gap_stage` is the first stage among those where a real
data gap contributed to it.

Inspect any historical request (including one that predates this column)
with the strictly read-only CLI:

```bash
node scripts/diagnose-request.js --source-message-id=telegram:-100123:308394
node scripts/diagnose-request.js --match-run-id=4821
```

It never calls OpenAI, never inserts/updates `match_runs`/`match_results`,
never sends a Telegram message, and never writes `matching_aliases` or
`stock_inventory` — every DB call is a plain `SELECT`, reusing the exact
same `matchRequest()`/`buildMatchDiagnostics()` functions the live service
uses, never a parallel implementation. Because it re-runs against
**current** live stock rather than replaying the original message, its
outcome can legitimately differ from what was persisted at write-time if
stock changed since — the CLI says so explicitly when that happens.

## Telegram notifications (added after v1, on direct request)

TZ 4/107 scoped Telegram delivery out of core v1 as a separate future
"Notification Router" layer. It has since been added directly into the
pipeline (`src/notifications/render.js` — pure message building,
`src/notifications/telegram-sender.js` — the only place in this service
that calls the Telegram Bot API), reusing the **same bot token and chat**
the old n8n pilot used — brokers see both pipelines' matches in the one
familiar chat, no new channel to watch.

**Off by default** — set all three to enable it:

```env
TELEGRAM_NOTIFICATIONS_ENABLED=true
TELEGRAM_BOT_TOKEN=...      # same token as the old pilot's .env
TELEGRAM_MATCH_CHAT_ID=...  # same chat as the old pilot's .env
```

Fires only on `MATCH`, after persistence already succeeded — a Telegram
outage is logged but never fails the API response or undoes the persisted
match (same posture as AI-usage logging). Format follows TZ 108-116
exactly: `original_text` 1:1 (never rewritten/summarized/translated), a
clickable link to the source message when `source_url` exists (an
explicit "unavailable" line when it doesn't, which is the common case for
WhatsApp), and **every** matched stock item with its score — chunked
across multiple messages without dropping text or matches if the combined
length exceeds `TELEGRAM_MAX_MESSAGE_LENGTH`, every part tagged with the
same `request_id`.

### Qualified-buyer visibility (feature-flagged, default OFF)

Thin stock means a genuine, well-qualified buyer often still resolves to
`NO_MATCH` or `INSUFFICIENT_CRITERIA` rather than `MATCH` — these two flags
make that buyer visible to an operator WITHOUT ever faking `result_status`
or inventing a match (final principle 10: correct diagnosis first, a higher
MATCH count is never the goal):

```env
TELEGRAM_NOTIFY_QUALIFIED_NO_MATCH=false   # NO_MATCH: "🟡 QUALIFIED BUYER — NO CURRENT STOCK"
TELEGRAM_NOTIFY_NEEDS_CRITERIA=false       # INSUFFICIENT_CRITERIA: "🟠 BUYER LEAD — NEEDS MORE CRITERIA"
```

Both default `false` — deploying this code starts **no** new message
stream until an operator explicitly opts in via `.env`. Each fires only for
its own exact outcome (never for `MATCH`/`REJECTED`/`DUPLICATE`/
`PARSER_ERROR`), gated on the SAME confidence bar the MATCH notification
above already requires (`message_class=buyer_request`, `demand_owner=sender`,
`promotion=false`, `spam=false` — guaranteed by construction, since
`runMatchAndPersist` only ever runs after that eligibility check). The
message is a short, human-readable summary (criteria + per-location
resolution status + reason) — the full `match_diagnostics` JSON stays in
the database only (`src/notifications/render.js`'s
`buildQualifiedNoMatchMessage`/`buildNeedsCriteriaMessage`).

## StructuredRequest schema

```json
{
  "schema_version": "1.0",
  "request_id": "telegram:-100123:308394",
  "source": {
    "provider": "telegram",
    "source_url": "https://t.me/example/308394",
    "group_name": "Dubai Brokers",
    "author_name": "Igor",
    "author_contact": "https://t.me/igor",
    "original_text": "My client is looking for a 2BR in Business Bay, budget up to AED 2.5M."
  },
  "transaction_type": "SALE",
  "area": "Business Bay",
  "areas": ["Business Bay"],
  "project": null,
  "building": null,
  "property_type": null,
  "bedrooms_min": 2,
  "bedrooms_max": 2,
  "budget_min": null,
  "budget_max": 2500000,
  "furnishing": null,
  "cash_buyer": null,
  "ai_confidence": 0.94
}
```

`source.original_text` is always the untouched original — the field a
future Notification Router renders 1:1, never the parsed/structured
version (TZ 108-110).

`area` (singular) stays for backward compatibility only; `areas` (array) is
the canonical internal representation the matcher actually reads (see
"Multi-area" above) — a single-area request is a one-element array.

## Tests

```bash
npm run test:unit          # pure functions, no network/DB — always safe
npm run test:integration   # spins up a disposable postgres:16 container, applies migrations, tears down after
npm run test:regression    # the release-blocker scenarios below; live-AI checks skipped unless RUN_OPENAI_LIVE_TESTS=true
npm test                   # all three
```

`RUN_OPENAI_LIVE_TESTS=true npm run test:regression` additionally verifies
the *real* model against the exact incident texts (not just "given a
correct classification, does the pipeline do the right thing" — does the
prompt actually produce that classification).

### Critical regressions covered

| # | Scenario | Expected | Where |
|---|---|---|---|
| TZ 88 | "Have a client looking to buy? Send us your client's requirements... 500+ units... Agents welcome" | `REJECTED` | `tests/regression`, `tests/unit/pipeline.test.js`, `tests/integration/api.integration.test.js` |
| TZ 89 | "My client is looking for..." vs "Do you have a client looking for...?" | classify with different `demand_owner` | `tests/regression` (live-gated) |
| TZ 90/43/96 | "The Edge, 1BR, AED 1.3M" against real stock containing only "340 Riverside Crescent" | `NO_MATCH` / `location_not_found` — Riverside never enters the candidate pool | `tests/unit/matcher.test.js`, `tests/integration/candidate-retrieval.integration.test.js`, `tests/regression` |
| TZ 91 | "Business Bay" alone | `INSUFFICIENT_CRITERIA` | `tests/unit/matcher.test.js`, `tests/integration/api.integration.test.js`, `tests/regression` |
| TZ 93 | Budget tolerance edges: 2.50/2.60/2.75 pass, 2.76 reject (max 2.5M, 10% tolerance) | exact edge behavior | `tests/unit/hard-filters.test.js`, `tests/unit/matcher.test.js` |
| TZ 94 | Bedrooms exactness: 2BR passes, 1BR/3BR reject | no neighboring-count leniency | `tests/unit/hard-filters.test.js`, `tests/unit/matcher.test.js` |
| TZ 95 | A missing criterion is excluded from filtering AND scoring, never defaults to full/zero | `tests/unit/scoring.test.js`, `tests/unit/matcher.test.js` |
| TZ 96 | Wrong area, otherwise-perfect price/bedrooms/type | rejected before scoring | `tests/unit/matcher.test.js`, `tests/regression` |

## Replay tooling (TZ 97)

Run any raw fixture through the exact same pipeline a real webhook uses:

```bash
node scripts/replay-message.js tests/fixtures/telegram-business-bay.json
node scripts/replay-message.js tests/fixtures/telegram-emaar-ad.json --mock   # offline, no OpenAI/DB write cost concern beyond the DB write itself
```

`--mock` swaps in a fixed, always-`unknown` AI response for an offline dry
run of the adapter/gate stages only. Without it, replay uses the real
OpenAI API and **writes a real row to `match_runs`** (same as a real
webhook would) — clean up manually if replaying against a shared database
for debugging.

**This is NOT the same as `scripts/diagnose-request.js`** (see "Match
diagnostics" above) — replay re-runs the FULL pipeline (real OpenAI call,
real DB write) for a brand-new fixture; `diagnose-request.js` is strictly
read-only, diagnoses an EXISTING historical `match_runs` row, and never
calls OpenAI or writes anything.

## Shadow comparison (TZ 98)

Compares the OLD n8n-era matcher (`src/core/*.js`, its own AI prompt)
against this service, for the same raw text, against the same real stock —
entirely read-only (never writes to `match_runs`/`match_results`, never
sends a notification, never touches which pipeline is live):

```bash
node scripts/shadow-compare.js                                    # all bundled tests/fixtures/*.json
node scripts/shadow-compare.js --fixtures=tests/fixtures/telegram-emaar-ad.json
node scripts/shadow-compare.js --historical=20                    # 20 most recent real match_runs rows
```

See the implementation report for a real run's output against production
stock data — it reproduces both release-blocker incidents exactly (the
Emaar ad going from `STRONG_MATCH`/5 matches under the old matcher to
`REJECTED`/0 here; "The Edge" going from a false `MATCH` against "340
Riverside Crescent" to a correct `NO_MATCH`).

## Docker

The Dockerfile needs `src/core`, `src/db`, and `scripts/lib` from the
parent `nika-matching-pilot-starter` project (this service reuses them
directly via `require('../../src/...')`), so the **build context is the
parent directory**, not this one:

```bash
cd nika-matching-pilot-starter
docker build -f lead-matching-service/Dockerfile -t nika-lead-matching-service .
docker run --rm -p 8095:8095 \
  -e MATCHER_HOST=0.0.0.0 \
  -e DATABASE_URL=... -e OPENAI_API_KEY=... -e MATCHER_API_KEY=... \
  nika-lead-matching-service
```

`MATCHER_HOST` **must** be `0.0.0.0` inside the container (the Dockerfile
sets this as the image default) — `127.0.0.1` only accepts connections
from inside the container itself and the health check / port mapping will
silently fail to connect from the host.

Does not start or bundle a PostgreSQL server — `DATABASE_URL` always points
at an existing, already-migrated `matching` schema (TZ 64, 119). Verified
by running this image alongside a real `postgres:16` container on a shared
Docker network end-to-end (`/health`, `/v1/match`, and a real webhook call
with a live OpenAI call from inside the container all confirmed working).

## Relationship to the current production pipeline

This service runs **in parallel** with the existing n8n-based matching
pipeline. Nothing about the current production path changed:

- `telegram-worker` / `whatsapp-worker` still forward to n8n exactly as
  before.
- The existing `NIKA PILOT - Matching` n8n workflow, `Raw Monitor Primary
  Lead Gate`, and all other production nodes are untouched.
- The one database migration applied (`0014_...`) is additive and
  verified not to break the old pipeline's own test suite.
- Workers have not been pointed at this service's `/v1/webhooks/*`
  endpoints — that's a separate, explicit cutover decision (TZ 123-126),
  not part of this implementation.

## Known deviations from the TZ worth reading

- **`project` alias coverage**: `matching.matching_aliases` still has zero
  rows with `type='project'` (only `area`/`building`/`property_type` are
  populated) — but this is no longer a functional gap. The location
  dictionary's canonical layer (see "Location dictionary" above) resolves
  any raw project name that already equals a real `project_community` value
  in stock, without needing an alias row. What's still missing is *synonym*
  coverage (an abbreviation or alternate spelling that ISN'T the literal
  stock spelling) — that still needs a real alias row, and the DB has no
  constraint blocking `type='project'` from being used the moment one is
  needed (confirmed: `matching_aliases.type` is a free-text column, no
  CHECK constraint restricts its values).
- **Transaction type is not SALE-restricted by default.** The old pipeline
  hardcoded `MATCH_ALLOWED_TRANSACTION_TYPES=SALE`; this TZ never states
  that restriction, so a stated `RENT` request is matched against
  `RENT_YEARLY` stock here (see "RENT price semantics" above for exactly
  how that mapping works). If SALE-only was actually intended, it wasn't
  written down anywhere in the 129 sections reviewed — flagging as a
  literal-TZ choice in case it wasn't deliberate.
- **City taxonomy** — deliberately deferred. Stock's `city` column is not
  used by any hard filter; only `area`/`project_community`/`building` are.
  Adding a safe, exact-match `city` filter is possible in a future pass IF
  the parser reliably extracts an explicit city with no larger architecture
  change required — inferring it unreliably (e.g. guessing city from area)
  is explicitly out of scope, and not worth blocking the higher-priority
  fixes in this pass on.
- **Furnishing source-data cleanup** — deliberately NOT done here. 93 of 94
  ACTIVE stock rows have no `furnishing` value on record; this is a
  source/business data gap (the Google Sheet needs the column filled in),
  not something to backfill programmatically or fake. `match_diagnostics`
  makes the affected-request count visible (`missing_stock_data.furnishing`)
  instead.
- **`match_results` cross-matcher ownership** and **notification delivery
  persistence** — both pre-existing, documented gaps (see
  `dashboard/SUMMARY_METRICS.md`'s "Known gaps" section for the full
  writeup) that this pass explicitly did not touch:
  `matching.match_results`' unique key still has no `matcher_version`
  column, and a Telegram send failure (for any of the three notification
  paths, old or new) is still only logged, never persisted anywhere
  queryable.
- **Dashboard Summary** was not rebuilt in this pass (it's a separate,
  already-completed piece of work — see `dashboard/SUMMARY_METRICS.md`) —
  the new `match_diagnostics` column and outcome semantics are additive and
  don't require any Dashboard change to keep working, but a future
  iteration could surface them (e.g. a "data gap vs. genuine no-stock"
  breakdown) if desired.
- **AI area-hallucination is mitigated, not eliminated by prompt wording
  alone.** `gpt-4o-mini` filled in a plausible area for a named project
  from its own training data even after an explicit "never infer this"
  instruction, on more than one prompt revision. The deterministic
  `anti-hallucination.js` guard (verify against the literal source text)
  is the actual fix; the prompt instruction alone was not reliable.
- **The Primary Lead Gate intentionally forwards more to the AI than the
  old regex gate did** (TZ 15/18/91 requires a bare area name like
  "Business Bay" to reach the AI/matcher, not be pre-filtered out) — this
  trades a small amount of AI cost for correctness on that exact
  regression. Cost impact is expected to stay small in practice (see the
  old system's own token-cost analysis in
  `docs/DEVI_CHANNEL_MONITORING_RESEARCH.md` — the free pre-filter's job
  was always "cut obvious junk," not "minimize AI calls to the theoretical
  floor").

## Recommended next steps (not part of this implementation)

1. **Worker cutover** (TZ 124): point `telegram-worker`/`whatsapp-worker`
   at `POST /v1/webhooks/{telegram,whatsapp}` instead of (or in shadow
   alongside) the current n8n webhook, after a longer shadow-comparison
   run against real live traffic than the one bundled here.
2. ~~**Notification Router**~~ — done, inline (see [Telegram
   notifications](#telegram-notifications-added-after-v1-on-direct-request)
   above), not as the fully separate service TZ 107 originally described.
   Still worth extracting into its own process/module later if this
   service's request volume ever makes synchronous Telegram sends inside
   the webhook response path a latency concern.
3. Populate `matching.matching_aliases` with `type='project'` rows once
   there's a real list of named projects worth covering.
4. Per-broker routing (TZ 4 explicitly deferred this) — right now every
   match goes to the one shared chat, same as the old pilot.
