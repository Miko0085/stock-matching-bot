# Settings UI simplification — human-readable intake rule management

**Status:** presentation-only change on top of Phase 2 (`docs/MATCHING_V2_PHASE2_SETTINGS_UI.md`) and Phase 4 (`docs/MATCHING_V2_PHASE4_GATE_CUTOVER.md`). **Nothing in this change touches backend semantics** — no rule matching behavior, threshold, enum value, seeded rule data, Draft/Apply mechanism, or gate evaluation order changed. Only how the existing `/settings` (and `/shadow-gate`) pages LABEL and PRESENT already-existing backend data changed.

## 1. Why

The `/settings` page's rule-management UI previously showed raw regex patterns, internal source-file comments as descriptions (e.g. `"triage.js PRICE_SIGNAL_RE"`), and backend enum names (`BLACKLIST`, `WHITELIST`, `PROPERTY_SIGNAL`, `SEND_TO_AI`, `REQUIRE_ANY`, `REQUIRE_BOTH`) as the primary operator-facing text. That is unreadable for a non-technical operator managing intake rules day to day. This change makes the primary, always-visible presentation plain-language, while keeping every raw/technical field one click away behind an "Advanced" disclosure.

## 2. What changed (presentation only)

All of the following are implemented in **`dashboard/rule-ui-metadata.js`** (new file) plus small rendering changes in **`dashboard/settings-view.js`** and **`dashboard/shadow-view.js`**. None of these three files are imported by anything under `lead-matching-service/src/gates/**`, `src/matching/**`, or `src/services/**`.

### 2.1 Rule group renaming (display only — backend enum values unchanged)

| Backend enum (unchanged) | New display title | Old display title |
|---|---|---|
| `BLACKLIST` | Заблокированные сообщения (Спам продавцов и объявления) | Чёрный список |
| `WHITELIST` | Намерение купить | Белый список |
| `PROPERTY_SIGNAL` | Детали объекта | Сигналы о недвижимости |
| `SEND_TO_AI` | Всегда отправлять в ИИ | Отправить в ИИ |

The section anchors (`#blacklist`, `#whitelist`, `#property-signals`, ...) and the values stored in `matching.intake_rules.rule_group` are **unchanged** — only `SECTION_LABELS`/`RULE_GROUP_UI` display text changed.

### 2.2 Friendly rule names

`rule-ui-metadata.js`'s `RULE_PATTERN_UI` maps the **exact pattern string** of every rule seeded as of 2026-09-27 (41 rows, verified against production `matching.intake_rules`) to a human name/description/example, e.g.:

- `\blooking\s+for\b` → "Ищу (looking for)"
- `\baed\b` → "Цена в AED"
- `ищу` → "Ищу"
- `нужен` → "Нужен"

`getRuleFriendlyName(rule)` never returns blank and never throws: mapped pattern → friendly name; unmapped pattern → falls back to the rule's own `description` column; no description either → falls back to the raw pattern itself. **This means a brand-new rule added through the UI before anyone updates the mapping table is still presentable** — it just shows its own description or pattern as its "name" until someone adds a friendly entry.

The friendly name is now the **primary, always-visible label** in both the Settings page's rule cards and the Shadow Gate page's rule-hit table. The raw match type / pattern / priority / description / rule id / backend group all still exist and are still the actual editable/submitted fields — they just live inside a collapsed `<details><summary>Дополнительно</summary>...</details>` per row, closed by default ("Advanced mode"). Expanding it changes nothing about what gets submitted; it is the exact same `<input>`/`<select>` elements as before, just visually relocated.

### 2.3 Buyer signal policy labels

| Backend enum (unchanged) | New display label |
|---|---|
| `REQUIRE_ANY` | Достаточно любого сигнала |
| `REQUIRE_BOTH` | Требовать оба сигнала |

The `<select name="valueText">` for `buyer_signal_policy` still submits `REQUIRE_ANY`/`REQUIRE_BOTH` literally — only the visible `<option>` text changed.

### 2.4 Dynamic "current active mode" banner

`renderActiveModeBanner(settings)` (new, exported from `settings-view.js`, rendered at the very top of `/settings`, right after the existing "not live" banner) composes a plain-language sentence **computed from the live settings map every render** — `v2_intake_cutover_enabled`, `buyer_signal_policy`, `whitelist_threshold`, `property_signal_threshold`. It is never a hardcoded string, so it cannot go stale the way an earlier `/sources` banner once did (see `docs/DECISIONS.md`).

### 2.5 Visual flow explanation

`renderIntakeFlowDiagram()` (in the Buyer Candidate Gate section) explains the real evaluation order (blocked → always-AI exception → buyer/property signal policy) in plain language. It is static explanatory text; the actual order is still enforced only by `evaluateV2IntakeGate()` in `lead-matching-service`, unchanged.

### 2.6 Duplicate-pattern detection (read-only, same convention as the Sources page's duplicate badge)

Within one rule group, if two rules share the same `match_type` + `pattern`, a warning banner lists them by id. **Detection only** — nothing is auto-merged, disabled, or deleted, matching the same product decision already made for the Sources/Channels page's cross-account duplicate indicator.

### 2.7 Live-safety warnings

When `v2_intake_cutover_enabled = true`, every rule-group section shows a warning that edits will affect real traffic once the draft is applied. BLACKLIST gets stronger wording (a bad blacklist pattern can reject real buyers with zero AI calls). These warnings are purely informational and never block editing or applying.

### 2.8 Plain-language pending-change summary

The Draft banner, when dirty, now also shows what would change if Apply is clicked — reusing the **already-existing, already-tested** `diffConfigVersions()` function (previously only used for version-to-version history), diffed against the version the draft is based on. No new backend diff logic was written.

### 2.9 Rule Statistics Table (`/shadow-gate`)

`renderRuleHitAnalytics()` was relabeled the same way: friendly rule name + friendly group title are now the primary columns ("Правило", "Категория", "Что обнаруживает"); raw pattern, backend group enum, and raw DB description moved into a per-row Advanced disclosure. The underlying hit-count query and numbers are unchanged.

## 3. Explicitly NOT changed

- `evaluateV2IntakeGate()` and its precedence (blacklist > SEND_TO_AI exception > buyer/property signal policy) — untouched.
- `REQUIRE_ANY`/`REQUIRE_BOTH` behavior, thresholds, and all other `matching.runtime_settings` values — untouched.
- Seeded `matching.intake_rules` data/patterns — untouched. `rule-ui-metadata.js` only reads `pattern`/`description`, never writes them.
- Backend enum names (`BLACKLIST`, `WHITELIST`, `PROPERTY_SIGNAL`, `SEND_TO_AI`, `REQUIRE_ANY`, `REQUIRE_BOTH`) — untouched in the database and in every `value`/`name` HTML attribute; only visible `<option>`/label TEXT changed.
- The Draft → Apply → version-snapshot mechanism (`dashboard/settings-queries.js`, `lead-matching-service/src/repositories/config-repository.js`) — untouched. No settings were applied as part of this change; the currently-active configuration version was not advanced.
- Rule/threshold/routing/AI-prompt/model/retry/n8n-flow business logic — untouched.

## 4. Extending the friendly-name mapping

`RULE_PATTERN_UI` in `dashboard/rule-ui-metadata.js` is keyed by the exact `pattern` string. To add a friendly name for a new or previously-unmapped rule, add an entry there — this is a presentation-only, no-migration change. A rule with no entry is never broken; it just displays its own `description` (or, failing that, its raw pattern) as its name until someone adds one.

## 5. Live rule performance statistics (2026-09-27 follow-up)

Each rule card on `/settings` now shows real recent performance, and the top of each rule group shows an aggregate summary. This is a read-only analytics addition on top of everything in sections 1-4 above — it changes no backend behavior and required no new database schema.

### 5.1 Data source

Reuses `matching.shadow_gate_evaluations` (migration 0022/0023) — the exact same telemetry `/shadow-gate` already reads. No second analytics source, no new table. Two new query functions were added to the existing query layer, `dashboard/shadow-queries.js`:

- `getRulePerformanceStats(pool, { period })` — one bounded query (a `WITH` CTE that unnests `blacklist_hits || whitelist_hits || property_signal_hits || send_to_ai_hits` once) that returns per-rule `{ mode, hits, v2SendToAi, v2Reject, hitToAiPct, hitToRejectPct }` for every rule that had any hit in the period, across **all** rules in one round trip — never one query per rule (the page can have 40+ rules).
- `getRuleGroupPerformanceSummary(pool, { period })` — one further bounded query (two CTEs over the same scoped rows: one for row-level message counts, one for a separate `DISTINCT` rule-id count — kept apart deliberately, since combining a row-level `count(*) FILTER` with an unnest in the same `FROM` would multiply the message counts by hits-per-message) that returns per-group `{ mode, messagesWithHit, messagesReachingAi, totalRuleHits, distinctRuleIds }`.

### 5.2 Rule identity

Each hit JSONB object already embeds the rule's real `id` (from `getEnabledIntakeRules()`'s `id, rule_group, match_type, pattern, priority, description` — see `v2-intake-gate.js`'s `findHits()`), so statistics are attributed by **stable rule id**, keyed as `id:<id>`. Fallback (legacy telemetry with no `id` in the hit payload, or two duplicate-pattern rules whose only recorded hits predate per-id tracking): `key:<rule_group>::<match_type>::<pattern>`. When a rule card's own id has no telemetry but its fallback key does, the card shows the fallback figure labeled *"общая статистика для повторяющегося шаблона"* ("shared statistics for duplicate pattern") — it never fabricates a per-id split the data doesn't support.

### 5.3 AUTHORITATIVE vs SHADOW

`mode IN ('AUTHORITATIVE', 'SHADOW')` is scoped in the query; `FALLBACK` rows are excluded entirely (they reflect a gate infrastructure failure, not real rule performance). For each rule/group, AUTHORITATIVE data is used whenever present; SHADOW is used **only** when there is zero AUTHORITATIVE data for that rule/group in the period. The two are never summed or averaged together, and the card always labels which one it's showing ("Рабочий режим" / "Теневой режим"). `DUPLICATE`-decision rows are always recorded with empty hit arrays (see `shadow-evaluator.js`'s `normalizeOldDecision`), so they contribute zero rule hits automatically — no special-case filter was needed.

### 5.4 Periods and where they live

24h (default) / 7d / 30d, selected via a single `?rule_stats_period=` query parameter and one lightweight link-based selector rendered once above the rule sections (`renderRuleStatsPeriodSelector`) — not one selector per card. Switching period is a normal `GET` navigation; it never creates or touches `matching.config_draft`.

### 5.5 Failure behavior

If either statistics query throws, `/settings` still renders the full rule configuration normally; every card's stats block shows *"Статистика недоступна"* instead, and the error is logged server-side (`console.error`). Analytics are secondary to configuration control — a `/shadow-gate`-style outage must never take down the ability to edit rules.

### 5.6 Overlap caveat

Rule hits are not unique messages: one message can satisfy several rules in the same group. Every group summary explicitly states this ("Срабатывания правил могут пересекаться: одно сообщение может подходить сразу под несколько правил").

### 5.7 Read-only guarantee

Viewing statistics, and switching the period, never creates a draft, never updates `runtime_settings`/`intake_rules`, never creates a config version, and never touches `v2_intake_cutover_enabled`, `buyer_signal_policy`, thresholds, or rule enable flags. Verified live: the active config version stayed at 4 and the draft stayed clean across both a plain page load and a period switch.

### 5.8 Known difference from `/shadow-gate`'s own Rule Statistics Table

`/shadow-gate`'s `getRuleHitAnalytics()` is deliberately **SHADOW-only** (it answers "what would V2 have done") and caps its table at the top 20 rules by hit count. The Settings cards answer "what is V2 doing right now" (AUTHORITATIVE-first) and show **every** rule, since each has its own card. For a rule with zero AUTHORITATIVE data, the two pages' numbers reconcile exactly (verified live for several rules, e.g. `\bhandover\b` before it accrued AUTHORITATIVE traffic). For a rule with AUTHORITATIVE data, the two pages intentionally show different numbers (SHADOW-projected vs AUTHORITATIVE-actual) — this is by design, not a bug. A low-volume rule may appear on Settings (every rule has a card) but be absent from `/shadow-gate`'s top-20 table.
