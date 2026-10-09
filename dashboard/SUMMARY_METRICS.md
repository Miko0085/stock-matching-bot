# Dashboard Summary — Metrics Reference (v2, Phase 1)

Source of truth for every number on `/` (Dashboard Summary). If this file
and the code ever disagree, the code (`dashboard/summary-queries.js`) is
right — file a fix here.

**Core principle**: no number on this page may have an ambiguous business
meaning. Where the underlying data can't support an unambiguous metric
yet, the page says `NOT TRACKED` / omits the widget entirely rather than
showing something that looks precise but isn't. See "Known gaps" at the
bottom.

## Why this exists

The original Summary (`matching.v_dashboard_summary`, migration `0006`)
was designed around a status model (`STRONG_MATCH`/`MATCH`/`NO_MATCH`/
`ERROR`) that predates `lead-matching-service`. Two systems now write into
`matching.match_runs`/`match_results` — the legacy n8n pilot workflow
(`matcher_version = 'pilot-v1'`) and the current standalone matcher
(`matcher_version = 'lead-matching-service-v1'`) — with materially
different semantics (see "Current vs. Legacy" below). The old view mixed
both, undercounted real traffic by ~80%, and computed at least one KPI
(`Avg Matches / Request`) with a denominator ~50x too large. Full findings:
this session's two prior audit passes (not reproduced here — see git
history around this change for the audit reports).

`matching.v_dashboard_summary` itself is **not dropped** — it may still
have external consumers (Metabase, per its own original design intent).
This dashboard's `/` route simply no longer queries it.

## Current vs. Legacy — why they're never combined

| | Current matcher (`lead-matching-service-v1`) | Legacy pilot (`pilot-v1`) |
|---|---|---|
| Pipeline | event dedup → content dedup → deterministic triage (local/AI) → interpretation cache → hard filters → flat `MATCH` | AI parser (every message) → scoring → `MATCH`/`STRONG_MATCH` threshold |
| `result_status` values observed | `MATCH`, `NO_MATCH`, `REJECTED`, `DUPLICATE`, `INSUFFICIENT_CRITERIA` (never `STRONG_MATCH`) | `MATCH`, `NO_MATCH`, `STRONG_MATCH` (never `REJECTED`/`DUPLICATE`/`INSUFFICIENT_CRITERIA`) |
| `no_match_reason` vocabulary | e.g. `location_not_found`, `over_budget`, `not_buyer_request` | e.g. `area_not_resolved`, `all_candidates_over_budget`, `not_a_request` — only `property_type_mismatch` happens to overlap |
| `provider` column | populated (`telegram`/`whatsapp`) | always `NULL` |
| `triage_decision`/`interpretation_source` | populated | always `NULL` (concept doesn't exist) |

Because the vocabularies and even the possible outcome sets differ, no
widget on this page ever aggregates `match_runs` across both
`matcher_version`s.

**2026-10-07**: the page's own "Legacy Pilot" section (`getLegacySummary`/
`renderLegacyPilot`) was removed — no longer relevant, since the n8n
pilot-v1 workflow has been retired since 2026-10-02 (AGENTS.md section 10)
and produces no new rows. The table above and the isolation discipline it
describes stay as historical/architectural context: every query in
`summary-queries.js` is still explicitly scoped to `matcher_version =
'lead-matching-service-v1'`, so a stray legacy row can never silently
inflate a Current Matching number even though there is no longer a
legacy-specific widget to show it separately.

## Canonical request outcome

One physical buyer message (`source_message_id`) can have more than one
`match_runs` row for the same `matcher_version` — event retry, a manual
replay, or a genuine reprocess (confirmed live: 4 real cases for the
current matcher as of this writing; 0 for legacy, which is 1:1 today).
Every metric here first collapses to one **canonical** row per
`(matcher_version, source_message_id)`:

- prefer the latest **non-`DUPLICATE`** row, if one exists in the scoped
  period (`PARSER_ERROR` at 10:00 then `MATCH` at 11:00 → canonical
  `MATCH`; `MATCH` at 10:00 then `DUPLICATE` at 10:01 → canonical `MATCH`)
- fall back to the latest row (which will be `DUPLICATE`) only when
  **every** row for that message in the scoped period is `DUPLICATE`

This is applied **after** the period/provider filter, not before — a
period view reflects canonical outcomes among rows inside that window
only, never bleeding in a status from outside it. (Implication: the same
message can canonicalize differently in a 24h view vs. an all-time view —
this is intentional, see `tests/integration/summary-queries.test.js`'s
period test for the exact scenario.)

## Period filter

`24h` / `7d` / `30d` / `All`, default `7d`. Implemented as **rolling
intervals** (`created_at >= now() - interval '...'`), never calendar-day
buckets — sidesteps timezone entirely. Applies to every request-level
metric. **Does not apply to Active Stock** (a live snapshot, not a
period-scoped count).

## Provider filter

`All providers` / `Telegram` / `WhatsApp`, using the already-persisted
`match_runs.provider` column. Applies to every Current Matching metric.
**Does not apply to** Active Stock (a live snapshot, not request-scoped).

---

## Metric reference

### Active Stock
- **Business definition**: count of `matching.stock_inventory` rows with `status = 'ACTIVE'`, right now.
- **SQL source**: `summaryQueries.getActiveStock()`.
- **Matcher scope**: n/a (shared inventory table).
- **Period behavior**: none — live snapshot.
- **Provider behavior**: none.
- **Drill-down**: `/stock`.

### Match-Eligible Requests
- **Business definition**: canonical current-matcher requests whose outcome was `MATCH` or `NO_MATCH` — i.e. requests the matcher actually attempted to match against stock (excludes duplicates/rejections/parser errors/insufficient-criteria, none of which ever reach matching).
- **SQL source**: `getRequestFlow().matchEligible` = `matched + noMatch`.
- **Matcher scope**: current only.
- **Denominator for Match Rate**: this number.
- **Drill-down**: `/requests`, `/history`.

### Matched Requests
- **Business definition**: canonical current-matcher requests with outcome `MATCH` (or `STRONG_MATCH`, if the current matcher ever produces one — it does not today, verified: 0/4316 rows).
- **SQL source**: `getRequestFlow().matched`.
- **Matcher scope**: current only.

### Match Rate
- **Business definition**: `Matched Requests / Match-Eligible Requests`.
- **Zero-safe**: `null` (rendered `—`) when Match-Eligible is 0 — never `NaN`/`Infinity`.
- **Matcher scope**: current only.

### Processing Errors
- **Business definition**: canonical current-matcher requests with outcome `PARSER_ERROR` or `ERROR` (both allowed by the `result_status` CHECK constraint; `ERROR` has never occurred in live data as of this writing).
- **SQL source**: `getRequestFlow().errors`.
- **Matcher scope**: current only.

### Request Flow (Processed / Duplicates / Rejected / Insufficient Criteria / Processing Errors / Other / Match-Eligible → Matched, No Match)
- **Business definition**: every canonical current-matcher outcome, bucketed so the buckets always sum exactly to `Processed`. `Other` is a catch-all for any `result_status` this mapping doesn't explicitly know about (currently always 0 — every observed status is mapped) — it exists so a future new status is never silently dropped from reconciliation.
- **Bucket map**: `DUPLICATE→duplicates`, `REJECTED→rejected`, `INSUFFICIENT_CRITERIA→insufficientCriteria`, `PARSER_ERROR`/`ERROR→errors`, `MATCH`/`STRONG_MATCH→matched`, `NO_MATCH→noMatch`, anything else→`other`.
- **Reconciliation invariant** (tested): `duplicates + rejected + insufficientCriteria + errors + matchEligible + other === processed`, always, by construction.
- **Matcher scope**: current only.

### Interpretation (Local / AI Review / AI / Cache Hits)
- **Business definition**: how the current matcher's deterministic triage stage classified each canonical request that reached it.
- **Denominator**: `triageTotal` = count of canonical rows with a non-null `triage_decision` (`PARSED_LOCALLY + AI_REVIEW + REJECT`). This **excludes** rows that never reach triage at all — content/event-level duplicates, and interpretation-cache hits, which record `interpretation_source` without a fresh `triage_decision`. **AI Review Rate** = `AI_REVIEW / triageTotal`.
- **Cache Hit Rate**: `(cache_local + cache_ai) / (local + cache_local + ai + cache_ai)` — i.e. share of all local+AI interpretations (fresh or cached) that were served from the interpretation cache.
- **Matcher scope**: current only (`triage_decision`/`interpretation_source` are always `NULL` for legacy).
- **Explicitly excluded**: AI token cost/model cost/daily spend chart — that stays on `/ai-usage` only, to avoid duplicating it here.

### Why Requests Did Not Match
- **Business definition**: `no_match_reason` on canonical current-matcher rows (populated for both `NO_MATCH` and `REJECTED`/etc. outcomes that carry a reason), top 8 by count + an `other` bucket for the remainder. Vocabulary is read from the live data every time, never hardcoded — current and legacy reason strings are different taxonomies (see table above).
- **Matcher scope**: current only.
- **Drill-down**: `/history` (filterable).

### Traffic by Provider
- **Business definition**: the same Request Flow numbers (Processed/Match-Eligible/Matched/Match Rate), computed once per provider (`telegram`, `whatsapp`).
- **Matcher scope**: current only (legacy never populates `provider`).
- **Note**: hidden when the page's own provider filter is already scoped to one provider (redundant otherwise).

---

## Known gaps — documented, not fixed in Phase 1

- **Stock-level matcher ownership**: `matching.match_results`'s unique key is `(source_message_id, stock_id)` with no `matcher_version` column; both writers use the identical `ON CONFLICT ... DO UPDATE` pattern (confirmed in both `lead-matching-service/src/repositories/match-repository.js` and the live n8n workflow JSON). A collision would silently overwrite one system's result with the other's. **Verified live: 0 observed `(source_message_id, stock_id)` collisions across matcher versions as of this writing** — the risk is real in code, not yet manifested in data. This is why Phase 1 shows **no** stock-level KPIs (`Total Matches`, `Unique Stock Matched`, `Avg Matches/Opportunities per Request`) at all — they are NOT TRACKED here until a Phase 2 ownership fix.
- **Cross-system content-hash dedup**: `checkDuplicate()`'s `content_hash` lookup has no `matcher_version` filter — a message can be marked `DUPLICATE` by the current matcher purely because of an unrelated legacy-pipeline row with a matching hash. **Verified live**: 2 real cross-system hash collisions found; in both, the same `requester_sender_id` was confirmed on both sides, meaning the dedup decision was actually correct in both observed cases (a genuine repost by the same sender) — not a proven false-positive, but the mechanism itself has no isolation and could produce one. NOT TRACKED / NOT FIXED here.
- **Deep hard-filter funnel** (`after_location`, `after_transaction`, `after_property_type`, `after_bedrooms`, `after_budget`, ...): these intermediate counts are computed once at runtime (`hard-filters.js`) and discarded — only the single winning `no_match_reason` survives. **NOT TRACKED.** Would require new persisted telemetry (future phase, out of scope here).
- **`candidates_count` semantics**: on `match_runs`, this column means "fully hard-filtered survivors" for a `MATCH` outcome but "location-only diagnostic pool" for most `NO_MATCH` outcomes (verified in `lead-matching-service/src/matching/matcher.js`) — the two meanings are incompatible and this column is **never aggregated anywhere on this page**.
- **Notification delivery**: current-matcher notification attempts (`sendMatchNotification`) are logged in-process only (`logEvent`) on failure, never persisted to Postgres. `matching.notification_deliveries` exists but belongs to an unrelated, never-wired broker-routing feature (confirmed: 0 rows, ever). **NOT TRACKED.** A `MATCH` whose Telegram send silently failed is indistinguishable from one that succeeded, from this page or any other.
- **Per-matcher AI cost**: `matching.ai_usage_log` is written by both systems (confirmed: the legacy n8n workflow has a live `INSERT INTO matching.ai_usage_log` SQL node) with no `matcher_version` column, so current-vs-legacy AI spend **cannot be attributed** from this table alone. `/ai-usage` is left as-is; no split is shown here.
