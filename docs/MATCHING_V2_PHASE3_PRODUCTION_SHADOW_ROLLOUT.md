# Nika Matching V2 — Phase 3 Production Shadow Rollout

**Status:** Migrations 0019-0022 applied to production `devi_db`. `lead-matching-service` + `dashboard` deployed and running (currently **locally**, on the operator's own machine — see "Deployment topology" below), receiving real Telegram/WhatsApp traffic in parallel with the legacy n8n `pilot-v1` workflow. Phase 4 (authoritative cutover) is **not** implemented and **not** enabled anywhere. This document also serves as the pre-cutover shadow-evidence review the Phase 4 task requires before any future cutover attempt.

## 1. Production precheck (before any change)

Connected read-only via the existing SSH tunnel (`scripts/tunnel.sh`, `176.12.73.12:5432` → `127.0.0.1:55432`) as role `matching_pilot`.

| Check | Result |
|---|---|
| Database | `devi_db` (confirmed via `SELECT current_database()`) |
| Schema | `matching` |
| Migrations applied before this rollout | `0000`–`0018` (latest: `0018_matching_rf_skeleton.sql`) |
| `0019`/`0020`/`0021`/`0022` present? | **No** — all four absent. `0019` was expected by the task's own migration list to already be applied; it was not. Flagged and confirmed with the operator before proceeding (see section 2). |
| Partial V2 objects already present? | None — clean slate, no half-applied state. |
| Role `matching_pilot` privileges | Not superuser, not `CREATEDB`, but has `CREATE` on the `matching` schema — sufficient for every migration in this rollout. |
| Existing data | `match_runs` = 7,686 rows, `match_results` = 832 rows (both actively growing during this rollout — confirmed live production, not idle). |
| Current traffic path | Legacy n8n `pilot-v1` workflow (`n8n` Docker container on `176.12.73.12`, port `5678`) — confirmed still the only system with real notification authority at the start of this rollout. |
| `lead-matching-service` / `dashboard` running anywhere already? | **No** — no container, no systemd unit, no process, no on-disk checkout found on `176.12.73.12`. This was a **first deployment**, not a restart. |

## 2. Migration review and scope correction

Migrations `0020`/`0021`/`0022` were reviewed statically before this rollout (additive-only `CREATE TABLE IF NOT EXISTS`, existence-guarded `ADD CONSTRAINT`, idempotent seed blocks) — see `docs/MATCHING_V2_PHASE1_CONFIG.md` and `docs/MATCHING_V2_PHASE3_SHADOW_GATE.md` for the original review.

**Scope correction (flagged and explicitly approved before applying):** the task's own migration list named only `0020`/`0021`/`0022`, but production was also missing `0019_match_diagnostics.sql` (a single nullable `ALTER TABLE matching.match_runs ADD COLUMN match_diagnostics JSONB`, guarded, additive). The already-deployed Phase 0-3 codebase writes to this column on **every** `match_runs` insert (not just V2-related ones) — without it, the first real request after deployment would have failed the INSERT outright. Approved and applied as `0019` → `0020` → `0021` → `0022`, in that order.

## 3. Backup / recovery captured before applying

- Latest migration before this rollout: `0018_matching_rf_skeleton.sql`.
- Row counts before: `match_runs` = 7,686, `match_results` = 832.
- Full column snapshot of `matching.match_runs` (the one existing table touched by `0019`) captured via `information_schema.columns` — 24 columns, no `match_diagnostics`, before the change.
- No `pg_dump` available in this environment; not needed given every change is either a guarded `ADD COLUMN` (nullable, trivially reversible) or a brand-new `CREATE TABLE` (nothing pre-existing to lose).
- Exact rollback SQL (see section 11) was written and reviewed *before* applying, not after.

## 4. Migrations applied

Applied one at a time, each in its own transaction (mirroring `src/db/migrate.js`'s own `BEGIN`/apply/insert-into-`schema_migrations`/`COMMIT` pattern), with an explicit verification step after each and an explicit stop-on-failure rule. All four succeeded; no rollback was needed.

| Migration | Applied at (UTC) | Verified |
|---|---|---|
| `0019_match_diagnostics.sql` | 2026-09-24 18:31:33 | `schema_migrations` entry present; `match_runs.match_diagnostics` column exists (nullable JSONB); row count unaffected (in fact grew from 7,686 → 7,688 during verification — proof production kept running undisturbed). |
| `0020_matching_v2_config.sql` | 2026-09-24 18:32:28 | `runtime_settings` = 13 (exact); `intake_rules` = 41 (exact); `config_versions` version 1 exists; version 1 snapshot contains exactly 13 settings + 41 rules; zero `location_*` keys in `runtime_settings`. |
| `0021_matching_v2_config_draft.sql` | 2026-09-24 18:32:50 | `config_draft` table exists; 0 rows (no draft initialized yet — expected, nothing has opened `/settings` in production before this rollout). |
| `0022_matching_v2_shadow_gate.sql` | 2026-09-24 18:33:09 | `shadow_gate_evaluations` table exists; 0 rows immediately after migration (confirmed empty before any traffic arrived). |

Full applied list re-verified after all four: `0000` through `0022`, no gaps, no duplicates.

## 5. Deployment topology

**Both `lead-matching-service` and `dashboard` are running locally**, on the operator's own machine, not on the `176.12.73.12` production host — an explicit decision ("пока что локально", 2026-09-24) rather than an oversight. This works because:

- The SSH tunnel already provides this machine a route to production `devi_db`.
- `telegram-worker` and `whatsapp-worker` (which already run locally on this machine, confirmed via `WORKER_HOST=0.0.0.0`/`WORKER_PORT=8091` in the root `.env`) already had `lead-matching-service`'s webhook URL configured as an **additional** delivery target — `telegram-worker/.env`'s `N8N_TELEGRAM_WEBHOOK_URL` and `whatsapp-worker/.env`'s `WA_MONITOR_WEBHOOK_URL` both list the existing n8n webhook(s) **plus** `http://host.docker.internal:8095/v1/webhooks/{telegram,whatsapp}` — additive, matching `AGENTS.md` §2's "keep existing branches unchanged, add one new branch" rule exactly. This wiring pre-dates this rollout session (found already configured, not created here) and was not modified.
- The moment `lead-matching-service` started listening on `127.0.0.1:8095`, it began receiving the exact same real, live message stream the legacy n8n workflow already receives — genuinely parallel processing with zero changes to the existing delivery targets.

Services, as currently running:

| Service | Where | Address | Notes |
|---|---|---|---|
| `lead-matching-service` | local | `http://127.0.0.1:8095` | `npm start` in `lead-matching-service/`, restarted once (to pick up `TELEGRAM_NOTIFICATIONS_ENABLED=true`, see section 9). |
| `dashboard` | local | `http://127.0.0.1:8094` | A stale pre-Phase-2 instance was found already running (missing `/settings` and `/shadow-gate` entirely) and was replaced with the current code. |
| Postgres tunnel | local → `176.12.73.12` | `127.0.0.1:55432` | Pre-existing, reused as-is. |

Production host `176.12.73.12` itself was **not** modified — no new container, no new systemd unit, no new files written there, beyond the database migrations (section 4). If/when the decision is made to move these services onto that host permanently, `docs/OPERATIONS_ACCESS.md` §3 still has the unanswered questions for that (Docker vs. plain process, restart mechanism) — out of scope for this rollout.

## 6. Smoke-test results

- `GET /health` on `lead-matching-service`: `{"status":"ok","database":"ok","openai":"configured","matcher_version":"lead-matching-service-v1"}`.
- `GET /settings` on `dashboard`: HTTP 200, correctly shows "No pending changes -- this configuration matches version 1 (currently applied)" — confirms the dashboard reads the real, just-applied production config.
- `GET /shadow-gate` on `dashboard`: HTTP 200, rendering real (non-zero, growing) production numbers.
- First real shadow row appeared within seconds of `lead-matching-service` starting: `id=1`, `source_message_id='telegram:-1001368705875:1691429'`, `old_decision='SEND_TO_AI'`, `v2_decision='REJECT'`, real timestamp, real Telegram chat ID shape — not a fabricated/test row.
- `config_version_id` populated (`= 1`) on every non-`DUPLICATE` row; `null` on `DUPLICATE` short-circuit rows, exactly as designed (no config load needed for a pure dedup match).
- `blacklist_hits`/`whitelist_hits`/`property_signal_hits`/`send_to_ai_hits` JSONB fields all validated as well-formed, queryable via `jsonb_array_elements` (used directly for the rule-hit analysis in section 8).
- `disagreement`/`projected_ai_saved`/`projected_ai_added` booleans all reconcile exactly against the raw `old_decision`/`v2_decision` cross-tab (verified in section 8) — no drift between the stored flags and what the formulas in `services/shadow-evaluator.js` would recompute.

## 7. Proof the legacy path remains authoritative

- `lead-matching-service`'s own webhook route is a genuinely **additional** delivery target (section 5) — the two pre-existing n8n webhook URLs in both workers' `.env` files were read, never edited.
- `TELEGRAM_NOTIFICATIONS_ENABLED` in `lead-matching-service/.env` started this rollout as `false` (deliberately set before any real traffic arrived) specifically so the very first hours of parallel processing could not send a single real, broker-facing message from the new pipeline while its behavior was still unverified against real traffic. It was switched to `true` only after ~9 hours of clean parallel operation, on explicit operator instruction (2026-09-25), with the operator informed in advance that a message both systems independently match will now produce two real notifications in the same chat — an accepted, understood tradeoff, not an oversight.
- `matching.shadow_gate_evaluations.v2_decision` is never read by `pipeline.js`'s routing logic (unchanged since Phase 3 — see `docs/MATCHING_V2_PHASE3_SHADOW_GATE.md` §9's grep-based proof, still true: no `v2-intake-gate`/`shadow-evaluator` reference exists anywhere in the live decision path). No new deterministic reject introduced by this rollout can suppress a live message — every one of the 1,180 real `v2_decision='REJECT'` rows observed so far (section 8) still went through the current, unchanged local-parser/triage/AI pipeline exactly as before.
- No `v2_intake_cutover_enabled` (or any Phase 4 concept) exists anywhere in this codebase or this rollout — Phase 4 remains unimplemented (`docs/MATCHING_V2_PHASE4_GATE_CUTOVER.md`, still blocked as of this rollout).

## 8. Live shadow evidence (first ~9 hours, real production traffic)

Window: **2026-09-24 19:30:23 UTC → 2026-09-25 04:15:34 UTC** (~8h45m), 3,252 rows, `telegram` = 3,225 / `whatsapp` = 27.

**Old vs. V2 decision cross-tab** (exact, from `matching.shadow_gate_evaluations`):

| old_decision | v2_decision | count | disagreement | projected_ai_saved | projected_ai_added |
|---|---|---|---|---|---|
| DUPLICATE | DUPLICATE | 2,066 | — | — | — |
| SEND_TO_AI | REJECT | **1,024** | yes | yes | — |
| SEND_TO_AI | SEND_TO_AI | 3 | no | — | — |
| REJECT_WITHOUT_AI | REJECT | 79 | no | — | — |
| PARSED_LOCALLY | REJECT | 41 | no | — | — |
| CACHE_HIT_AI | REJECT | 36 | no | — | — |
| PARSED_LOCALLY | SEND_TO_AI | 1 | yes | — | yes |
| REJECT_WITHOUT_AI | SEND_TO_AI | 1 | yes | — | yes |
| CACHE_HIT_AI | SEND_TO_AI | 1 | yes | — | no (cache hit already paid for once) |

Totals: **disagreement = 1,027**, **projected_ai_saved = 1,024**, **projected_ai_added = 2**. `v2_reason` breakdown (non-`DUPLICATE`, 1,186 rows): `INSUFFICIENT_BUYER_SIGNAL` = 1,123 (94.7%), `BLACKLIST` = 57 (4.8%), `WHITELIST_AND_PROPERTY_SIGNAL` = 6 (0.5%). Zero `SEND_TO_AI_RULE` hits (the `SEND_TO_AI` rule group is intentionally empty since Phase 1 — no operator exception rules have been added).

### Reading this evidence (per the Phase 4 task's own required review categories)

**A. Old SEND_TO_AI → V2 REJECT (1,024 rows, 99.7% of all old AI calls):** this is overwhelmingly the dominant pattern. If V2 were authoritative today, essentially every message the current AI-review path handles would instead be silently rejected without ever reaching AI. `v2_reason` for the large majority of these is `INSUFFICIENT_BUYER_SIGNAL` — the deterministic WHITELIST+PROPERTY_SIGNAL threshold is not being met even for messages the current system's ambiguity-escalation logic considers worth an AI opinion. **This is the single most important finding of this rollout** — see section 9 (PROPERTY_SIGNAL readiness) below.

**B. Old non-AI → V2 SEND_TO_AI (2 rows, `projected_ai_added`):** negligible volume so far — not a cost concern at this sample size.

**C. BLACKLIST disagreements (high priority per the review checklist):** of the 57 real messages the V2 gate would reject as `BLACKLIST`, **7** (12%) were messages the *old* system treated as legitimate enough to reach AI or a local parse (`SEND_TO_AI`=4, `PARSED_LOCALLY`=2, `CACHE_HIT_AI`=1). The actual blacklist rules firing are the expected seller/listing-side patterns (`for sale/rent` heading = 26 hits, Russian seller verbs `продам`/`продаю`/`сдам`/`сдаётся`/etc. = 29 hits combined, `от собственника` = 1, `agents welcome` = 1) — nothing obviously wrong with the *patterns themselves*, but these 7 specific messages warrant a manual look before any future cutover, since a false-positive blacklist hit is exactly the "suppressing a real buyer" risk the review checklist calls out. Not blocking at this volume (7 out of 3,252), but not zero either.

**D. INSUFFICIENT_BUYER_SIGNAL (1,123 rows, the dominant reason):** this is the direct, measured symptom of the PROPERTY_SIGNAL/WHITELIST seed being a "representative extract," not a full port of `triage.js`'s real patterns — a limitation flagged since Phase 1 (`docs/MATCHING_V2_PHASE1_CONFIG.md` §3) and again in Phase 3 (`docs/MATCHING_V2_PHASE3_SHADOW_GATE.md` §11), now confirmed with real production evidence at scale rather than a theoretical concern.

**E. SEND_TO_AI_RULE (explicit exception rule):** zero hits — no rule exists yet in this rule group (intentional, per Phase 1 seed design: "left for product/operator input once the Settings UI exists"). Nothing to review here yet.

## 9. PROPERTY_SIGNAL readiness assessment

**Not ready for Phase 4 cutover.** The live evidence in section 8 is unambiguous: with the current WHITELIST/PROPERTY_SIGNAL rule set, cutting V2 over today would silently reject ~99.7% of the messages the current system considers worth an AI opinion, via `INSUFFICIENT_BUYER_SIGNAL`. This would almost certainly cause severe false-negative buyer-request loss, not a moderate AI-cost optimization.

Per the Phase 4 task's explicit instruction — *"Do NOT compensate by inventing broad hardcoded heuristics... Update rules/configuration only through the existing Phase 2 configuration mechanism if the required corrections are obvious and evidence-backed. If a business-rule decision is required, report it instead of guessing."* — **no rule tuning was performed as part of this rollout.** This finding is reported, not silently fixed, both because rule content is a business decision and because this task's own instructions explicitly excluded "tune intake rules" and "apply any Settings configuration changes" from its scope.

**Recommended next step (separate task):** review a sample of the 1,024 `SEND_TO_AI → REJECT` messages (queryable by `source_message_id` from `matching.shadow_gate_evaluations`, cross-referenced with `matching.match_runs.original_text` from Phase 3's design) to determine which real, genuine buyer-intent phrasings are not covered by the current 16 WHITELIST + 9 PROPERTY_SIGNAL rules, and expand the rule set through the Phase 2 Settings UI (`/settings`) before reconsidering Phase 4.

## 10. Monitoring queries

**Last 24h summary:**

```sql
SELECT
  count(*) AS total,
  count(*) FILTER (WHERE disagreement) AS disagreements,
  count(*) FILTER (WHERE projected_ai_saved) AS projected_ai_saved,
  count(*) FILTER (WHERE projected_ai_added) AS projected_ai_added
FROM matching.shadow_gate_evaluations
WHERE created_at >= now() - interval '24 hours' AND backfilled = false;
```

**v2_reason distribution (last 24h):**

```sql
SELECT v2_reason, count(*) FROM matching.shadow_gate_evaluations
WHERE created_at >= now() - interval '24 hours' AND v2_decision <> 'DUPLICATE'
GROUP BY 1 ORDER BY 2 DESC;
```

**config_version distribution (last 24h) — should be a single value unless an Apply happened:**

```sql
SELECT config_version_id, count(*) FROM matching.shadow_gate_evaluations
WHERE created_at >= now() - interval '24 hours'
GROUP BY 1 ORDER BY 1;
```

**Shadow-evaluator errors (non-blocking by design, but worth watching):** `lead-matching-service` logs a `shadow_gate_failed` event on any shadow-path failure (config load, gate exception, DB insert) — grep the running process's stdout/log sink for `"event":"shadow_gate_failed"`. None observed during this rollout's first ~9 hours.

**Live service errors / latency:** `GET http://127.0.0.1:8095/health` (should stay `{"status":"ok",...}`); Fastify's own request logs (pino, JSON lines) include `responseTime` per request — watch for a sustained increase after the shadow-gate wiring, though none was observed (shadow evaluation is a single indexed INSERT after the real response is already being returned).

**Dashboard view:** `/shadow-gate` (period tabs 24h/7d/30d/all) for the same numbers in human-readable form; `/settings` to confirm the active config version hasn't silently changed.

## 11. Rollback

**Application:** stop the local `lead-matching-service`/`dashboard` processes (or, if this ever moves to a real deploy target, redeploy pre-Phase-3 code). Stopping `lead-matching-service` immediately and completely removes it as a message consumer — `telegram-worker`/`whatsapp-worker` will simply get a failed delivery to that one URL (their existing retry/queue behavior handles this; the other two webhook targets are unaffected) and legacy processing continues exactly as before, since it was never touched.

**Fastest partial rollback (keep the service up, stop only the visible side effect):** set `TELEGRAM_NOTIFICATIONS_ENABLED=false` in `lead-matching-service/.env` and restart — stops new duplicate broker messages within seconds, while shadow telemetry keeps accumulating.

**Database (only if the additive tables cause a concrete problem — not expected, and not performed here):**

```sql
-- reverse order of application
DROP TABLE IF EXISTS matching.shadow_gate_evaluations;
DELETE FROM matching.schema_migrations WHERE filename = '0022_matching_v2_shadow_gate.sql';

DROP TABLE IF EXISTS matching.config_draft;
DELETE FROM matching.schema_migrations WHERE filename = '0021_matching_v2_config_draft.sql';

DROP TABLE IF EXISTS matching.intake_rules;
DROP TABLE IF EXISTS matching.runtime_settings;
DROP TABLE IF EXISTS matching.config_versions;
DELETE FROM matching.schema_migrations WHERE filename = '0020_matching_v2_config.sql';

ALTER TABLE matching.match_runs DROP COLUMN IF EXISTS match_diagnostics;
DELETE FROM matching.schema_migrations WHERE filename = '0019_match_diagnostics.sql';
```

Not executed — no failure occurred that would warrant it. `0019`'s column is now relied upon by every `match_runs` insert from the current codebase, so rolling it back would require rolling back the application code first.

## 12. Recommended observation window

At least **1-2 weeks of continuous real traffic** before reconsidering Phase 4, for two independent reasons:

1. **Volume:** ~3,250 rows in 9 hours is a reasonable start, but the BLACKLIST-disagreement review (7 cases) and rare `SEND_TO_AI_RULE`/edge-case categories need more samples to be confident they're not one-off flukes.
2. **Rule-set correction cycle:** section 9's finding (PROPERTY_SIGNAL/WHITELIST coverage gap) needs to actually be fixed through `/settings` first, and then needs its *own* fresh observation window (at least a few days) after the fix, to confirm the correction actually closes the gap without overcorrecting into false-positive AI spend.

## 13. Exact condition for re-running Phase 4

Phase 4 should not be reconsidered until **all** of the following are true:

1. The PROPERTY_SIGNAL/WHITELIST rule-coverage gap (section 9) has been addressed through the Phase 2 Settings UI, based on a manual review of real disagreement samples — not guessed.
2. A fresh observation window (section 12) after that correction shows the `SEND_TO_AI → REJECT` disagreement rate has dropped to a level where an operator is comfortable it reflects genuine "not worth AI" traffic, not lost buyers.
3. The 7 BLACKLIST-disagreement messages from this window (and an equivalent fresh sample after the rule fix) have been manually reviewed and confirmed to be correctly classified.
4. `sourceContext.disabled` wiring (Phase 3's own known limitation) is either wired to a real per-source signal or explicitly re-confirmed as out of scope for the specific sources currently live.
5. Explicit operator sign-off, per this project's standing "no Phase 4 without review" rule.

None of these are met yet as of this document.
