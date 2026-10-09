# Nika Matching V2 — Phase 4: Controlled V2 Intake Gate Cutover

**Status:** implemented and tested on branch `feature/simplify-matching-v2`. **NOT activated in production.** Migration `0023` and this code are deployment-ready; `v2_intake_cutover_enabled` defaults to `false` everywhere, including after this migration runs, so deploying this code changes zero live behavior until an operator explicitly Applies a config version that turns it on (section 9).

This supersedes an earlier version of this document that recorded Phase 4 as blocked pending live shadow evidence. That evidence now exists: `docs/MATCHING_V2_PHASE3_PRODUCTION_SHADOW_ROLLOUT.md` documents production migration/deployment, and `docs/MATCHING_V2_PHASE35_GATE_CALIBRATION.md` documents the offline calibration that produced this phase's recommended emergency configuration.

## 1. Migration (`sql/migrations/0023_matching_v2_gate_cutover.sql`)

Additive only; does not edit migrations 0020–0022. Three independent changes:

1. **`matching.shadow_gate_evaluations.mode`** — `TEXT NOT NULL DEFAULT 'SHADOW'`, `CHECK (mode IN ('SHADOW','AUTHORITATIVE','FALLBACK'))`. Every pre-existing row (all of Phase 3's shadow-only history) is correctly backfilled to `'SHADOW'` by the column default — no historical row is reinterpreted or rewritten.
2. **`old_decision` becomes nullable** (`ALTER COLUMN ... DROP NOT NULL`) — a safe, backward-compatible widening. An `AUTHORITATIVE` row has no "old decision" to record (legacy triage never ran for it), so this must be representable; every existing row already has a non-null value and is unaffected.
3. **Two new `runtime_settings` rows**, seeded via the same version-bump mechanism a real operator Apply would produce (re-stamps every existing setting/rule to the new version, then inserts the two new rows, then rebuilds the version's snapshot from the real tables — never a hand-duplicated literal):
   - `v2_intake_cutover_enabled` (`boolean`, default `'false'`)
   - `buyer_signal_policy` (`text`, default `'REQUIRE_BOTH'`)

   Plus a structural `CHECK` constraint (`runtime_settings_buyer_signal_policy_check`) rejecting any `buyer_signal_policy` value other than `REQUIRE_BOTH`/`REQUIRE_ANY` directly at the database level — the same two-independent-layers philosophy as the `location_*` structural lock from Phase 1.1.

`ai_intake_gate_enabled` (an existing Phase 1 setting) is untouched and is **not** reinterpreted as the cutover flag — verified by an explicit integration test.

## 2. New runtime settings

| Key | Type | Default | Meaning |
|---|---|---|---|
| `v2_intake_cutover_enabled` | boolean | `false` | OFF: Phase 3 shadow-only behavior. ON: the V2 gate becomes authoritative for AI eligibility. |
| `buyer_signal_policy` | text (`REQUIRE_BOTH` \| `REQUIRE_ANY`) | `REQUIRE_BOTH` | How WHITELIST/PROPERTY_SIGNAL threshold checks combine, in both shadow and authoritative evaluation. |

Both participate fully in the existing Phase 2 control plane: Draft → Apply, validation (`config-validation.js`'s `KNOWN_SETTING_KEYS` + an explicit `buyer_signal_policy` enum check), config snapshots, version history, and rollback — no separate mechanism was introduced.

## 3. Settings UI

A new, clearly separated section, **"V2 Intake Gate — Live Cutover"**, inserted immediately after "Buyer Candidate Gate" (`dashboard/settings-view.js`'s `renderCutoverSection`):

- **A. Live cutover** — a toggle for `v2_intake_cutover_enabled`, with a dynamic banner: a green "cutover is OFF" banner when off, or a red "V2 gate is controlling which messages may reach AI" banner when on.
- **B. Buyer signal policy** — a dropdown for `buyer_signal_policy` with human-readable option labels ("Require whitelist AND property signal" / "Require whitelist OR property signal"). Selecting `REQUIRE_ANY` shows the exact warning text specified: *"Emergency permissive mode: reduces false-negative buyer risk but allows more noisy traffic into AI."*

Both controls go through the existing Draft → Apply workflow — there is no direct/instant toggle anywhere on this page, matching every other setting.

## 4. Gate logic (`lead-matching-service/src/gates/v2-intake-gate.js`)

```
if blacklist hit                         -> REJECT / BLACKLIST
else if explicit SEND_TO_AI rule hit     -> SEND_TO_AI / SEND_TO_AI_RULE
else if buyer_signal_policy == REQUIRE_BOTH:
    whitelist >= threshold AND property_signal >= threshold -> SEND_TO_AI / WHITELIST_AND_PROPERTY_SIGNAL
    else -> REJECT / INSUFFICIENT_BUYER_SIGNAL
else if buyer_signal_policy == REQUIRE_ANY:
    whitelist >= threshold OR property_signal >= threshold  -> SEND_TO_AI / WHITELIST_OR_PROPERTY_SIGNAL
    else -> REJECT / INSUFFICIENT_BUYER_SIGNAL
else:
    THROWS (unrecognized policy) -- never silently guesses AND or OR
```

Precedence (blacklist first, explicit SEND_TO_AI rule second) is identical and policy-independent — verified by tests. An unrecognized `buyer_signal_policy` value is a defensive throw, not a silent fallback to either combination rule; the DB `CHECK` constraint (section 1) and application validation (section 2) both already prevent this value from ever being written, so this throw path exists purely as defense-in-depth against a corrupted/manually-edited row.

## 5. Cutover OFF behavior (default, unchanged from Phase 3)

Verified unchanged, byte-for-byte: legacy local-parser/triage decides AI eligibility exactly as before; the V2 gate still evaluates in shadow mode (`mode = 'SHADOW'`) via the existing `evaluateShadowGate`; a V2 shadow `REJECT` can never suppress the real AI call a legacy `AI_REVIEW` decision makes.

## 6. Cutover ON behavior

When `v2_intake_cutover_enabled = true`, `pipeline.js`'s cache-miss branch calls `evaluateAuthoritativeGate()` **before** local triage ever runs:

- **Gate REJECT** (any reason) → the message is persisted as `REJECTED` with reason `v2_gate_<lowercased reason>` (e.g. `v2_gate_blacklist`, `v2_gate_insufficient_buyer_signal`) and the request returns immediately. Local triage/parser and the AI interpreter are **never invoked** for this message.
- **Gate SEND_TO_AI** → local triage's own eligibility decision is bypassed entirely; the message is routed straight to the existing, unmodified AI interpreter (`callAiInterpreter()`, a helper extracted so the legacy `AI_REVIEW` branch and this authoritative branch share byte-identical AI-calling/caching/usage-logging code — no prompt, model, retry policy, or schema change).
- A single `mode = 'AUTHORITATIVE'` telemetry row is recorded per request, with `old_decision = NULL` (legacy never ran) and exact `config_version_id` attribution.

## 7. AI zero-call proof

`lead-matching-service/tests/unit/pipeline-cutover.test.js` spies directly on `classifyAndParse` (never inferring AI usage from the result status alone, per the explicit test requirement):

- `cutover ON, gate says REJECT: AI invocation count = 0` — asserts `aiSpy.calls.length === 0`.
- `cutover ON, gate says REJECT: local triage/parser never runs either` — asserts the alias-index loader (needed only by local triage) is never called either, proving the bypass is complete, not just AI-specific.
- `cutover ON, gate says SEND_TO_AI: the existing AI interpreter is actually invoked` — asserts `aiSpy.calls.length === 1` and that the persisted `triageDecision` is `null` (confirming legacy triage was skipped, not merely overridden).

## 8. Fail-safe fallback

Every step of the authoritative path — `deps.getActiveV2Config()`, `evaluateV2IntakeGate()` (including an unrecognized-policy throw), and any other dependency failure — is wrapped in one `try/catch` in `pipeline.js`. On any failure:

1. The error is logged as `V2_GATE_ERROR_FALLBACK`.
2. A best-effort `mode = 'FALLBACK'` telemetry row is recorded (`recordGateFallback()`) — itself wrapped so a telemetry INSERT failure can never break the live path.
3. Execution falls through to the **exact, unmodified legacy triage path** — the same code that runs when cutover is off entirely.

A telemetry INSERT failure inside a *successful* gate evaluation (config loaded fine, gate decided fine, only the `INSERT` into `shadow_gate_evaluations` failed) is handled separately and does **not** trigger a fallback: the already-correct gate decision is still honored, and only the telemetry-insert failure is logged (`shadow_telemetry_insert_failed`) — per the explicit requirement "telemetry persistence error does not lose message," which is a stronger, more precise guarantee than a generic fallback would provide (a fallback here would *change* an already-correct decision for no reason).

Tested explicitly: config-load failure → legacy path (AI still reachable when legacy triage says so); gate-evaluation failure → legacy path; a *simultaneous* `recordGateFallback` failure → the live message still completes normally.

## 9. Config coherence and caching

`loadActiveV2Config()` (`config-repository.js`) was hardened in this phase: the three reads it bundles (settings, rules, current version) now run inside one `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction instead of three independent `pool.query()` calls. Previously, an operator's Apply committing mid-read could theoretically produce settings from version N paired with rules from version N+1; this is now provably impossible — all three reads observe one consistent database snapshot. Every authoritative and shadow evaluation records the exact `config_version_id` that produced it. The existing 60-second TTL cache (`createAliasCache`, unchanged from Phase 3) is the "documented bounded time" within which an Apply/Rollback becomes visible to new evaluations — acceptable because worst case is a 60-second-old *shadow* view; the coherence fix above is what actually matters for authoritative correctness, not the cache TTL.

## 10. Telemetry mode

`shadow_gate_evaluations.mode` distinguishes `SHADOW` (Phase 3 behavior, `old_decision` populated, never authoritative), `AUTHORITATIVE` (cutover was on, this row's `v2_decision` was the real live decision, `old_decision` is `NULL`), and `FALLBACK` (cutover was on but gate infrastructure failed; legacy processed the message instead). Historical Phase 3 rows are unambiguously `SHADOW` via the column default — no row was rewritten. `dashboard/shadow-queries.js`'s existing `getShadowSummary`/`getDisagreementBreakdown`/`getRuleHitAnalytics` are now explicitly scoped to `mode = 'SHADOW'` (previously implicit) to keep the PROJECTED view meaningful once `AUTHORITATIVE`/`FALLBACK` rows exist alongside shadow ones.

## 11. Dashboard changes (`/shadow-gate`)

- A new **Telemetry Mode** panel shows SHADOW/AUTHORITATIVE/FALLBACK counts for the period, with an automatic warning banner when FALLBACK is non-zero.
- A new **Actual Live Gate Behavior** panel (shown once any `AUTHORITATIVE` rows exist, or cutover is currently on) reports: evaluated, V2 SEND_TO_AI, V2 deterministic rejects, blacklist rejects, insufficient-signal rejects, fresh AI calls, AI cache hits (both joined reliably to `matching.match_runs` by `source_message_id`, not a content hash), fallback count, the active `buyer_signal_policy`, and the current config version — explicitly labeled ACTUAL, distinct from the existing PROJECTED shadow summary.
- The page's own top banner is now dynamic: it states plainly whether cutover is currently on or off, with a direct link to the Settings toggle.

No cost figure is fabricated where the underlying join cannot support it (unchanged discipline from Phase 3's deferred AI-confirmed-buyer metric).

## 12. Source-disabled handling (unchanged limitation, explicitly not solved here)

`sourceContext.disabled` remains unwired in both shadow and authoritative evaluation — the current UAE intake path has no live per-source enabled/disabled signal reaching `pipeline.js`, and wiring one would mean querying the separate `ingest.sources`/`source_routes` registry from Phase 0, which this phase deliberately did not build a second copy of. Per this phase's own explicit instruction, this is documented as an accepted, out-of-scope limitation rather than pretended to be solved. `SOURCE_DISABLED` is not a code path any real message can reach today, under either mode.

## 13. Event dedup and AI cache (unchanged)

The existing event lease/retry dedup remains fully authoritative and untouched — it runs before any gate evaluation, exactly as before, and a duplicate never reaches the gate at all. The interpretation cache (`interpretationCacheRepo`) is checked before the authoritative-gate branch is ever considered; a cache hit short-circuits identically regardless of cutover state, and is never counted as a fresh AI call in either mode's telemetry.

## 14. Tests / results

| Suite | Result |
|---|---|
| `lead-matching-service` unit | **346/346** pass (+29 in `v2-intake-gate.test.js`, +23 additions to `shadow-evaluator.test.js`, +11 new `pipeline-cutover.test.js`) |
| `lead-matching-service` integration | **71/71** pass (+7 new in `gate-cutover.integration.test.js`, real Postgres, migration 0023 applied) |
| `lead-matching-service` regression | 24/27 pass, 3 skipped (unchanged from before this phase) |
| root unit | **231/231** pass (unchanged) |
| root contracts | **19/19** pass (unchanged) |
| root integration | **48/48** pass (unchanged, migration 0023 applies cleanly alongside 0000–0022) |

Coverage matches every scenario in this task's §15: buyer_signal_policy (A), precedence (B), cutover OFF (C), cutover ON with AI-call spying (D), fail-safe fallback including a simultaneous telemetry failure (E), and Draft/Apply/Rollback including immediate cutover-OFF-after-rollback (F).

## 15. Production deployment status

**Code and migration are deployment-ready but have not been deployed to production as part of this task.** Deploying migration 0023 and this code changes zero live behavior on its own — `v2_intake_cutover_enabled` defaults to `false`, and no automatic activation occurs anywhere in this change.

## 16. Activation runbook (for when explicitly approved)

1. Deploy migration 0023 (additive, matches the same low-risk profile as 0019–0022) and the updated application code.
2. Confirm via `/settings` that `v2_intake_cutover_enabled = false` and `buyer_signal_policy = REQUIRE_BOTH` (the safe defaults) are what's actually active.
3. Confirm `/shadow-gate` still shows healthy `SHADOW`-mode telemetry (proves the deploy didn't break anything before touching the live flag).
4. Only then, as a deliberate, separate operator action: open `/settings`, set `buyer_signal_policy = REQUIRE_ANY` **and** `v2_intake_cutover_enabled = true` in the same draft, and Apply — this creates one new config version recording both changes together, per this task's explicit instruction not to activate before this exact combination is reviewed.
5. Monitor per section 17 below for at least the first hour, then continue monitoring daily.
6. If any rollback trigger fires, immediately set `v2_intake_cutover_enabled = false` and Apply — no code deploy required (section 18).

**`REQUIRE_ANY` is an explicitly temporary, emergency-only setting** — see `docs/MATCHING_V2_PHASE35_GATE_CALIBRATION.md` §7. It is not the intended permanent policy; it should be revisited once BLACKLIST/PROPERTY_SIGNAL rule coverage has been improved (§8 of that document), at which point `REQUIRE_BOTH` (or a further-refined policy) should be reconsidered.

## 17. Post-activation monitoring

Watch, at minimum for the first hour, then regularly:

- `/shadow-gate`'s Telemetry Mode panel — `AUTHORITATIVE` count should track real traffic volume; **`FALLBACK` should be zero or near-zero**.
- Actual Live Gate Behavior panel — V2 SEND_TO_AI vs. deterministic-reject split, blacklist rejects, insufficient-signal rejects.
- Fresh AI calls vs. cache hits — confirm the AI-bound volume roughly tracks Phase 3.5's calibrated expectation (~61% net reduction from the pre-cutover baseline — not the raw 73% figure; see the calibration doc §6 for why).
- Application error logs for `V2_GATE_ERROR_FALLBACK` and `shadow_telemetry_insert_failed`.
- Legacy comparison where still possible: any `SHADOW`-mode rows still being produced elsewhere (there should be none while cutover is fully on, by design) would indicate a code path bypassing the authoritative gate unexpectedly.

**Immediate rollback triggers:**

- A sustained non-zero `FALLBACK` count.
- Any qualitative report or dashboard pattern suggesting real buyer messages are being rejected (e.g. a broker reporting a lead they know posted didn't get a match/notification).
- AI-bound traffic collapsing far below the ~61% net reduction expectation (suggests the gate is rejecting far more than calibrated, e.g. an active config drifted back toward `REQUIRE_BOTH` unintentionally, or a rule regression).
- A visible increase in the service's general error rate.
- BLACKLIST rejections appearing to catch messages an operator can confirm are genuine buyer requests (the calibration review found none, but production scale may surface a case the sample didn't).

## 18. Rollback

Purely operational, no code/deploy step:

```
Settings -> set v2_intake_cutover_enabled = false -> Apply
```

Tested explicitly (`gate-cutover.integration.test.js`): after a real rollback to a pre-cutover config version, the very next `evaluateAuthoritativeGate()` call returns `{ cutoverEnabled: false }` immediately — Phase 3 shadow-only behavior resumes with no deployment, no restart, and no code change.

## 19. Risks / open questions

- `REQUIRE_ANY`'s ~132-message "added" cost (per the calibration doc) is spent on broker spam the current BLACKLIST doesn't yet catch — a real, non-zero cost increase for that specific slice of traffic, accepted as the tradeoff for the false-negative-risk reduction.
- Source-level disable/routing remains unwired (§12) — if a specific monitored source needs to be excluded from authoritative gating before that's built, the only lever today is disabling the source entirely upstream (worker-level), not a per-source gate exception.
- The 60-second config cache TTL means an Apply can take up to a minute to reach new evaluations — acceptable, documented, unchanged from Phase 3.

## 20. Phase 5 prerequisites

Phase 5 (removing the local structured parser from runtime entirely) should not begin until: cutover has been live in production for a meaningful period with healthy telemetry (no sustained fallback, no buyer-loss signal); `REQUIRE_ANY`'s temporary status has been resolved one way or another (either rule coverage improved enough to return to `REQUIRE_BOTH`, or a deliberate product decision to keep a permissive policy); and an explicit operator review authorizes starting Phase 5, per this project's standing "no phase begins without review" discipline.
