# NIKA Matching / Monitoring Architecture Audit

**Date:** 2026-09-17
**Scope:** Full technical audit of the current Monitoring System and Matching Engine, ahead of extracting the Matching Engine into an independent module.
**Method:** Read-only. No code, schema, workflow, or config was changed as part of this audit — only reading source files, live (read-only) n8n API calls to inspect the production workflow's real node graph/code, read-only SQL queries against the real database, and running the existing test suite without modifying it.
**Status of findings:** Everything under **CURRENT STATE** headings is verified fact from code/data as of this date. Everything under **RECOMMENDED FUTURE BOUNDARY** headings (§24–26 and the closing snapshot's "TARGET BOUNDARY") is a proposal only — nothing there has been implemented.

---

## 1. Executive Summary

The repository is a single monorepo (`D:\VS code\AI broker assistant`), one git root — but **`nika-matching-pilot-starter/` (the entire Matching Engine + dashboard) is completely untracked** (`git status` → `??`, `git ls-files` → 0 files). This is not incidental — it is a real operational risk in its own right (see §28).

Monitoring (Telegram/WhatsApp) lives inside a single production n8n workflow (`WhatsApp Debug Queue - 4 LIDs v2`, id `CywaVjmIxJmCmsAf`, 60+ nodes) together with two parallel filtering/notification "lanes." The Matching Engine is a separate set of pure JS modules (`src/core/*.js`) that get wrapped into n8n Code nodes via a custom bundler and deployed as a separate workflow (`NIKA PILOT - Matching`). The database is one PostgreSQL instance, schema `matching`, plus read-only access to the production `public.devi_messages` table.

Key conclusion for the module-extraction task: **the scoring/gating core is already pure functions with no n8n dependency** — good news. But: (a) a large layer of schema + code (broker routing, notification delivery, Joker sync, channel health) exists in the database and in `src/core/`, but **is not wired into the live pipeline** — a real coupling/confusion risk; (b) the only entry point into the matcher today is an HTTP webhook inside n8n; there is no standalone service.

---

## 2. Current Technology Stack

| Component | Technology | Location | Status |
|---|---|---|---|
| Telegram monitoring worker | **Python** — FastAPI + uvicorn + Telethon (persistent per-account clients, `NewMessage` listener) | `telegram-worker/` (monorepo root) | Production |
| WhatsApp monitoring worker | **Node.js** — Express + `@whiskeysockets/baileys` (rc14) | `whatsapp-worker/` (monorepo root) | Production |
| Orchestration / filtering, envelope, dedup, forwarding business logic | **n8n** (self-hosted, `n8n.nikaestate.ae`) | production workflow `CywaVjmIxJmCmsAf` | Production |
| Matching Engine (core) | **Node.js**, plain CommonJS, zero web framework | `nika-matching-pilot-starter/src/core/*.js` | Production logic, but not a standalone service — code is packaged into n8n Code nodes |
| Matching Engine (packaging/deploy) | Node.js CLI scripts, direct `fetch` to the n8n REST API | `nika-matching-pilot-starter/scripts/*.js` | Production tooling |
| Database | **PostgreSQL 16**, schema `matching` (+ read-only `public.devi_messages`) | remote Postgres (prod), plus a disposable `postgres:16` in Docker for integration tests | Production + test |
| Dashboard | Node.js, **plain `http` module**, no Express/React — server-rendered HTML strings | `nika-matching-pilot-starter/dashboard/` | Production (internal) |
| AI / LLM | OpenAI Chat Completions API, `gpt-4o-mini` (actually returns the snapshot `gpt-4o-mini-2024-07-18`) | called directly from an HTTP node inside `NIKA PILOT - Matching` | Production |
| Joker CRM integration | Node.js HTTP client to `moscow.nikaestate.ru/api` | `dashboard/joker-client.js` | **Dashboard only**, not runtime matching |
| A separate, NOT monitoring/matching-related service | Python FastAPI, `app/ai-qualifier` — AI lead qualifier (Retell/voice, OpenAI Agents SDK, its own database) | `app/ai-qualifier/` | Production, but **out of scope** for this audit — a different product in the same monorepo |
| Docker | `docker-compose.yml` at the monorepo root — only `telegram-worker`, `whatsapp-worker`, `ai-qualifier` (+ postgres, cloudflared tunnels) | root | `nika-matching-pilot-starter` **is not described in docker-compose at all** — n8n and its Postgres are externally managed services, not in this compose file |

---

## 3. Relevant Repository Structure

```
D:\VS code\AI broker assistant\                 ← git root (single)
├── telegram-worker/          ← Python/FastAPI/Telethon monitoring
├── whatsapp-worker/          ← Node/Express/Baileys monitoring
├── app/ai-qualifier/         ← A DIFFERENT product (out of scope)
├── docker-compose.yml        ← workers + ai-qualifier, WITHOUT the matching pilot
└── nika-matching-pilot-starter/   ← Matching Engine + dashboard (UNTRACKED in git!)
    ├── AGENTS.md              ← primary agent contract, "do not break production"
    ├── package.json           ← deps: only dotenv, pg
    ├── src/
    │   ├── core/              ← PURE matching functions (see §12)
    │   └── db/                ← Repository classes — used ONLY by integration tests, not runtime
    ├── scripts/
    │   ├── templates/matching-workflow.js   ← n8n JSON generator for matching
    │   ├── templates/stock-sync-workflow.js ← n8n JSON generator for stock sync (Google Sheets only)
    │   ├── lib/bundle-code-node.js          ← "compiler" from src/core to n8n Code node text
    │   ├── n8n-deploy.js / n8n-plan.js      ← deploy via n8n REST API
    │   └── run-integration-tests.js         ← disposable Postgres in Docker for tests
    ├── sql/migrations/        ← 14 migrations, see §11
    ├── n8n/workflows/*.json   ← generated output (an artifact, not the source of truth)
    ├── dashboard/             ← plain http server, read+write UI
    └── tests/{unit,contracts,integration}/
```

---

## 4. Monitoring Sources

| Source | Entry point | File/Node | Transport | Payload | Feeds into |
|---|---|---|---|---|---|
| **Telegram** | n8n webhook `telegram-monitor` | production workflow, trigger node `telegram-monitor` | HTTP POST from `telegram-worker` (Telethon listener → forward) | `{event:"message.new", provider:"telegram", chat_id, message_id, sender_name, sender_username, text, posted_at, ...}` | `Raw Telegram -> DEVI Envelope` |
| **WhatsApp** | n8n webhook `whatsapp-monitor` | production workflow, trigger node `whatsapp-monitor` | HTTP POST from `whatsapp-worker` (Baileys listener → forward) | similar shape + `sender_id_alt`/`remoteJidAlt` for LID resolution | `Raw WhatsApp -> DEVI Envelope` |
| **DEVI Webhook** (external/third-party trigger) | separate node `DEVI Webhook` | same production workflow | HTTP POST | `{type:"leads.new", items:[...]}` — a shape identical to Devi's own internal lead model | `Universal Filter + Normalize` (Lane B, see §5) |
| Other | — | not found | — | — | Facebook/LinkedIn/Reddit etc. are **absent** — only Telegram + WhatsApp |

---

## 5. Actual Monitoring Data Flow

Reconstructed by tracing the real connection graph of the production workflow (`n8n-client.js` → `getWorkflow` → `connections`), not from documentation.

**Finding: two independent, non-overlapping "lanes" grow out of the same triggers.**

### Lane A — the only path that actually feeds the Matching Engine

```
telegram-monitor / whatsapp-monitor (webhook)
        ↓
Raw Telegram/WhatsApp -> DEVI Envelope   (pure shape normalization, no filtering)
        ↓
Raw Monitor Primary Lead Gate            (regex/keyword pre-filter — see §6)
        ↓
Explode Raw Leads for Matching Pilot     (filters on lead.rawFilterV2.passed, reshapes into the webhook payload)
        ↓
HTTP Request - NIKA Matching Pilot       (POST to the pilot's webhook)
        ↓
=== nika-matching-pilot-starter, workflow "NIKA PILOT - Matching" ===
        ↓
Compute Content Hash → PostgreSQL Check Duplicate → IF Is Duplicate (dedup by author+text, 48h)
        ↓ (if not a duplicate)
HTTP Request - AI Structured Parser (OpenAI)
        ↓
Validate Parser Result (JSON validation + AI-usage telemetry)
        ↓
PostgreSQL Fetch Enabled Aliases → PostgreSQL Fetch Active Sale Stock → PostgreSQL Latest Successful Sync
        ↓
Deterministic Match (§12)
        ↓
PostgreSQL Insert Match Run
        ↓
IF Has Successful Matches
   ├─ TRUE → Expand Successful Matches → PostgreSQL Upsert Match Results + Google Sheets Append Match Log
   │         → Build Telegram Messages → Send Telegram Messages (one shared chat)
   └─ FALSE → (dead end, nothing is sent — NO_MATCH stays Postgres-only)
```

### Lane B — parallel, does NOT feed the Matching Engine

```
DEVI Webhook
        ↓
Universal Filter + Normalize (its own 2-area location filter, author filter, dedup logic, its own copy of classifyIntentV2)
        ↓
Postgres - Save + Dedupe → Keep Only Accepted New Leads
        ↓
Build Telegram Notification → Send Lead to Telegram (a different chat/bot)
        + Prepare Google Sheets Row → Append or update row in sheet
        + external forwarding (Resolve Telegram Sender → Forward Telegram/WhatsApp Lead - External, with randomized delay)
```
There is also a near-complete "Secondary" copy of almost this entire chain (Primary+Secondary node variants) — the exact purpose of the second set could not be established from the code alone (plausibly a second Devi account/tenant); it is not related to matching.

---

## 6. Primary Lead Filter

**File (live, production):** node `Raw Monitor Primary Lead Gate` inside workflow `CywaVjmIxJmCmsAf` (fetched via the n8n API, not from this repo — this node does not exist in git at all, it only lives inside n8n). Function: `classifyIntentV2` — **exists and is active**.

Decision-order pseudocode (verified line-by-line against the real code):

```
normalize(text) → language detect (ru/en/mixed/unsupported)
if empty or unsupported language → rejected

positiveSignals = weighted match against BUYER_SIGNALS
  (explicit_buyer_demand:5, options_request:4, client_context:3,
   property_type:2, budget:2, property_criteria:1, urgency_or_finance:1)
negativeSignals = SELLER_SIGNALS (seller_offer:-6, seller_call_to_action:-3)
                + AD_SIGNALS (advertisement:-5)
listingMarkerCount = number of matches against LISTING_MARKERS (BUA:, plot:, price:, etc.)

if lookingForBuyer (a "looking for a buyer" pattern) → rejected
if nonPropertyRequest (roommate wanted, nail salon, etc.) → rejected
if hardAdvertisement (hard advertisement patterns) → rejected
if hardSeller AND NOT clearRequest → rejected
if catalogLikeOffer (type+money+listing markers, no explicit request) → rejected
if structuredListingMarkerCount>=2 AND NOT hasDemand → rejected
if hasAdvertisement AND NOT hasDemand → rejected
if (listingMarkerCount>=4 OR hasSellerOffer) AND NOT hasDemand → rejected

if hasDemand AND positiveScore>=5 → ACCEPTED (buyer_request / broker_client_request)
   ↑ this branch is checked BEFORE the "hasAdvertisement && !hasDemand" check —
     once hasDemand==true, advertisement/seller signals can no longer reject it

else if reviewableCriteria (type+budget+score>=4+no seller/ad+short text) → accepted_review
else → rejected (irrelevant_content)
```

Separately (legacy, for backward compatibility/observation) — an exact keyword match against `RAW_INCLUDE_ANY`/`RAW_EXCLUDE_ANY` (a word list that is verbatim identical to the "Keywords to Monitor" settings of the Devi product, typo included: `urget buyer`).

**Known weakness (found via a live test, not hypothetical):** the `hasDemand && positiveScore>=5` decision rule is checked before the advertisement check — the phrase "Have a client looking to buy" in an ad that is actually soliciting *other people's* clients triggers `client_context`/`explicit_buyer_demand` exactly the same way a genuine "I have a client" request does. The regex cannot distinguish the direction of the ask. Verified by running the real advertisement text through this exact function live — result: `decision: "accepted"`.

---

## 7. AI Usage

The only place an LLM is used anywhere in the pipeline — one OpenAI call per non-duplicate request (node `HTTP Request - AI Structured Parser`, `scripts/templates/matching-workflow.js`).

| | |
|---|---|
| Purpose | Buyer-intent classification **and** structured parsing — **in the same call** |
| Model | `gpt-4o-mini` (env `OPENAI_MODEL`), actually returns the snapshot `gpt-4o-mini-2024-07-18` |
| Prompt location | Inline in `scripts/templates/matching-workflow.js` (hardcoded into the generator, not DB-editable, requires a redeploy to change) |
| Input | Only `original_text` (the raw message text) |
| Output schema | `{buying_intent, seeking_info, promotion, spam, transaction_type, area, building, bedrooms, property_type, budget_min, budget_max, furnishing, cash_buyer, confidence}` — `response_format: json_object` |
| Temperature/settings | Not set explicitly → OpenAI defaults apply |
| AI for matching | **Not used.** The Matching Engine is 100% deterministic code; the AI never participates in the match/no-match decision (see §12). |

Tokens/cost are logged separately into `matching.ai_usage_log` (node `PostgreSQL - Log AI Usage`, a parallel branch with `onError: continueRegularOutput` — cannot block the main flow).

---

## 8. Current Structured Request Schema

The actual schema from `src/core/request-schema.js` (`validateParsedRequest`) — what really comes out after AI + validation:

| Field | Type | Nullable | Source | Used downstream for |
|---|---|---|---|---|
| `buying_intent` | boolean | no (default `true`) | AI | hard-gate blocking |
| `seeking_info` | boolean | no (default `false`) | AI | hard-gate blocking |
| `promotion` | boolean | no (default `false`) | AI | hard-gate blocking |
| `spam` | boolean | no (default `false`) | AI | hard-gate blocking |
| `transaction_type` | `'SALE'\|'RENT'\|null` | yes | AI (enum coerce) | hard gate (only SALE allowed by config) |
| `area` | string\|null | yes | AI | alias resolution, candidate filter, location score |
| `building` | string\|null | yes | AI | alias resolution, location score (NOT a candidate filter, see §14) |
| `bedrooms` | number\|null | yes | AI (normalized, "studio"→0) | hard gate + score |
| `property_type` | string\|null | yes | AI | alias resolution, hard gate + score |
| `budget_min` / `budget_max` | number\|null | yes | AI | hard gate (both bounds) + score, NOT part of "hasAnyCriteria" |
| `furnishing` | enum\|null | yes | AI | score only |
| `cash_buyer` | boolean\|null | yes | AI | not used by the matcher at all (persisted only) |
| `confidence` | 0..1\|null | yes | AI | not used by the matcher at all |

Plus fields that come NOT from the AI but from the webhook payload directly (envelope stage): `source_message_id`, `provider`, `source_url`, `group_name`, `author_name`, `author_contact`, `sender_id`.

`hasAnyCriteria` (the "is there enough specificity" gate) = `area || building || bedrooms !== null` — **budget and property_type are deliberately excluded** (after two real incidents this week).

---

## 9. Normalization / Aliases

| What is normalized | Function | Where the reference data lives |
|---|---|---|
| Basic text normalization (case/whitespace/punctuation) | `normalizeAliasKey`/`normalizeText` (`src/core/normalize.js`) | Not DB-backed — pure code, always applied |
| area, building, property_type | `resolveAlias()` (`src/core/aliases.js`) — exact lookup after normalization | `matching.matching_aliases` (type=area/building/property_type), synced from Google Sheets |
| bedrooms | `normalizeBedrooms()` — "studio"→0, regex number extraction | code, no reference table |
| budget | `coerceNumber()` — strips commas/spaces | code |
| transaction_type, furnishing | `coerceEnum()` — exact match against an allowed list | hardcoded list in `request-schema.js` |
| Unknown value | Left as-is (`resolved: false`), comparison proceeds on the raw normalized value | — |
| Fuzzy matching | **Completely absent** — everywhere it's exact match after normalization only | — |

**Discovered asymmetry (fact, not a recommendation):** alias resolution is applied only to the REQUEST side (`matcher.js:10`). Stock, at sync time (`sync-normalize.js`), is stored as-is, never run through `resolveAlias`. This currently causes no visible problems because the real stock data already matches the reference table's canonical values (verified via a live DB query).

---

## 10. Stock Runtime Architecture

**The only runtime source of stock is PostgreSQL `matching.stock_inventory`.** Google Sheets is never read in real time during matching (a direct requirement from `AGENTS.md`, confirmed by code — `matcher.js` only fetches stock via a SQL query).

The sync workflow (`NIKA PILOT - Stock Sync`, `scripts/templates/stock-sync-workflow.js`) reads **only Google Sheets** (two tabs: Stock Inventory, Aliases) — **Joker CRM plays no role in stock sync at all**, despite an existing Joker API client (see §16).

---

## 11. PostgreSQL Current State

Schema `matching` (verified via a live `information_schema` query against the real database).

### EXISTS NOW — tables

| Table | Purpose | PK | Important columns | Used at runtime? |
|---|---|---|---|---|
| `stock_inventory` | property stock | `stock_id` (TEXT) | status, transaction_type, area, building, bedrooms, property_type, selling_price, broker/broker_contact, **broker_id/listing_owner_broker_id/responsible_broker_id** (0009), stock_source | YES (read) |
| `matching_aliases` | alias reference table | `id` | type, alias, canonical, parent_area, enabled | YES |
| `stock_sync_runs` | stock sync log | `id` | status, rows_read/active | YES |
| `match_runs` | one row per matching attempt | `id` | result_status, parsed_request(jsonb), normalized_request(jsonb), no_match_reason, content_hash, requester_contact_url/sender_id/name | YES |
| `match_results` | one row per successful Request↔Stock match, UNIQUE(source_message_id, stock_id) | `id` | match_score, match_status, score_breakdown(jsonb), telegram_post/whatsapp_post, **broker_id/routing_status** (0009, default PENDING) | YES (write), **broker_id/routing_status are never populated** |
| `ai_usage_log` | tokens/$ per AI call | `id` | model, prompt/completion/total_tokens, estimated_cost_usd | YES |
| `brokers` | canonical broker identity | `id` | name, phone, email | Dashboard UI only |
| `broker_external_identities` | brokers↔Joker link | `id` | source, external_agent_id | Dashboard UI only |
| `telegram_bots` | notification bots | `id` | bot_username, is_default | Dashboard UI only |
| `broker_telegram_accounts` | broker↔Telegram link | `id` | connection_token, is_verified | Dashboard UI only |
| `broker_notification_routes` | notification routing rules | `id` | channel, min_score | **Used NOWHERE** (0 references outside the SQL file) |
| `notification_deliveries` | per-broker delivery log | `id`, UNIQUE idempotency_key | status, matches_count | **Used NOWHERE** |
| `joker_sync_runs` | Joker sync log | `id` | objects_received, stock_inserted | **Used NOWHERE** — a Joker sync has never run |
| `channel_health_checks` | worker health snapshots | `id` | process_status, session_status, last_heartbeat_at | **Used NOWHERE** — the dashboard computes health on the fly, never writes here |

### PLANNED ONLY (not in the database, not in code — docs only)
`CHANNEL_MONITORING_AND_CONTROL.md` is referenced in code comments, but **the file does not exist** under `docs/`.

Plus read-only access to the external `public.devi_messages` (owned by production monitoring; this role has SELECT only).

Views: `v_dashboard_summary`, `v_stock_match_counts`, `v_request_matches`, `v_match_history`, `v_match_history_with_source` (conditional, if `devi_messages` exists) — all `CREATE OR REPLACE`, used by the dashboard.

---

## 12. Current Matching Engine

**Path:** `nika-matching-pilot-starter/src/core/matcher.js` (+ `scoring.js`, `no-match-reason.js`, `aliases.js`, `normalize.js`).

**Main function:** `matchRequest({ parsedRequest, parserWarnings, aliasIndex, stockCandidates, config, stockSyncedAt, now })` → `{ normalizedRequest, scored, successfulMatches, resultStatus, noMatchReason, bestScore, matchesCount, ... }`.

**Candidate retrieval:** SQL `SELECT * FROM matching.stock_inventory WHERE status='ACTIVE' AND transaction_type = ANY($1)` (an n8n Postgres node, `sql-snippets.js`) — the entire active stock of allowed transaction types is loaded into node memory on every single request (no pagination/limit).

**Candidate pre-filter (`filterViableCandidates`):** filters **only by `area`** — if area is not stated, the entire loaded stock is returned unfiltered. `building` plays no role in the pre-filter at all (only in scoring).

**Hard gates** (force NO_MATCH regardless of the total score):
1. `transactionTypeMismatch` — request outside `MATCH_ALLOWED_TRANSACTION_TYPES`
2. `priceOutOfRange` (`isBudgetWithinTolerance`) — both budget bounds, ±10% (`MATCH_PRICE_TOLERANCE_PCT`)
3. `bedroomsOutOfRange` (`isBedroomsAcceptable`) — exact match, no tolerance
4. `propertyTypeOutOfRange` (`isPropertyTypeAcceptable`) — exact match after alias resolution
5. Classification gates (`notBuyingIntent`/`isSeekingInfo`/`isPromotion`/`isSpam`/`missingParserFields`/`staleStock`) — block the entire result (`blocked` in `matcher.js`)

**Scoring** (`scoring.js`, weights from `.env`, defaults shown):

| Criterion | Weight | Missing-field behavior | Mismatch behavior |
|---|---|---|---|
| Location | 30 | not stated → full score | no match → 0 (60% partial credit if area matches but building doesn't) |
| Bedrooms | 25 | not stated in request → full score; unknown on stock → 0 | hard gate, not just a 0 score |
| Property Type | 15 | not stated in request → full score; unknown on stock → 0 | hard gate |
| Budget | 20 (graduated bands: within=20, over0-5%=12, over5-10%=5, over10%=0) | not stated → full score; no stock price → 0 | hard gate (±10%) on top of the graduated score |
| Furnishing | 10 | not stated (either side) → full score | no match → 0 |

**Threshold:** `matchMinScore=70` (MATCH), `matchStrongScore=85` (STRONG_MATCH), max 100.

**Output:** `successfulMatches` — the array of ALL passing candidates (never truncated to Top-N), sorted by descending score.

**Persistence:** not the responsibility of matcher.js itself — a separate n8n Postgres node writes the result afterward.

---

## 13. Current Persistence

- `Insert Match Run` — one row per request (including NO_MATCH), no UPSERT, a plain `INSERT ... RETURNING id`.
- `Upsert Match Results` — one row per successful match, `ON CONFLICT (source_message_id, stock_id) DO UPDATE` (that pair is the unique key) — rerunning the same request **updates**, does not duplicate.
- NO_MATCH is stored **only** as `match_runs.result_status='NO_MATCH'` + `no_match_reason`; no `match_results` row is ever created for it.
- Rerun: the same `source_message_id` → a new `match_runs.id` every time (no UPSERT at the run level), but the `match_results` UNIQUE constraint prevents duplicates for a specific request↔stock pair.

---

## 14. Current Notifications

- The only recipient is **one shared Telegram chat** (`config.telegramMatchChatId`, a single environment variable). Personal/per-broker chats are **not used at runtime**, even though the full infrastructure for it (`broker_telegram_accounts`, `broker-notifications.js`, `notification-grouping.js`) is implemented and test-covered.
- **All** successful matches are sent — no Top-N and no message-length truncation: one message per match (`buildTelegramMessages` builds N separate messages, never batches).
- Chunking (`buildBrokerNotificationMessages` with "Part i/N" splitting) is implemented in `broker-notifications.js`, but this function **is never called by the runtime pipeline** — used only in tests and potentially by the dashboard (dashboard usage was not confirmed by a direct grep hit).
- WhatsApp as a notification channel — see §18.

---

## 15. Broker / Responsible User State

`stock_inventory` **already has** `broker_id`, `listing_owner_broker_id`, `responsible_broker_id` (migration 0009, applied to the real database). The stock's owner is technically determinable.

But: the actual stock sync (Google Sheets → `stock_inventory`) **does not populate** these fields — `sync-normalize.js` never sets them (would need a separate check, but given a Joker sync has never run and the Google Sheets export doesn't carry these IDs, these fields are almost certainly `NULL` everywhere in the current data). This is **not enough** for personal routing right now — the schema is ready, the data is not, and the matching pipeline itself never reads these fields anyway (the routing logic is not wired in, see §12/§14).

---

## 16. Joker CRM State

**Exists, partially.**

| File | Purpose |
|---|---|
| `dashboard/joker-client.js` | HTTP client to `moscow.nikaestate.ru/api` — `listJokerAgents()`, `listJokerObjectsPage()` (with correct pagination via a JSON-encoded `params=` query string, documented in `docs/JOKER_API_DISCOVERY.md`) |
| `dashboard/broker-admin-queries.js` | writes `broker_external_identities` (source='JOKER') on manual mapping via the `/brokers` UI |
| `.env` | `JOKER_API_TOKEN` — configured |
| Sync workflow | **Does not exist.** `matching.joker_sync_runs` — the table exists, but has never had a row. |
| Mapping UI | Exists — the `/brokers` dashboard page — a list of live Joker agents + manual linking to a broker |

Bottom line: Joker is used **only** to read the agent list for the dashboard's manual broker-mapping UI. There is no sync of objects/stock from Joker into `stock_inventory` at all.

---

## 17. Dashboard State

Backend: `nika-matching-pilot-starter/dashboard/server.js` (plain Node `http`, no framework). Frontend: none separate — HTML is rendered server-side as strings (`dashboard/render.js`).

| Page | DB/API sources | Status |
|---|---|---|
| `/` (Summary) | `matching.v_dashboard_summary` | Implemented |
| `/stock`, `/stock/:id` | `v_stock_match_counts`, `match_results` | Implemented |
| `/requests` | `v_request_matches` | Implemented |
| `/history` | `v_match_history` (with filters) | Implemented |
| `/ai-usage` | `ai_usage_log` (KPIs + day/week/month chart) | Implemented |
| `/channels` | `telegram-worker`/`whatsapp-worker` HTTP `/health`/`/accounts` directly (not via `channel_health_checks`) | Implemented — health, QR, reconnect, clear-session |
| `/brokers`, `/brokers/:id` | `brokers`, `broker_external_identities`, `broker_telegram_accounts`, live Joker agents | Implemented (mapping UI) |
| `/telegram-bots` | `telegram_bots` | Implemented |
| Auth | HTTP Basic, optional (`DASHBOARD_USERNAME/PASSWORD` — **currently MISSING in .env**, i.e. the dashboard runs unauthenticated) | Partial/risk |

---

## 18. Worker / Channel Health State

| | Telegram worker | WhatsApp worker |
|---|---|---|
| Name | `telegram-worker` | `whatsapp-worker` |
| Tech | Python, FastAPI+Telethon | Node.js, Express+Baileys |
| Container | Docker (`docker-compose.yml`, port 8091) | Docker (port 8092) |
| Session | Telethon `.session` files (multi-account) | Baileys auth-state files under `sessions/<account_id>` |
| Health | `GET /health` (no auth) | `GET /health` (no auth) |
| Heartbeat | No separate heartbeat mechanism found in the code reviewed | Same |
| Restart | Docker `restart: unless-stopped` | Docker `restart: unless-stopped` |
| Reconnect | Not examined in depth in this audit | Implemented (from an earlier session): exponential backoff + jitter, `requires_attention` escalation after a threshold, manual reconnect resets the streak |
| WhatsApp as a notification channel | — | **Inbound monitoring only.** There is no outbound notification via WhatsApp — all notification delivery goes through the Telegram Bot API directly from n8n, bypassing `whatsapp-worker` entirely. |

---

## 19. Current Dependency Graph

```
telegram-worker ──┐
                   ├──► n8n (webhook triggers) ──► Raw Monitor Primary Lead Gate
whatsapp-worker ──┘                                        │
                                                             ▼
                                          HTTP Request - NIKA Matching Pilot
                                                             │
                                                             ▼
                                          n8n webhook "NIKA PILOT - Matching"
                                             │           │            │
                                             ▼           ▼            ▼
                                        PostgreSQL   OpenAI API   Telegram Bot API
                                        (matching.*)  (parser)    (one shared chat)
                                             ▲
                                             │
                                        dashboard/ (read + broker admin write)
                                             │
                                             ▼
                                   telegram-worker/whatsapp-worker /health, /accounts (for /channels)
                                             │
                                             ▼
                                        Joker CRM API (mapping UI only, /brokers)
```

Matching Engine → n8n: **hard dependency** (the only entry point is an HTTP webhook, which itself lives inside n8n runtime as a workflow).
Matching Engine → PostgreSQL: hard (candidate retrieval — direct SQL inside an n8n node).
Matching Engine → OpenAI: hard, but separable (a single HTTP call).
Dashboard → Matching Engine: **no direct dependency** — the dashboard only ever reads results (views), never calls the matcher directly.

---

## 20. Current Coupling Problems

1. **The only entry point into the matcher is an n8n webhook.** The pure functions (`matchRequest` etc.) are not wrapped in any independently runnable API/CLI — invoking them outside n8n today means writing a one-off Node script by hand (as done throughout this audit/session for testing), there is no ready-made interface.
2. **The candidate filter is embedded inside the matcher module itself** (`filterViableCandidates` inside `matcher.js`) — a pure function, but the SQL query that feeds it lives in an n8n node, not next to the function.
3. **A substantial amount of schema+code is not wired into the runtime** (§11, §16): broker routing, notification delivery, Joker sync, channel health — this creates a real risk during refactoring of "fixing" something that appears active but has long been orphaned.
4. **`src/db/*Repository.js` is used only by tests** — i.e., the future independent service's DB-access pattern already half-exists, but production code doesn't use it (n8n just stores raw SQL as strings in `sql-snippets.js`).
5. **A bundler dependency** (`bundle-code-node.js`) requires all code in `src/core/*.js` to be written in a very specific style (single-line `require`, a specific `module.exports` shape) — this is a real, recently discovered source of a production bug (a SyntaxError inside the n8n sandbox), because the bundler is a simple text stripper, not a real JS bundler (esbuild/webpack).
6. **The dashboard and Telegram notifications read/write the same database without a shared access layer** — the dashboard uses its own `queries.js`, n8n uses its own `sql-snippets.js`; they independently maintain equivalent SQL against the same tables.

---

## 21. Can Monitoring Run Without Matcher?

**Yes, partially, already today.** Lane B (`Universal Filter + Normalize` → `Postgres - Save + Dedupe` → `Keep Only Accepted New Leads` → Telegram/Sheets/external forwarding) is fully independent of the Matching Engine — messages continue to be collected, filtered, and stored into `devi_messages` even if the entire pilot workflow is turned off. Lane A would also technically survive the matcher being turned off — `HTTP Request - NIKA Matching Pilot` would simply get a connection error (no retry/circuit breaker, but nothing upstream breaks either, since it's the last node in that chain).

---

## 22. Can Matcher Run Without Monitoring?

**Not today, not without manual workarounds.** The only entry point is the n8n webhook inside the `NIKA PILOT - Matching` workflow. Running a structured request through the matcher without Telegram/WhatsApp:
- Is technically possible — done repeatedly throughout this conversation via direct `curl`/`node -e` POSTs to `/webhook/nika-matching-pilot`.
- But that is a **workaround through n8n**, not an independent call into the pure functions — n8n is required as a runtime because all the surrounding wiring (dedup hash, alias fetch, stock fetch, insert match run, Telegram send) are n8n nodes, not a single program that can be run as `node matcher.js`.

**Blockers to real independence:**
- No standalone HTTP server/CLI that simply calls `matchRequest()` directly.
- SQL queries (fetch aliases/stock/sync) are embedded today as n8n Postgres nodes rather than calls into `src/db/*Repository.js` (which are only used by tests).
- Telegram sending is an n8n `httpRequest` node, not a reusable function with an explicit side-effect boundary.

---

## 23. Side Effects That Must Be Separated

Found in `scripts/templates/matching-workflow.js` (not in `matcher.js` itself — importantly: **`matcher.js` itself has zero side effects**, it is a pure function):

| Side effect | Where | Needs separating? |
|---|---|---|
| PostgreSQL SELECT (aliases, stock, sync) | n8n Postgres nodes | Yes — move to an API/repository layer in front of the matcher |
| PostgreSQL INSERT/UPSERT (match_runs, match_results) | n8n Postgres nodes | Yes — this is the persistence layer, not the core |
| OpenAI HTTP call | n8n httpRequest node | Yes — already isolated into a single node, easy to extract |
| Telegram HTTP call | n8n httpRequest node | Yes |
| Google Sheets append (Match Log) | n8n googleSheets node | Yes |
| AI usage logging | a separate parallel n8n Postgres node, `onError: continueRegularOutput` | Already reasonably isolated (fire-and-forget) |
| n8n execution context (`$json`, `$('Node Name')`) | glue code in `matching-workflow.js` (`VALIDATE_PARSER_GLUE`, `DETERMINISTIC_MATCH_GLUE`, etc.) | Yes — this is the most explicit n8n-specific coupling, which would need to be replaced with plain JS function arguments |

---

## 24. Recommended Future Module Boundary *(RECOMMENDED — not the current state)*

**MONITORING MODULE** (what already exists — telegram-worker, whatsapp-worker, envelope nodes, Raw Monitor Primary Lead Gate) — responsibility: receive a message → determine buyer request (regex pre-filter) → parse it (AI) → produce a structured request → **hand it off via a contract** (see §25), rather than calling the next stage's n8n nodes directly.

**MATCHING MODULE** (today's `src/core/*.js` plus a wrapper) — responsibility: accept a structured request via the contract → find stock → return matches. Should know nothing about Telegram/WhatsApp/n8n/Joker.

---

## 25. Proposed Monitoring → Matcher Contract *(RECOMMENDED, a field proposal only)*

Adapted to the real fields of `request-schema.js`/the webhook payload, not invented from scratch:

```json
{
  "request_id": "telegram:telegram_1559760609-308394",
  "source": "telegram",
  "source_url": "https://t.me/uae_brokers/308394",
  "group_name": "Dubai Real Estate, UAE Brokers",
  "author_name": "Igor Lapcinskiy",
  "author_contact": "https://t.me/igor_emaarbeachfront",
  "sender_id": "1559760609",
  "original_text": "...",
  "transaction_type": "SALE",
  "area": "Emaar Beachfront",
  "building": null,
  "property_type": null,
  "bedrooms": null,
  "budget_min": null,
  "budget_max": null,
  "furnishing": null,
  "cash_buyer": null,
  "confidence": null,
  "buying_intent": true,
  "seeking_info": false,
  "promotion": false,
  "spam": false
}
```

This is already almost exactly what `Validate Parser Result` returns today — a real migration would formalize an existing shape, not invent a new one.

---

## 26. Minimal Changes Required Later *(RECOMMENDED, not implemented)*

- Extract `matcher.js` + its SQL queries (alias/stock fetch) behind a standalone HTTP endpoint or library call, decoupled from `$json`/`$('Node')`.
- Replace the n8n Postgres nodes with calls into `src/db/*Repository.js` (already exists, already tested — simply unused by the runtime).
- Introduce a contract version (`schema_version`) on the structured request, so Monitoring/Joker/dashboard/a test script can each evolve independently.
- Decide the fate of the orphaned layer (broker routing/notification delivery/Joker sync/channel health) — either wire it up or explicitly mark it "not in this iteration" before refactoring, so dead code isn't carried into the new module.

---

## 27. Existing Tests / Baseline Results

Commands: `npm run test:unit`, `npm run test:contracts`, `npm run test:integration` (from `nika-matching-pilot-starter/package.json`).

| Suite | Total | Passed | Failed |
|---|---|---|---|
| Unit (`tests/unit/**`) | 169 | 169 | 0 |
| Contracts (`tests/contracts/**`) | 17 | 17 | 0 |
| Integration (disposable Docker Postgres, all 14 migrations applied cleanly) | 19 | 19 | 0 |
| **Total** | **205** | **205** | **0** |

Live/side-effecting tests (a real n8n webhook, real Telegram, real Google Sheets) were not run — gated behind `RUN_N8N_INTEGRATION_TESTS`/`RUN_TELEGRAM_LIVE_TESTS`/`RUN_GOOGLE_SHEETS_LIVE_TESTS`, all `false` in `.env`.

---

## 28. Risks / Unknowns

1. **`nika-matching-pilot-starter/` is not in git at all** (untracked, 0 files in `git ls-files`). All the work from this and prior sessions physically exists only on one machine's disk — no history, no VCS-based backup, no way to trace who/when changed what.
2. **A significant orphaned layer** (§11, §16, §18) — `broker_notification_routes`, `notification_deliveries`, `joker_sync_runs`, `channel_health_checks`, `property-prescreen.js`, `channel-health.js` — built, tested, but not connected. Risk during future refactoring: mistaking "written" for "working."
3. **The dashboard runs unauthenticated right now** (`DASHBOARD_USERNAME/PASSWORD` are blank in `.env`) — real lead data (names, phone numbers, broker links) is shown without authentication if the dashboard is reachable beyond localhost.
4. **The "Secondary" second lane** in the production workflow — its exact purpose could not be established from code alone, needs confirmation from the production workflow's owner before any changes are made near it.
5. **No separate repository/CI** for the matching pilot — all quality gates (lint/tests) are run manually from a terminal; there is no pre-commit/CI gate.
6. **`app/ai-qualifier`** — a separate product in the same monorepo with active ongoing changes (a Retell integration, etc.) — not examined in depth here since it is clearly outside "Monitoring/Matching," but worth explicitly confirming with the owner that it truly doesn't overlap.

---

# ARCHITECTURE SNAPSHOT

```
CURRENT

Telegram (Telethon) ─┐
WhatsApp (Baileys)  ─┴─► n8n webhook triggers
                          → Raw Telegram/WhatsApp -> DEVI Envelope
                          → Raw Monitor Primary Lead Gate (classifyIntentV2)
                          → Explode Raw Leads for Matching Pilot
                          → HTTP Request - NIKA Matching Pilot
                          → n8n webhook "NIKA PILOT - Matching"
                             → Content-hash dedup → OpenAI parser → Validate
                             → Postgres fetch aliases/stock/sync
                             → Deterministic Match (pure JS, src/core/*.js)
                             → Postgres insert match_run/match_results
                             → Telegram Bot API (one shared chat)

Main coupling: the only entry point into the matcher is an n8n webhook;
               SQL and side effects live in n8n nodes, not a library.

Database: one PostgreSQL, schema matching (14 migrations),
          + read-only public.devi_messages.

Matcher location: nika-matching-pilot-starter/src/core/{matcher,scoring,
                   no-match-reason,aliases,normalize}.js — already PURE
                   functions with no n8n dependency, but the wiring
                   around them (fetch/persist/notify) lives entirely in n8n.


TARGET BOUNDARY (RECOMMENDED, not implemented)

Monitoring (telegram-worker, whatsapp-worker, regex pre-filter, AI parser)
        → StructuredRequest (contract, §25)

Matching Engine (src/core/*.js behind its own API/CLI entry point)
StructuredRequest + stock/alias repository
        → Matches

Notification Router (does not exist yet as a separate layer —
                      currently hardcoded inside the n8n workflow)
Matches
        → Telegram / WhatsApp / dashboard / (Joker — not wired in)
```

No changes were made to code, schema, workflows, or deployments as part of this audit.
