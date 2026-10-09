# Nika Matching V2 Refactor — Phase 0 Baseline

**Status:** Phase 0 output (`AGENTS_NIKA_MATCHING_V2.md`, section 26).
**Purpose:** the verified starting point every later phase (1-18) compares against. This document records FACTS observed on the dates below — it is not itself a design document, and it must be updated (not silently ignored) if a later phase's assumptions turn out to be wrong.

## 0. Verified starting point

```
Repository:      Miko0085/ai-broker-agent (git remote still points at the
                 renamed nika-matching-pilot-starter URL; GitHub redirects)
Contract commit: c93ea9091a8b04cfd8fa9afc8c3050f14f06b600
                 (adds AGENTS_NIKA_MATCHING_V2.md)
Base commit:     40acb80fce87b1ae9ea72b2297f1a8ece685c158
                 (matching-correctness implementation: P0 RENT fix,
                 multi-area, match_diagnostics, triage/parser fixes)
Implementation branch: feature/simplify-matching-v2
Date:            2026-09-24
```

## 1. Test baseline (this exact commit, before any V2 change)

| Suite | Command | Result |
|---|---|---|
| Root unit | `npm run test:unit` | 208/208 pass |
| Root contracts | `npm run test:contracts` | 19/19 pass |
| Root integration (disposable Postgres) | `npm run test:integration` | 43/43 pass |
| lead-matching-service unit (no DB) | `node --test` | Pre-Phase-0: 272 passed + 31 DB-dependent `ECONNREFUSED` failures + 3 skipped = 306 total. After adding this phase's 5 characterization tests (section 5): 277 passed + 31 DB-dependent `ECONNREFUSED` failures + 3 skipped = 311 total. In both cases the 31 failures are a local Postgres not running in this shell, not real failures, and the 3 skips are the live-OpenAI-gated tests (`RUN_OPENAI_LIVE_TESTS`). |
| lead-matching-service integration (disposable Postgres) | `node --test tests/integration/**/*.test.js` | 27/27 pass |

No runtime code changed to produce this table — the 272/306 → 277/311 shift is exactly the 5 new tests this phase added, not a behavior change.

## 2. Production reality check (read-only, `SELECT`-only transaction, aggregate counts only)

Queried via the existing SSH tunnel (`127.0.0.1:55432` → production `devi_db`, role `matching_pilot`), inside `BEGIN; SET TRANSACTION READ ONLY; ... ROLLBACK;`. No row was written, no migration was run, no PII is reproduced below (aggregate counts only).

**Critical finding: production is NOT running the code in this repository.** `matching.schema_migrations` in production stops at `0018_matching_rf_skeleton.sql` — migration `0019_match_diagnostics.sql` (part of commit `40acb80`) has never been applied, and a direct `SELECT match_diagnostics FROM matching.match_runs` fails with `column "match_diagnostics" does not exist`. Since every `INSERT` from the current code would otherwise bind that column, this proves the deployed `lead-matching-service` container predates commit `40acb80` entirely — none of yesterday's RENT/multi-area/triage fixes are live yet. `no_match_reason = 'location_missing'` (the pre-rename value) still appearing in the last 7 days confirms the same thing independently.

**`match_runs` totals (all-time, both writers):**

| matcher_version | total rows | first seen | last seen |
|---|---|---|---|
| `lead-matching-service-v1` | 6,828 | 2026-09-17 | 2026-09-24 |
| `pilot-v1` (legacy) | 804 | 2026-09-15 | 2026-09-24 |

**`result_status` breakdown, last 7 days:**

| matcher_version | status | count |
|---|---|---|
| lead-matching-service-v1 | DUPLICATE | 2,980 |
| lead-matching-service-v1 | REJECTED | 3,540 |
| lead-matching-service-v1 | INSUFFICIENT_CRITERIA | 66 |
| lead-matching-service-v1 | NO_MATCH | 241 |
| lead-matching-service-v1 | **MATCH** | **1** |
| pilot-v1 | STRONG_MATCH | 41 |
| pilot-v1 | MATCH | 8 |
| pilot-v1 | NO_MATCH | 551 |

The current-matcher `MATCH` count (1 out of ~3,848 non-duplicate rows in 7 days) proves that the current END-TO-END PRODUCTION PIPELINE produces almost no matches. It does NOT by itself prove that the matcher/candidate-query logic is the root cause — the pipeline stage where candidates are actually being lost (triage rejecting genuine buyers, AI misclassification, alias/location resolution, thin stock, or the matcher itself) is not distinguishable from this aggregate count alone. This is exactly why V2 funnel instrumentation (Phase 13, and the shadow-mode comparison in Phase 3) is needed — to determine WHERE in the pipeline candidates are lost, not just that they are. This number is captured here as the "before" baseline, not a target, and is expected to change once `40acb80`+ is deployed and the funnel becomes observable.

**Deterministic triage decision, current matcher, last 7 days** (this is the AI-cost gate V2 sections 6-8 target):

| triage_decision | count |
|---|---|
| `NULL` (duplicate/cache-hit, never reaches triage) | 4,818 |
| `AI_REVIEW` | 1,765 |
| `REJECT` | 237 |
| `PARSED_LOCALLY` | 8 |

**Interpretation source, current matcher, last 7 days:**

| interpretation_source | count |
|---|---|
| `NULL` | 4,475 |
| `ai` | 1,765 |
| `local` | 245 |
| `cache_local` | 182 |
| `cache_ai` | 161 |

Of the 2,153 fresh (non-cache) interpretations, 1,765 (82%) went to AI and only 245 (11%) were resolved locally without any AI call — a concrete baseline for Phase 3/4's "reduce unnecessary AI calls" goal. (`PARSED_LOCALLY` triage count of 8 vs. `local` interpretation-source count of 245 differ because the latter also includes interpretation-cache-recorded local parses from requests that took the cache-hit path before ever reaching a fresh triage decision this week.)

**Top `no_match_reason` values, current matcher, last 7 days** (top 15, aggregate only):

`duplicate_content` 1,939 · `advertisement` 1,447 · `not_buyer_request` 1,058 · `spam` 596 · `location_not_found` 194 · `empty_text` 172 · `single_listing_inventory_ad` 115 · `multi_listing_inventory_ad` 112 · `location_missing` 60 · `recipient_owned_demand` 26 · `transaction_mismatch` 15 · `no_stock_in_area` 14 · `non_property_request` 14 · `no_stock_in_building` 11 · `duplicate_event` 9

**AI usage, last 7 days, both writers combined** (`matching.ai_usage_log` has no `matcher_version` column — pre-existing, documented gap, see `dashboard/SUMMARY_METRICS.md`):

```
calls:              3,664
prompt_tokens:      3,085,756
completion_tokens:    529,145
total_tokens:       3,614,901
```

No physical-attempt/retry visibility exists in this table today — only logical call count and token totals. This is the exact gap V2 Phase 6 ("AI cost/attempt telemetry") is meant to close; it cannot be back-filled from existing data.

**Active stock:** 94 rows (`matching.stock_inventory WHERE status = 'ACTIVE'`), unchanged from the Phase H/I forensic audit.

## 3. Contract conflicts found (recorded, not silently resolved)

Per `AGENTS_NIKA_MATCHING_V2.md`'s own instruction: where it conflicts with older `AGENTS.md` / `docs/MARKET_CONTOURS_AND_SOURCE_ROUTING.md` / the current `lead-matching-service` implementation, the V2 contract wins for the active matcher; legacy stays legacy.

| # | Conflict | Old/current behavior | V2 contract | Resolution |
|---|---|---|---|---|
| 1 | Weighted score / STRONG_MATCH | `AGENTS.md` §5 defines a 100-point weighted score with 85/70 thresholds; legacy `pilot-v1` still generates `STRONG_MATCH`. | §15: no weighted score decides MATCH; V2 never generates `STRONG_MATCH`. | V2-only rule, addressed in Phase 10. `pilot-v1` is untouched (it is legacy/frozen). |
| 2 | bathrooms/size/plot_size/furnishing as hard filters | **Current `lead-matching-service` code** (not just old docs) hard-blocks a MATCH when these are stated and the stock value is missing or mismatched (`hard-filters.js`). | §13: these are metadata-only and must never block a match. | Real code change required — tracked as Phase 8, not done in Phase 0. |
| 3 | Local structured parser in the production decision path | `local-parser.js` actively participates in triage (`PARSED_LOCALLY` skips AI) — a real, tested cost-optimization feature built in an earlier session. | §10: local parser must be removed from the runtime decision path (may remain for legacy/regression only). | Deliberate, planned reversal — Phase 5. Flagged here so it is not lost sight of; not started yet. |
| 4 | Per-request `match_diagnostics` funnel query | Current code runs one aggregate SQL funnel query per genuine buyer-path request and persists it. | Phase 11: "Remove expensive diagnostics from normal request path unless specifically enabled" — simple `reason` only by default; full CLI diagnostics stay separate. | Not done in Phase 0; tracked for Phase 11. |
| 5 | RENT transaction/price semantics | — | §12.2 | **No conflict** — `transaction-semantics.js` (commit `40acb80`) already matches the V2 contract exactly (`SALE→selling_price`, `RENT→RENT_YEARLY→annual_rent`, one shared implementation). |
| 6 | Multi-area OR semantics | — | §12.1 | **No conflict** — `location-dictionary.js`/`areas[]` (commit `40acb80`) already matches: most-specific level wins, multiple areas OR, never silently broadens an unresolved specific building/project. |
| 7 | Configurable ON/OFF per criterion | Current code always applies transaction/bedrooms/property_type/budget when the request states them; there is no global enable/disable toggle. | §12.2-12.5: each of these four must be independently configurable from the UI. | New functionality, not a regression — tracked for Phases 1/2/8. |
| 8 | Deterministic intake rules | Current triage (`triage.js`) uses hardcoded regex pattern lists (blacklist-like/whitelist-like logic baked into code). | §7-8: rules must live in PostgreSQL, editable from the dashboard (BLACKLIST/WHITELIST/PROPERTY_SIGNAL/SEND_TO_AI). | Full replacement of the current mechanism — Phases 1-4. |

## 4. Active vs. legacy file inventory

```
ACTIVE (evolves during V2):
  lead-matching-service/src/**          41 .js files

LEGACY (read-only / rollback / history — no new business logic):
  src/core/**                           19 .js files  (pilot-v1 domain logic)
  scripts/templates/matching-workflow.js,
  scripts/templates/stock-sync-workflow.js  (n8n workflow generators — stock-sync
                                             template stays in use for the shared
                                             stock/alias sync; matching-workflow.js
                                             generates the legacy pilot-v1 matcher)
  n8n/workflows/nika-pilot-matching.json     (generated, legacy matcher workflow)
  rf-lead-matching-service/**            RF contour, frozen per contract §4
```

Note: `scripts/templates/stock-sync-workflow.js` generates the Google-Sheets → Postgres
stock/alias sync, which BOTH matchers depend on (shared infrastructure, not
matching business logic) — it is not "legacy" in the same sense as the matcher
template; it stays in active use.

## 5. Regression corpus (Phase 0 deliverable)

`lead-matching-service/tests/fixtures/` — existing fixtures (business-bay, emaar-ad,
the-edge, area-only, direction-sender/recipient, multi-listing-ad) plus 5 new ones
added in this phase, each reconstructing a real, previously-audited scenario
(not fabricated criteria — see each fixture's paired characterization test for
provenance):

- `telegram-multi-area-cash-buyer.json` — live forensic audit "Case 01"
- `telegram-multi-area-dso-warsan.json` — live forensic audit "Case 02"
- `telegram-rent-request.json` — the RENT P0 release blocker
- `telegram-comma-thousands-sqft.json` — the comma-thousands parser bug
- `telegram-russian-seller-offer.json` — the Russian seller-direction bug

`lead-matching-service/tests/regression/v2-baseline-corpus.test.js` runs the
deterministic triage gate (no AI, no DB) against every new fixture and asserts
TODAY's actual observed decision — a characterization test, not a correctness
test. If a later phase changes one of these assertions, that must be a
deliberate, reviewed part of that phase, never a silent side effect.

## 6. Deployment sequencing (explicit, given production predates `40acb80`/migration `0019`)

- **Phase 1** (configuration database) and **Phase 2** (Settings UI) can be
  fully developed and tested locally/against a disposable Postgres, without
  any production deployment — they are additive schema + UI work that the
  current production runtime simply ignores.
- **Phase 3** (new intake gate in shadow mode) can likewise be implemented
  and tested locally — shadow-mode comparison logic does not require
  production to be running the new code first.
- **Live shadow validation of Phase 3** (i.e. actually comparing old vs. new
  decisions against real production traffic) and **Phase 4** (intake
  cutover) both require production to actually be running this code first.
  Since production currently predates commit `40acb80` and migration `0019`
  (section 2), that requires a **separately approved production
  synchronization/deployment** before either can proceed — this is not
  implied by, and must not be bundled into, Phase 1/2/3 approval.

## 7. Known gaps carried into this refactor (not fixed in Phase 0)

- `matching.ai_usage_log` has no `matcher_version` column — current-vs-legacy
  AI cost cannot be split from existing data (pre-existing gap, documented in
  `dashboard/SUMMARY_METRICS.md`; V2 Phase 6 adds new telemetry going forward,
  it does not retroactively fix old rows).
- `matching.match_results` has no `matcher_version` in its unique key
  (pre-existing gap, out of scope for this refactor per the V2 contract's own
  "Broker/Joker/extra notification infrastructure... outside this
  simplification scope" and general "do not add new business logic" framing
  for anything not explicitly listed in the 18 phases).
