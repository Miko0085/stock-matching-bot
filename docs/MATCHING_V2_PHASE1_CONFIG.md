# Nika Matching V2 — Phase 1: Configuration Database Foundation

**Status:** Phase 1 output (`AGENTS_NIKA_MATCHING_V2.md`, section 26, Phase 1).
**Runtime impact:** none. Nothing in `lead-matching-service`'s running pipeline reads these tables. `src/gates/triage.js` (hardcoded patterns) and `src/config/index.js` (env-based settings) remain the only active configuration sources.

## 1. Tables introduced (migration `sql/migrations/0020_matching_v2_config.sql`)

All three live in the existing `matching` schema (no new schema — additive, consistent with every prior migration).

### `matching.config_versions`

Append-only snapshot history (contract §21: "Every Apply creates a durable snapshot"). One JSONB snapshot per version rather than per-row versioning — deliberately simple per the contract's own "Keep it simple. Do not build Phase 2 UI yet."

```sql
id                 BIGSERIAL PRIMARY KEY
version_number     INTEGER NOT NULL UNIQUE
snapshot           JSONB NOT NULL
note               TEXT
created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
created_by         TEXT
```

**Phase 1.1: `snapshot` is a COMPLETE historical record**, not a one-line description. For version 1 it is:

```json
{
  "schema_version": 1,
  "config_version": 1,
  "runtime_settings": [ { "key": "...", "value_type": "...", "value_text": "...", "enabled": true }, ... 13 total ],
  "intake_rules": [ { "rule_group": "...", "match_type": "...", "pattern": "...", "enabled": true, "priority": 100, "description": "..." }, ... 41 total ]
}
```

Built by an `UPDATE ... SET snapshot = jsonb_build_object(..., (SELECT jsonb_agg(...) FROM matching.runtime_settings WHERE config_version_id = v_id), ...)` **after** the settings/rules INSERTs in the same migration transaction — i.e. aggregated FROM the real seeded rows, never a hand-duplicated literal, so it cannot drift from what was actually seeded. This makes the snapshot sufficient to reconstruct version 1 later purely from this column, even after a future Phase 2 UI lets an operator edit the live `runtime_settings`/`intake_rules` rows in place.

### `matching.runtime_settings`

Current active value per key. `value_type` + `value_text` (a single text column parsed by `config-repository.js`'s `coerceSettingValue()`) rather than a wide sparse-column table.

```sql
id                  BIGSERIAL PRIMARY KEY
key                 TEXT NOT NULL UNIQUE
value_type          TEXT NOT NULL CHECK (value_type IN ('boolean','integer','numeric','text'))
value_text          TEXT
enabled             BOOLEAN NOT NULL DEFAULT true
config_version_id   BIGINT REFERENCES matching.config_versions(id)
updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
updated_by          TEXT
CONSTRAINT runtime_settings_location_not_configurable
  CHECK (key !~ '^location_')
```

**Location is structurally protected, not just documented.** The CHECK constraint above rejects any row whose key starts with `location_` — enforced at the database level so a future bug in the Settings UI (Phase 2) or API cannot silently make location disableable, matching contract §12.1 ("Mandatory. Cannot be disabled.").

**Phase 1.1 hardening:** the original constraint was a finite name blocklist (`key NOT IN ('location_enabled', 'location_matching_enabled', 'location_disabled')`) — it only protected the exact names it enumerated. A key like `location_filter_enabled` or `location_match_enabled` would have slipped straight past it. The constraint is now a structural prefix rejection (`key !~ '^location_'`) that blocks the entire name family regardless of suffix, verified against all four names above plus a normal non-location key (`tests/integration/config-repository.integration.test.js`).

### `matching.intake_rules`

```sql
id                  BIGSERIAL PRIMARY KEY
rule_group          TEXT NOT NULL CHECK (rule_group IN ('BLACKLIST','WHITELIST','PROPERTY_SIGNAL','SEND_TO_AI'))
match_type          TEXT NOT NULL CHECK (match_type IN ('PHRASE','REGEX'))
pattern             TEXT NOT NULL
enabled             BOOLEAN NOT NULL DEFAULT true
priority            INTEGER NOT NULL DEFAULT 100
description         TEXT
config_version_id   BIGINT REFERENCES matching.config_versions(id)
created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
```

Index: `(rule_group, enabled)` — the shape every future read (`getEnabledIntakeRules()`) filters by.

No rules DSL beyond `PHRASE`/`REGEX`, per contract §7's explicit "do not create a complex DSL unless explicitly approved."

## 2. Defaults seeded (config version 1)

All defaults mirror the **current, already-running** behavior — nothing here changes what the service actually does, it only makes the existing implicit defaults explicit and editable in the future.

| key | value | mirrors |
|---|---|---|
| `event_dedup_enabled` | `true` | always-on today |
| `content_dedup_enabled` | `true` | always-on today |
| `content_dedup_ttl_hours` | `48` | `DEDUP_WINDOW_HOURS` env default |
| `ai_cache_enabled` | `true` | always-on today |
| `ai_cache_ttl_days` | `14` | `INTERPRETATION_CACHE_TTL_DAYS` env default |
| `whitelist_threshold` | `1` | contract §8's algorithm minimum |
| `property_signal_threshold` | `1` | contract §8's algorithm minimum |
| `transaction_matching_enabled` | `true` | always-on today |
| `bedrooms_matching_enabled` | `true` | always-on today |
| `property_type_matching_enabled` | `true` | always-on today |
| `budget_matching_enabled` | `true` | always-on today |
| `budget_tolerance_pct` | `10` | `MATCH_PRICE_TOLERANCE_PCT` env default |
| `ai_intake_gate_enabled` | `true` | always-on today |

No `location_*` key exists at all — not just disabled, structurally absent, per the CHECK constraint above.

## 3. Seed rule provenance (config version 1)

Every seeded `intake_rules` row's `description` column cites its exact source. Summary by group:

- **BLACKLIST** (16 rows) — 6 of `triage.js`'s `BROKER_SOLICITATION_PATTERNS` (the 7th, a duplicate-shape sub-pattern, is covered by the others), `FOR_SALE_HEADING_RE`, and 9 `PHRASE` rows covering `RUSSIAN_OFFER_SIGNAL_RE`'s seller-offer verbs (сдам/сдаю/сдаётся/сдается/продам/продаю/продаётся/продается/"от собственника"). Seeded as plain `PHRASE` matches rather than the original regex's Unicode-lookaround boundary trick — a simple substring match doesn't need that workaround at all, and avoids replicating a subtle regex detail (JS's `\b` not matching Cyrillic — see commit `40acb80`) into a rules table meant to stay simple.
- **WHITELIST** (16 rows) — 10 of `local-parser.js`'s `STRONG_BUYER_INTENT_PATTERNS`, plus 6 `PHRASE` rows for `triage.js`'s `FIRST_PERSON_BUYER_RE` buyer-side entries (ищу/нужен/нужна/сниму/"клиенту нужен"/"клиенту нужна" — the last two approximate the original `клиенту\s+нужн` prefix-match as two concrete forms, since a plain phrase can't express a prefix). These also match the contract's own §7 examples (ищу/нужен/клиент ищет) essentially verbatim.
- **PROPERTY_SIGNAL** (9 rows) — a representative extract (not the complete pattern) from `triage.js`'s `BEDROOM_SIGNAL_RE`/`LISTING_WORD_RE`/`PRICE_SIGNAL_RE`, which today serve a different purpose (multi-listing-ad detection) but are the closest existing "this message is about a real-estate requirement" evidence in code. Full 1:1 fidelity was not pursued in Phase 1 since no runtime code reads this table yet — worth revisiting before Phase 3 wires a shadow gate to it.
- **SEND_TO_AI** (0 rows, intentional) — no current hardcoded equivalent of "an explicit operator exception, always send to AI" exists in the code (`triage.js`'s `AI_REVIEW` branch is a fallback default, not an explicit rule). Seeding a fabricated example would have violated the "derived from current hardcoded rules, do not invent" instruction. Left empty for a real operator decision once the Settings UI (Phase 2) exists.

## 4. Repository/API layer

`lead-matching-service/src/repositories/config-repository.js` — read-only:

- `getActiveRuntimeSettings(pool)` → `{ [key]: { value, enabled } }`, typed via `coerceSettingValue()`.
- `getEnabledIntakeRules(pool)` → `{ BLACKLIST: [...], WHITELIST: [...], PROPERTY_SIGNAL: [...], SEND_TO_AI: [...] }`, every group key always present.
- `getCurrentConfigVersion(pool)` / `getConfigVersionHistory(pool)`.

**Not imported by `src/services/pipeline.js`, `src/gates/triage.js`, or `src/api/server.js`** — confirmed by `grep -r "config-repository" src/services src/gates src/api` returning no matches outside this new file and its own tests. This is the explicit Phase 1 requirement: the storage and read layer exist and are tested, but nothing in the running service depends on them yet.

## 5. Confirmation that runtime behavior is unchanged

- Every existing test suite passes with identical counts to the Phase 0 baseline (`docs/MATCHING_V2_REFACTOR_BASELINE.md` section 1): root unit 208/208, root contracts 19/19, root integration 43/43, lead-matching-service unit 277→283 (the +6 are this phase's new `coerceSettingValue` unit tests; same 31 pre-existing DB-connectivity "failures" when run without `TEST_DATABASE_URL`), lead-matching-service integration 27→43 (Phase 1: +11 from `config-repository.integration.test.js`; Phase 1.1: +5 more — 3 additional location-prefix rejection cases, 1 accepted-normal-key case, 1 snapshot-completeness case — all passing against a real disposable Postgres).
- `git grep -n "config-repository"` outside `src/repositories/config-repository.js` and its two test files returns nothing — no wiring exists.
- The migration only adds tables/rows; it does not alter any existing table, column, or constraint.

## 6. Rollback

Local: `git revert <phase-1-commit-sha>`.

Database (only if the migration was ever applied somewhere and needs undoing — not required for this branch, which has not been deployed):

```sql
DROP TABLE IF EXISTS matching.intake_rules;
DROP TABLE IF EXISTS matching.runtime_settings;
DROP TABLE IF EXISTS matching.config_versions;
DELETE FROM matching.schema_migrations WHERE filename = '0020_matching_v2_config.sql';
```

Safe to run — no other table has a foreign key into these three, and no runtime code queries them.
