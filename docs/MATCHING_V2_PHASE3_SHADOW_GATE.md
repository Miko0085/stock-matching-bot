# Nika Matching V2 — Phase 3: Deterministic Intake Shadow Gate

**Status:** Phase 3 output (`AGENTS_NIKA_MATCHING_V2.md`, section 26, Phase 3).
**Runtime impact:** none on live routing decisions. For every real message the current UAE `lead-matching-service` intake path processes, this phase additionally computes what the future deterministic V2 gate WOULD decide and persists it for comparison — it never influences AI usage, local parsing, matching, statuses, or notifications. Proof in section 9.

## 1. Shadow architecture

Three new modules plus one additive migration, wired at a single choke point:

```
lead-matching-service/src/gates/v2-intake-gate.js        pure, deterministic, DB-free, AI-free gate
lead-matching-service/src/repositories/shadow-repository.js  thin INSERT-only persistence
lead-matching-service/src/services/shadow-evaluator.js    orchestrator: old-decision normalization,
                                                           disagreement classification, calls the gate,
                                                           calls the repository
sql/migrations/0022_matching_v2_shadow_gate.sql           matching.shadow_gate_evaluations
```

Wiring:

- `lead-matching-service/src/api/server.js` builds a cached `getActiveV2Config` (the same generic TTL-bounded `createAliasCache` factory already used for the alias/canonical-registry caches, 60s TTL) and assigns `deps.evaluateShadowGate = evaluateShadowGate` **after** `deps` is constructed (a deliberate self-referencing closure — `evaluateShadowGate` itself takes `deps` as an argument and reads `deps.pool`/`deps.getActiveV2Config()`).
- `lead-matching-service/src/services/pipeline.js`'s `finish()` closure — the single point every exit path of `runWebhookPipeline`/`processClaimedWebhook` already funnels through — is now `async` and, right after `deps.logEvent?.(log)`, does one guarded, try/caught, **awaited-but-never-assigned** call: `if (deps.evaluateShadowGate) { try { await deps.evaluateShadowGate({ unifiedMessage, log, deps }); } catch (err) { deps.logEvent?.({ event: 'shadow_gate_failed', ... }); } }`. The call's return value is never read; `finish()` always returns the real `result` object it was given, untouched.

No other file was given a shadow-gate call site. Instrumenting one choke point instead of every individual `return finish(...)` call was a deliberate simplification — every one of those call sites already passes through `finish()`.

## 2. Old-vs-V2 decision mapping (`shadow-evaluator.js`)

`normalizeOldDecision(log)` maps the real pipeline's already-computed `log` fields onto a small comparable vocabulary. This extends the spec's suggested 5-value list (`SEND_TO_AI, REJECT_WITHOUT_AI, PARSED_LOCALLY, DUPLICATE, ERROR`) with two values needed for correctness:

| Condition on `log` | `old_decision` | Why |
|---|---|---|
| `event_duplicate` or `duplicate` | `DUPLICATE` | real dedup already fired |
| `parser_error_reason` present | `ERROR` | AI was attempted and failed |
| `triage_decision === 'REJECT'` | `REJECT_WITHOUT_AI` | a deterministic, local, never-fully-parsed reject (e.g. `broker_solicitation`, `*_inventory_ad`) — kept **distinct** from `PARSED_LOCALLY` so the dashboard breakdown (section 10 of the spec) can tell them apart, even though both are equally non-AI for the cost math |
| `interpretation_source === 'ai'` | `SEND_TO_AI` | a **fresh** AI call actually happened this request |
| `interpretation_source === 'cache_ai'` | `CACHE_HIT_AI` | reused a prior AI result — **zero incremental AI cost** this time. Deliberately not the same bucket as `SEND_TO_AI`, or the projected-savings metric would double-count |
| `interpretation_source === 'local'`/`'cache_local'` | `PARSED_LOCALLY` | a real local parse (triage.js's `PARSED_LOCALLY` branch, or a cache hit of one) |
| none of the above | `UNKNOWN` | should not happen; never silently dropped |

`log.triage_decision`, `log.no_match_reason`, `log.interpretation_source`, `log.event_duplicate`, `log.duplicate`, and `log.parser_error_reason` all already existed or are set by `pipeline.js` before `finish()` runs — the only new line added per branch is `log.interpretation_source = interpretationSource;` at the 4 points where that local variable is first assigned (cache hit, triage `REJECT`, triage `PARSED_LOCALLY`, AI success/failure), so the value is visible to `finish()`'s closure.

`old_reason` is `log.no_match_reason` for `REJECT_WITHOUT_AI` (the exact triage reason, e.g. `broker_solicitation`) and a short fixed string otherwise — informational only, never used in disagreement math.

## 3. Rule precedence (`gates/v2-intake-gate.js`)

Pure, deterministic, side-effect-free (no DB, no AI, no network). Given `{ message, sourceContext, runtimeSettings, intakeRules }`:

```
if sourceContext.disabled                          -> REJECT / SOURCE_DISABLED
else if any enabled BLACKLIST rule matches          -> REJECT / BLACKLIST
else if any enabled SEND_TO_AI rule matches         -> SEND_TO_AI / SEND_TO_AI_RULE
else if whitelist_hits >= whitelist_threshold
     AND property_signal_hits >= property_signal_threshold
                                                     -> SEND_TO_AI / WHITELIST_AND_PROPERTY_SIGNAL
else                                                 -> REJECT / INSUFFICIENT_BUYER_SIGNAL
```

`PHRASE` = case-insensitive literal substring match. `REGEX` = compiled with the `iu` flags and tested against the **original** (unlowered) text; a malformed pattern fails safe (never matches, never throws) — defense-in-depth, since Phase 2's `validateRegexSyntax` already prevents one from being saved. A disabled rule never participates. Priority is stored but does not change correctness — every enabled matching rule counts as a hit regardless of order.

`sourceContext.disabled` is **not** wired to any real signal today — the current UAE intake path has no per-source enable/disable check in its live decision flow, so this is always `false` in practice (documented limitation, section 12).

Event/content dedup is **not** part of this pure function by design (spec: "do not query PostgreSQL inside this pure evaluation function"). The orchestrator already knows the real dedup outcome for free and short-circuits before ever calling the gate — see section 4.

## 4. Config version attribution

`loadActiveV2Config(pool)` (`config-repository.js`) reads the **currently applied** (never draft, never historical) `matching.runtime_settings` + `matching.intake_rules` + the current `matching.config_versions` row, cached process-wide with a 60s TTL. Every non-`DUPLICATE` shadow row records the exact `config_version_id` that produced it (`matching.shadow_gate_evaluations.config_version_id`, `REFERENCES matching.config_versions(id)`), so a later `Apply` in the Phase 2 Settings UI can never retroactively change what an old shadow row is attributed to.

Verified directly (integration test `shadow-gate.integration.test.js`, "draft config edits do NOT affect the shadow result"): editing a setting in the Phase 2 **draft** and re-evaluating the shadow gate produces the same result as before the edit; only after `applyDraft()` does the next shadow evaluation see the new value and record the new `config_version_id`.

A `DUPLICATE` short-circuit (section 5) never loads config at all — `config_version_id` is `null` for those rows, which is correct: no gate computation happened, so no version is "responsible" for the decision.

## 5. Persistence schema (`matching.shadow_gate_evaluations`, migration 0022)

Additive-only table, no existing schema touched. Columns: `id`, `source_message_id`, `provider`, `account_id`, `chat_id`, `sender_id`, `message_text_hash` (identity/join fields — no raw message text duplicated; joins back to `match_runs.original_text` via `source_message_id` if ever needed), `old_decision`, `old_reason`, `v2_decision`, `v2_reason`, `blacklist_hits`/`whitelist_hits`/`property_signal_hits`/`send_to_ai_hits` (JSONB arrays of the **full matched rule objects**, embedding `id`/`rule_group`/`pattern`/`description` as of the moment they matched — no join to `intake_rules` needed later, and historically correct even if a rule is later edited or deleted), `whitelist_threshold`, `property_signal_threshold`, `config_version_id` (FK, nullable), `disagreement`/`projected_ai_saved`/`projected_ai_added` (booleans), `backfilled` (false for every row produced by live instrumentation — see section 12), `created_at`. Indexes on `created_at DESC`, `source_message_id`, and a partial index on `disagreement = true`.

## 6. Disagreement semantics (`computeDisagreement`)

```
oldWasAi = old_decision === 'SEND_TO_AI'
v2WasAi  = v2_decision === 'SEND_TO_AI'

projected_ai_saved = oldWasAi && !v2WasAi
projected_ai_added = !oldWasAi && old_decision !== 'CACHE_HIT_AI' && v2WasAi
disagreement       = oldWasAi !== v2WasAi
```

`CACHE_HIT_AI` is excluded from `projected_ai_added`: that content already paid for one AI call (that is what made it cacheable); V2 sending the same content to AI again is not *new* incremental cost. It is still counted in `disagreement` (the broad AI-or-not outcome does differ), just not double-counted as "added" spend. `REJECT_WITHOUT_AI` and `PARSED_LOCALLY` behave identically in this formula — both non-AI — the distinction between them only matters for the dashboard breakdown (section 10), not the cost math.

## 7. Failure isolation

- The `evaluateShadowGate()` call in `finish()` is wrapped in its own `try/catch`; any failure (config-load error, DB insert error, an unexpected exception inside the gate) is logged as a `shadow_gate_failed` event and **swallowed** — `finish()` still returns the real, already-computed `result`.
- `deps.evaluateShadowGate` is optional (`if (deps.evaluateShadowGate)`) — every existing test-built `deps` object that predates Phase 3 still works unmodified; shadow evaluation is simply absent for those.
- Verified directly (integration test "a shadow config-load failure never breaks the real pipeline result"): `getActiveV2Config` is made to throw, and the real webhook request still returns its correct `REJECTED` result, with a `shadow_gate_failed` log line as evidence the failure was observed, not hidden.

## 8. Dashboard metrics (`dashboard/shadow-queries.js` + `dashboard/shadow-view.js`, new `/shadow-gate` page)

24h/7d/30d period tabs (same rolling-interval convention as the existing Summary page — `PERIODS`/`resolvePeriodStart` are imported, not reimplemented). All aggregates exclude `backfilled = true` rows.

- **Projected AI impact:** evaluated count, old (fresh) AI calls, V2 would-send-to-AI count, projected saved/added, `net_projected_ai_change = v2_send_to_ai_count - old_send_to_ai_count`, `projected_ai_reduction_pct = (old_send_to_ai_count - v2_send_to_ai_count) / old_send_to_ai_count * 100` (null when the denominator is 0 — never `NaN`/`Infinity`, verified by a render test and a zero-rows integration test), agreement rate, disagreement count.
- **Disagreement breakdown**, all 7 spec-required categories, each derived from existing columns (no new schema, no fabricated metric): Old `SEND_TO_AI` → V2 `REJECT`; Old `REJECT_WITHOUT_AI` → V2 `SEND_TO_AI`; Old `PARSED_LOCALLY` → V2 `SEND_TO_AI`; Blacklist disagreement (`v2_reason='BLACKLIST'`); Missing whitelist signal (`v2_reason='INSUFFICIENT_BUYER_SIGNAL'` with a property-signal hit but no whitelist hit); Missing property signal (the mirror case); SEND_TO_AI exception rule hit (`v2_reason='SEND_TO_AI_RULE'`).
- **Rule hit analytics:** hit counts per rule (extracted from the embedded hit-array JSONB across all 4 hit columns via `jsonb_array_elements` — no join to `intake_rules`), plus how many of those messages were old `SEND_TO_AI` vs. V2 `SEND_TO_AI`. The spec's "how many became AI-confirmed buyer later" sub-metric is **deliberately not implemented** — see section 12.

A persistent banner states: *"Shadow mode only: the V2 gate below is NOT wired into live routing yet... Runtime cutover happens in a later phase."*

## 9. Proof live routing remains unchanged

```
$ grep -rln "v2-intake-gate\|shadow-evaluator\|shadow-repository" --include="*.js" lead-matching-service/src dashboard \
    | grep -v "/gates/v2-intake-gate.js\|/services/shadow-evaluator.js\|/repositories/shadow-repository.js"
lead-matching-service/src/api/server.js        <- wiring only (assigns deps.evaluateShadowGate)
lead-matching-service/src/repositories/config-repository.js   <- a doc COMMENT, no code reference
dashboard/shadow-queries.js                    <- dashboard read-only analytics, a separate process
```

`pipeline.js`'s only reference is the single `if (deps.evaluateShadowGate) { try { await deps.evaluateShadowGate(...); } catch {...} }` block inside `finish()` — the call's return value is **never assigned to a variable**, never read, never branched on. `finish()`'s own `result` parameter (the real, already-fully-decided outcome) is untouched before and after that block and is what gets returned. `triage.js`, `matcher.js`, `openai-client.js`, and every AI/notification/status-setting code path in `pipeline.js` are byte-for-byte unchanged from Phase 2 except for the 4 added `log.interpretation_source = ...` lines (pure logging, read by nothing except the shadow path) and `finish` becoming `async` (a no-op change for every existing caller, since `return finish(...)` inside an already-`async` function correctly awaits the returned promise either way).

## 10. Tests / results

- **New pure-gate unit tests** (`lead-matching-service/tests/unit/v2-intake-gate.test.js`, 18 cases): every precedence rule from section 3, both match types, malformed-regex fail-safe, disabled-rule exclusion, priority-independence, multiple hits, missing-settings defaults.
- **New orchestrator unit tests** (`lead-matching-service/tests/unit/shadow-evaluator.test.js`, 16 cases): every `normalizeOldDecision`/`computeDisagreement` mapping from sections 2 and 6, plus the `DUPLICATE` short-circuit (proves zero config loads, zero gate calls) and a non-duplicate path with a fake repository.
- **New integration tests** (`lead-matching-service/tests/integration/shadow-gate.integration.test.js`, 6 cases, real Postgres): shadow persistence + config-version attribution; `projected_ai_added` correctness including the `CACHE_HIT_AI` exclusion; draft-vs-applied config isolation (edits a draft setting, confirms no effect, applies it, confirms the next evaluation picks it up with a new version id); the `DUPLICATE` short-circuit; a full real `/v1/webhooks/telegram`-shaped `runWebhookPipeline()` call proving the real result is unchanged AND a correct shadow row is persisted; a simulated shadow config-load failure proving the real result still returns correctly.
- **New dashboard tests**: `tests/unit/shadow-view.test.js` (8 cases — zero-denominator safety, all 7 breakdown categories render, empty-state, deferred-metric note) and `tests/integration/shadow-queries.test.js` (5 cases, real Postgres — summary math reconciliation, backfilled-row exclusion, all 7 disagreement categories counted independently, rule-hit aggregation across all 4 hit-array columns).
- **Live end-to-end wiring proof** (manual, this session): ran the existing lead-matching-service integration suite (which exercises `buildServer()` with no overrides, i.e. the real production wiring) against a disposable Postgres and confirmed real `matching.shadow_gate_evaluations` rows were persisted for the two real `/v1/webhooks/telegram` test requests, correctly attributed to config version 1, with the tests' own assertions on the *live* `REJECTED`/`MATCH` results still passing unchanged.

Full suite results (all runs against a real disposable Postgres, never skipped):

| Suite | Result |
|---|---|
| root `test:unit` | **231/231** pass (+8: `shadow-view.test.js`) |
| root `test:contracts` | **19/19** pass (unchanged) |
| root `test:integration` | **48/48** pass (+5: `shadow-queries.test.js`) |
| lead-matching-service `test:unit` | **317/317** pass (+34: `v2-intake-gate.test.js` + `shadow-evaluator.test.js`) |
| lead-matching-service `test:integration` | **63/63** pass (+6: `shadow-gate.integration.test.js`) |

## 11. Known limitations

- `sourceContext.disabled` is never set to `true` today — no per-source enable/disable signal exists in the current UAE intake path's live decision flow. The gate's shape already supports it (section 3) for when that signal exists.
- The "how many rule-hit messages later became an AI-confirmed buyer" sub-metric from the spec is not implemented: `shadow_gate_evaluations` rows are not linked to a `match_runs.id` (only a content-only text hash, not unique enough for a safe join — the same phrase reposted by unrelated senders would collide). Documented here rather than fabricated from an unsound join; can be revisited if/when a reliable link is added.
- PROPERTY_SIGNAL's Phase 1 seed remains a representative extract of `triage.js`'s real patterns (documented in `docs/MATCHING_V2_PHASE1_CONFIG.md` §3), unaffected by Phase 3 — worth revisiting before any real Phase 4 cutover.
- The 60s config cache TTL means a config `Apply` can take up to a minute to be reflected in new shadow evaluations. Acceptable because this only feeds shadow telemetry, never a live decision.
- Historical backfill (spec section 16) was **not implemented** — it is explicitly optional, and live shadow instrumentation (mandatory) already gives a growing, statistically meaningful comparison window without touching the fixed `BASELINE_CUTOFF_UTC` or making any retroactive AI calls. The `backfilled` column exists in the schema and is honored by every query (excluded from aggregates) so this remains a pure additive step later if wanted.

## 12. Deployment prerequisites

- Migration `0022_matching_v2_shadow_gate.sql` must be applied before this code is deployed (it will be picked up automatically by the existing migration runner's auto-discovery — no manual step beyond the normal deploy sequence).
- Requires migrations `0020`/`0021` (Phase 1/1.1/2's config tables) to already exist and be seeded — `loadActiveV2Config()` will simply return empty settings/rules otherwise, and the gate would then reject everything as `INSUFFICIENT_BUYER_SIGNAL`/no thresholds met. Harmless for shadow-only purposes (still correctly recorded, just not meaningful), but worth confirming Phase 1/1.1/2 are live first.
- No production deploy has happened as part of Phase 3 — per the standing constraint, this remains a local/branch change until explicitly approved.

## 13. Rollback instructions

Local: `git revert <phase-3-commit-sha>`.

Database (only relevant once actually deployed somewhere — this branch has not been deployed to production):

```sql
DROP TABLE IF EXISTS matching.shadow_gate_evaluations;
DELETE FROM matching.schema_migrations WHERE filename = '0022_matching_v2_shadow_gate.sql';
```

Nothing else references `shadow_gate_evaluations` — dropping it only removes the `/shadow-gate` dashboard page's data source (the page itself would need its route removed too, or it will show empty/zero data safely rather than error, since every query already handles zero rows). Migrations `0020`/`0021` are untouched and remain independently rollbackable per their own docs. `deps.evaluateShadowGate` failing open (section 7) means even leaving the code deployed with the table dropped would not break live traffic — every shadow call would fail, log `shadow_gate_failed`, and the real pipeline would proceed exactly as before.

## 14. Phase 4 cutover prerequisites

Before any future phase makes `evaluateV2IntakeGate()` authoritative:

1. A meaningful live shadow window (the spec's own target: enough real traffic to trust the projected-AI-reduction numbers on `/shadow-gate`, not a handful of test rows).
2. Disagreement review: every category in section 8/10's breakdown should be examined by an operator at least once — in particular any `SEND_TO_AI` → `REJECT` disagreement represents a request the old system sent to AI that V2 would silently drop, which needs eyes-on before trusting it in production.
3. PROPERTY_SIGNAL rule completeness revisited (known limitation, section 11) — a shadow gate running on an intentionally-partial seed will under-count `WHITELIST_AND_PROPERTY_SIGNAL` hits relative to a fully-ported rule set.
4. `sourceContext.disabled` wired to a real per-source signal if source-level routing is meant to matter before cutover (currently always `false`).
5. Explicit approval per the contract's "no Phase 4 without review" discipline — this document, plus the `/shadow-gate` dashboard's own numbers, is the input to that review, not a decision made here.
