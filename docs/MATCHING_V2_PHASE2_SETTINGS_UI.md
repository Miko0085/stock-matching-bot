# Nika Matching V2 — Phase 2: Settings UI / Configuration Control Plane

**Status:** Phase 2 output (`AGENTS_NIKA_MATCHING_V2.md`, section 26, Phase 2).
**Runtime impact:** none. This page manages configuration STATE only — nothing in the running `lead-matching-service` pipeline reads `matching.runtime_settings`, `matching.intake_rules`, `matching.config_versions`, or the new `matching.config_draft` (migration 0021). Proof in section 7 below.

> **2026-09-27 update:** the operator-facing terminology and rule-card layout described below were simplified for non-technical operators (friendly rule names, renamed rule-group titles, an Advanced disclosure for raw regex/backend fields, a dynamic active-mode banner). This is a presentation-only change — every route, the Draft → Apply model, and every backend enum value in this document are unchanged. See `docs/SETTINGS_UI_SIMPLIFICATION.md` for the full list of what changed and what explicitly did not.

## 1. UI structure

One new page, `/settings`, added to the **existing** dashboard (`dashboard/server.js`) — no separate admin app, same dark-theme layout/nav/auth as every other page (`/`, `/stock`, `/sources`, ...). Added to the top nav as **Settings**.

The page renders in exact pipeline order (a table of contents at the top links to each anchor):

```
1. Sources & Intake      -- informational, links to the existing /sources page
2. Deduplication          -- event_dedup_enabled, content_dedup_enabled, content_dedup_ttl_hours,
                             ai_cache_enabled, ai_cache_ttl_days
3. Blacklist               -- CRUD, rule_group=BLACKLIST
4. Whitelist               -- CRUD, rule_group=WHITELIST
5. Property Signals        -- CRUD, rule_group=PROPERTY_SIGNAL
6. Buyer Candidate Gate    -- whitelist_threshold, property_signal_threshold, ai_intake_gate_enabled,
                             explanatory (non-wired) algorithm text, CRUD rule_group=SEND_TO_AI
7. AI                      -- read-only summary of AI cache/gate settings (edited in sections 2/6
                             above, not duplicated here) + "not live" banner
8. Matching                -- transaction/bedrooms/property_type/budget toggles, budget_tolerance_pct,
                             LOCATION shown as MANDATORY/LOCKED with no input at all
9. Configuration History   -- version list (top 5 inline, full list at /settings/history)
```

A persistent banner at the top of the page states: *"Configuration is not yet connected to live intake decisions. Runtime cutover happens in later phases (V2 Phase 3/4)."*

## 2. Routes/endpoints added (`dashboard/server.js`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/settings` | Main page — loads/initializes the draft, renders all 9 sections |
| POST | `/settings/setting` | Update one setting in the DRAFT (body: `key`, `valueText`, `enabled`) |
| POST | `/settings/rule` | Add a rule to the DRAFT (body: `rule_group`, `match_type`, `pattern`, `priority`, `description`) |
| POST | `/settings/rule/:id` | Edit a DRAFT rule (`:id` may be negative — a draft-only, not-yet-applied rule) |
| POST | `/settings/rule/:id/delete` | Remove a rule from the DRAFT |
| POST | `/settings/apply` | Validate + atomically apply the draft (body: optional `note`) |
| POST | `/settings/discard` | Discard unapplied draft edits, re-sync from the current real tables |
| GET | `/settings/history` | Full version history |
| GET | `/settings/history/:version` | One version's full snapshot + diff vs. the previous version |
| POST | `/settings/history/:version/rollback` | Roll back to an old version (creates a NEW version — see section 5) |

Backing modules: `dashboard/settings-queries.js` (thin re-export of `lead-matching-service/src/repositories/config-repository.js` + `.../src/config/config-validation.js`, passing the dashboard's own pool) and `dashboard/settings-view.js` (pure render functions, no DB access — same contract as `sources-view.js`).

## 3. Editing model: Draft → Apply

Individual UI edits (toggle a setting, add/edit/delete a rule) write **only** to a new singleton table, `matching.config_draft` (migration `0021_matching_v2_config_draft.sql`, one row, `id=1`) — never directly to `matching.runtime_settings`/`intake_rules`. This is what makes "make several edits, see them as unsaved, then Apply" possible on a plain server-rendered page with no client-side state:

- First visit to `/settings` (or after a Discard/Apply) initializes/re-syncs the draft from whatever is currently in the real tables.
- Every edit updates the draft's `settings`/`intake_rules` JSONB arrays and sets `is_dirty = true`.
- New draft-only rules get a synthetic **negative** id (e.g. `-1`, `-2`, ...) so they can be edited/deleted before ever being persisted — never collides with a real `BIGSERIAL` id (always positive).
- The banner at the top of the page reads `is_dirty` directly: dirty → "You have unapplied changes" + Apply/Discard controls; clean → "No pending changes — matches version N".

### Apply semantics

`applyDraft()` (`config-repository.js`):
1. Validates **every** setting and rule in the draft (`validateSettingValue`/`validateRule` — the same functions used for individual edits) — a single invalid entry blocks the whole Apply, never a partial write.
2. Opens **one** Postgres transaction (`BEGIN`): deletes and fully re-inserts `matching.runtime_settings` and `matching.intake_rules` from the draft's arrays, computes `version_number = max(existing) + 1`, builds a complete snapshot by **re-reading the just-written rows** (never a hand-duplicated literal — same discipline as Phase 1.1's snapshot backfill), inserts the new `matching.config_versions` row, `COMMIT`.
3. On any error: `ROLLBACK` — verified by an integration test that corrupts the draft, calls Apply, and asserts the real tables are byte-identical to their pre-Apply state and no new version was created.
4. Re-syncs the draft from the now-applied real tables (picks up real ids, resets `is_dirty`).

Full delete-and-reinsert (not a diff-based upsert) is deliberate: the tables are tiny (13 settings, ~40 rules) and this keeps the write path simple and obviously correct, matching the contract's repeated "keep it simple." A rule's identity ACROSS versions is therefore its **content** (`rule_group` + `match_type` + `pattern`), not its DB id — used by the diff function (section 4).

## 4. Configuration History & diff

`GET /settings/history` lists every version (append-only, newest first, current one badged). `GET /settings/history/:version` shows the full snapshot plus a diff against the immediately-preceding version (`diffConfigVersions()`, a pure function): settings changed (key + before/after), rules added, rules removed, rules toggled enabled/disabled. Not a byte-level JSON diff — exactly the four categories the contract asks for, nothing more.

## 5. Rollback semantics

`rollbackToVersion(pool, N)`:
1. Reads version `N`'s snapshot (already-validated data, but re-validated anyway so both write paths — Apply and Rollback — can never silently diverge).
2. Runs the **same** `writeConfigAndSnapshot()` transaction Apply uses, with `note = "Rollback to version N"`.
3. The result is version `max+1`, **not** a rewritten version `N`. Old versions (`N` itself and everything after it up to `max`) are never touched — verified by an integration test that rolls back and then re-reads both the rolled-back-from and the target version, asserting both snapshots are byte-identical to before the rollback.
4. Draft is re-synced afterward, same as Apply.

## 6. Validation (`lead-matching-service/src/config/config-validation.js`, pure, no DB)

- **Settings:** key must be one of the 13 Phase-1-seeded keys (closed set — no new key can be invented through this UI); value type must match the seeded `value_type`; booleans must be `"true"`/`"false"`; `*_threshold` ≥ 0; `*_ttl_hours`/`*_ttl_days` > 0; `budget_tolerance_pct` ∈ [0, 100].
- **Location:** any key starting with `location_` is rejected in application code (`isLocationKey()`) — **in addition to**, not instead of, the database's own structural CHECK constraint (migration 0020/Phase 1.1: `key !~ '^location_'`). Two independent layers agreeing is the point; the frontend also never renders an input that could produce such a key at all (verified by a render test).
- **Rules:** `rule_group` ∈ {BLACKLIST, WHITELIST, PROPERTY_SIGNAL, SEND_TO_AI}; `match_type` ∈ {PHRASE, REGEX}; `pattern` non-empty; `priority` a whole number.
- **REGEX syntax:** validated via `new RegExp(pattern, 'iu')` — this only ever checks syntax (the same safe pattern every hard filter in this codebase already uses); a pattern is later matched against text, never executed as code. An invalid regex is rejected with an HTTP 400 + operator-readable error, never persisted (verified: the exact string `"(unterminated"` is rejected both as a standalone `addDraftRule` call and end-to-end via the real HTTP route).

## 7. Proof the runtime pipeline remains unwired

```
$ grep -rn "config-repository\|config-validation" lead-matching-service/src/services lead-matching-service/src/gates lead-matching-service/src/matching lead-matching-service/src/api
(no output)
```

`src/gates/triage.js`, `src/services/pipeline.js`, and `src/config/index.js` (env-based) are completely unchanged by this phase. The dashboard is a separate Node process (`dashboard/server.js`) that happens to read/write the same `matching` schema — it has no code path back into the running matcher.

## 8. Tests / results

- **New unit tests (no DB):** `lead-matching-service/tests/unit/config-validation.test.js` (19 cases — every rule in section 6), `config-repository.test.js` additions (`diffConfigVersions`, 6 cases), `tests/unit/settings-view.test.js` (15 cases — pipeline order, draft banner states, location locked with **zero** location-named form fields anywhere, metadata fields never rendered as toggles, and a full "no `<form>` nested inside another" structural check reusing the exact technique `sources-view.test.js` established for the same class of bug).
- **New integration tests (real Postgres):** `lead-matching-service/tests/integration/config-draft.integration.test.js` (14 cases) — draft init/edit/discard, add/edit/delete rule in the draft only (never touching the real table until Apply), invalid key/regex/rule_group rejected, **Apply atomicity** (a corrupted draft is rejected and the real tables + version count are provably unchanged afterward), **Apply creates a complete, correct snapshot**, **Rollback creates a new version and never mutates old ones**.
- **End-to-end HTTP verification** (manual, this session): started the real dashboard server against a disposable Postgres and exercised the actual page over HTTP — toggled a setting, added a rule, confirmed the draft banner flips to "unapplied changes", submitted an invalid regex (got a real HTTP 400 with the exact validation message), Applied (new version appeared in history, draft banner returned to "no pending changes"), viewed a version's diff, and rolled back (new version created, old ones intact).
- **Full suite (before → after Phase 2, all counts additive only):**

| Suite | Result |
|---|---|
| root `test:unit` | 208 → **223/223** pass |
| root `test:contracts` | **19/19** pass (unchanged) |
| root `test:integration` (disposable Postgres) | **43/43** pass (unchanged) |
| lead-matching-service unit (no DB) | 283 → **307** pass; DB-dependent failures 47 → 61 (+14, exactly the new integration file, expected without `TEST_DATABASE_URL`) |
| lead-matching-service integration (disposable Postgres) | 43 → **57/57** pass |

## 9. Known limitations

- PROPERTY_SIGNAL's Phase 1 seed is a representative extract of `triage.js`'s real patterns, not a byte-for-byte port (documented in `docs/MATCHING_V2_PHASE1_CONFIG.md` §3) — unaffected by Phase 2, still worth revisiting before Phase 3 wires a real shadow gate to these rules.
- The draft is a **single global singleton** (`id=1`) — fine for one operator at a time (this control plane's actual usage pattern today); a genuinely concurrent multi-operator editing model is out of scope for Phase 2.
- Rule identity across versions is content-based (`rule_group`+`match_type`+`pattern`); two rules that happen to share all three fields are indistinguishable in a diff (matches the actual business meaning — a rule IS its content).
- Version-detail rule tables render each row through the same `ruleGroupTable()` helper used for the live draft, giving historical rows synthetic display-only ids (`v{version}-{group}-{index}`) — cosmetic only, these ids are never submitted anywhere from a historical view.

## 10. Rollback procedure (for this PHASE, i.e. undoing the deploy — not to be confused with the in-app "Rollback to version N" feature described above)

Local: `git revert <phase-2-commit-sha>`.

Database (only relevant once actually deployed somewhere — this branch has not been deployed to production):

```sql
DROP TABLE IF EXISTS matching.config_draft;
DELETE FROM matching.schema_migrations WHERE filename = '0021_matching_v2_config_draft.sql';
```

Migrations `0020`'s tables are untouched by this rollback (Phase 1/1.1 remain independently rollbackable per their own docs). Safe to run — nothing else references `config_draft`, and no runtime code queries it.
