# Architecture Decisions

## ADR-051 — Broker Telegram/WhatsApp match notifications, activating the dormant migration-0009 schema, scoped to Dubai only

2026-10-08. User request: when a Dubai `MATCH` happens, also notify the
matched stock's OWN broker (not just the existing shared Telegram group),
via Telegram DM and/or WhatsApp, with a per-broker on/off toggle and a
WhatsApp-sending-account dropdown, on the `/telegram-bots` page renamed to
`/notifications`; plus a notification-delivery stats panel on that same
page (not a new page), using the Summary page's rolling-period filter and
an added calendar date-range picker.

**Scope confirmed with the user before implementation**: Dubai contour
only this iteration (RF/Abu Dhabi are separate contours, AGENTS.md §0, a
future iteration if ever); all brokers with a contact, not only
pocket-listing-sourced stock; contact format normalized before use as an
identity key; no channel configured → skip silently, never block/error the
pipeline; dedup granularity is one notification per `(stock_id,
source_message_id)` pair, not per request+broker as originally modeled.

**Found during research — reused, not rebuilt**: migration `0009`
(`docs/BROKER_ROUTING_AND_NOTIFICATIONS.md`,
`docs/TELEGRAM_BOT_AND_USER_MANAGEMENT.md`) had already built almost this
exact schema (`brokers`, `broker_telegram_accounts`,
`broker_notification_routes`, `notification_deliveries`,
`src/core/broker-notifications.js`'s message-chunking renderer,
`src/core/telegram-connection.js`'s `/start` token handshake helpers) —
but confirmed completely dormant in production (`docs/ARCHITECTURE_AUDIT_2026-09-17.md`):
`brokers` had 5 rows, `stock_inventory.broker_id` was 0% populated (0 of
286 active rows), and `broker_telegram_accounts`/
`broker_notification_routes`/`notification_deliveries` were all
completely empty. This feature activates that schema rather than building
a parallel one.

**What changed**:
- Migration `0045`: `notification_deliveries` gains `stock_id` +
  `source_message_broker_batch_id` and a new unique index on
  `(stock_id, source_message_id, channel)` — the real, DB-enforced dedup
  key (the old `idempotency_key`, request+broker+channel granularity,
  becomes legacy, relaxed to nullable). `broker_notification_routes`
  gains `whatsapp_account_id` (free text — `whatsapp-worker` tracks
  accounts in memory, not a DB table) and a unique `(broker_id, channel)`
  index (one route per channel per broker). `telegram_bots` gains
  `last_update_id` (long-polling cursor). `brokers` gains
  `normalized_phone` (unique) and `source_display_names` (audit trail).
- One-time idempotent backfill (`scripts/broker-backfill-from-stock-contacts-run.js`,
  dry-run by default): dedupes the 18 distinct ACTIVE `broker_contact`
  values in production into real `brokers` rows by normalized phone
  (`src/core/phone-normalize.js`) and backfills `stock_inventory.broker_id`
  — necessary because the free-text data is messy (the same phone
  appears under more than one display name, e.g. "Pavel Goss" /
  "Павел Nika Estate").
- **No public webhook for the Telegram `/start` handshake**: no public
  HTTPS ingress exists anywhere in this repo for a third-party Bot-API
  webhook (`telegram-worker` is a Telethon user-session listener, a
  different mechanism). `dashboard/telegram-bot-poller.js` long-polls
  `getUpdates` instead, inside the dashboard process, needing no new
  public endpoint — this is what finally wires up `resolveConnectionToken`,
  which previously had no live caller anywhere (only its own unit test).
- `dubai-lead-matching-service/src/notifications/broker-notifier.js`: a
  new, additive step in `pipeline.js`'s existing `MATCH` branch, after
  (never replacing) the existing shared-group broadcast, in its own
  `try/catch`. Off by default (`BROKER_NOTIFICATIONS_ENABLED=false`).
  Groups matches by the broker's normalized phone (not `broker_id`,
  since that FK is still 0% populated for any stock row synced before the
  backfill runs), resolves per-channel destination, excludes
  already-notified `stock_id`s, bundles only the new ones into one message
  (reusing `buildBrokerNotificationMessages` unchanged) but writes one
  `notification_deliveries` row per `stock_id` — the actual mechanism
  behind the per-pair dedup guarantee. A failed send still records a
  `FAILED` row for those `stock_id`s (deliberate: a channel outage must
  not become a resend storm on every reprocess).

**Rollout**: code/migrations/tests are complete and merged; running
migration 0045 against production, running the backfill script for real,
deploying the `pipeline.js` change, restarting/rebuilding
`dubai-lead-matching-service`/`dashboard`, and setting
`BROKER_NOTIFICATIONS_ENABLED=true` each still need the user's own
explicit go-ahead (AGENTS.md §2) — none of that has happened yet as of
this entry.

## ADR-050 — Independent `pocket-listing-ingest-service` (WhatsApp → Dubai stock)

2026-10-08 (backfilled; the service itself was already built, tested, and
deployed earlier the same day — this entry was missing from this file even
though the code's own comments already cite "ADR-050"). User request: an
independent background process ingesting new WhatsApp messages from the
"Secondary Nika Estate" group (`120363410119594257@g.us`, account
`wa_anna`) — the same group the earlier manual `.xlsx` pocket-listing
import (ADR-048) came from — to keep adding new Dubai pocket listings to
`matching_dubai.stock_inventory` going forward, isolated from the
lead-matching contours (this is stock *supply* extraction, not buyer-demand
matching).

New service `pocket-listing-ingest-service/` (Fastify, port 8098),
filtered to one hardcoded/env-configured `chat_id`, its own OpenAI
classify+extract prompt (supply-side: "is this a genuine listing?", not
Dubai's buyer-demand prompt), writing `status = 'NEEDS_REVIEW'` rows tagged
`stock_source = 'POCKET_LISTING_WHATSAPP_LIVE'` (distinct from the one-time
`.xlsx` import's `'POCKET_LISTING'` tag). Backed by its own schema
`pocket_listing_ingest.processed_messages` (migration `0043`, sender-alt
column added by `0044`) — one table serving both as the event-idempotency
dedup key and the audit log. Broker identity (`broker`/`broker_contact`)
is resolved from the WhatsApp message's own sender, not from AI
extraction, mirroring (without importing) Dubai's own
`resolveAuthorContact` convention. Non-Dubai-city listings from the same
group (Abu Dhabi/Sharjah) are logged and skipped, never written to any
stock table — same precedent as the `.xlsx` importer.

## ADR-049 — Roommate/room-share requests were reaching MATCH; added as a deterministic BLACKLIST, in both the live V2 gate and the legacy triage path

2026-10-07. User request: audit the last 7 days of Dubai matches for
"поиск соседа или арендатора в квартиру" (roommate/flatmate-seeking
messages) false positives, after noticing several in the Telegram alert
feed (e.g. "Ищу соседку в 1 bedroom в Business Bay", "Сниму мастер рум на
JBR для 2 девушек").

**Confirmed**: 5 of the 30 total Dubai `MATCH` outcomes in the preceding 7
days (~17%) were messages asking for a ROOM or BED within a shared
apartment, or offering one — never a whole-unit buy/rent request — yet the
pipeline extracted a bedroom count + area and matched them against
full-unit stock, sending a real (unwanted) Telegram alert to brokers each
time.

**Root cause was two separate, independent gaps**, found by checking
`match_runs.triage_decision`/`interpretation_source` for the 5 real rows:
all 5 had `triage_decision = null`, `interpretation_source = 'ai'` —
meaning none of them went through the legacy deterministic
`gates/triage.js` path (`evaluateTriage`) at all. They went through the
**V2 Authoritative Gate** (`v2_intake_cutover_enabled = true`, the live
mode), whose `matching_dubai.intake_rules` BLACKLIST set is a DB-mirrored
*subset* of `triage.js`'s patterns (broker-solicitation and single/multi-
listing phrases only) — it has no equivalent of `triage.js`'s broader
`evaluatePrimaryLeadGate` heuristics, and certainly no roommate detection,
so these messages sailed through BLACKLIST/WHITELIST/PROPERTY_SIGNAL
straight to the AI parser, which classified them as ordinary buyer
requests.

**Fix, both layers**:
- `dubai-lead-matching-service/src/gates/triage.js`: new
  `detectRoommateOrRoomShareRequest()`, checked before `parseLocally` runs
  (same priority as `detectBrokerSolicitation`/`detectSingleListingAd`),
  REJECT reason `roommate_or_room_share_request`. Narrow, explicit
  keyword set (same "precision over recall" discipline as the existing
  detectors): English `roommate`/`flatmate`/`room share`/`shared room`/
  `bed space`/`place in a room`/`master room`, Russian `сосед*`/`подсел*`/
  `место в комнате`/`мастер рум` ("master room" is confirmed Dubai
  share-accommodation slang for one rentable room — deliberately distinct
  from "master BEDROOM," which legitimately describes a feature of a
  whole unit and must never be caught). Protects the legacy/fallback path
  only (cutover OFF, or the V2 gate erroring and falling back).
- **The actually-effective fix for live traffic**: 5 new `BLACKLIST`
  intake rules added to `matching_dubai.intake_rules` via the normal
  Draft → Apply flow (`config_versions` version 5), mirroring the same
  patterns. Verified against all 5 real false-positive messages (all
  caught) and a set of genuine buyer requests including "2BR with master
  bedroom ensuite" (none false-triggered) before applying.

**Known gap, not fixed here**: the V2 gate's BLACKLIST set is generally
narrower than legacy `triage.js`'s full heuristic set (confirmed: several
of the 5 real examples would ALSO have been caught by
`evaluatePrimaryLeadGate`'s existing `non_property_request` check, which
the V2 gate has no equivalent of at all). Whether to port more of
`primary-lead-gate.js`'s logic into the V2 gate's rule set is a separate,
larger decision, out of scope for this fix.

**Same day, user request**: the identical 5 BLACKLIST rules were mirrored
onto Abu Dhabi's own `matching_abu_dhabi.intake_rules` (its own, separate
Draft → Apply config, `config_versions` version 3) — Abu Dhabi shares
Dubai's exact field model and matching semantics (ADR-044), so the same
roommate/room-share false-positive risk applies there even though no
Abu Dhabi example had been observed yet. Verified against Abu Dhabi-style
examples (Al Reem Island/Khalifa City/Yas Island) before applying, same
precision checks as Dubai's.

## ADR-048 — Dubai gets a second stock source: broker "pocket listing" .xlsx imports, filtered to city='Dubai' only

2026-10-07. User request: add another Dubai stock source — a broker-
provided spreadsheet of off-market "pocket listing" deals
(`dubai-lead-matching-service/Secondary_Nika_Estate_Pocket_Stock_updated_contacts.xlsx`).

**Cross-market contamination risk found and handled**: the file is not
Dubai-only — of 218 rows, 200 are `city='Dubai'`, 14 `'Abu Dhabi'`, 3
`'Sharjah'`, 1 blank. Loading it unfiltered into `matching_dubai.stock_inventory`
would have put Abu Dhabi/Sharjah stock into Dubai's own matching table,
directly violating AGENTS.md section 0. `scripts/dubai-pocket-stock-import-run.js`
filters to `city === 'Dubai'` (exact match) before validation and reports
every excluded row's city in its output; the 18 non-Dubai rows are written
nowhere by this script (Sharjah has no contour in this platform at all;
the Abu Dhabi rows could become a future `abu-dhabi-lead-matching-service`
import, a separate decision, not bundled into this one).

**New reusable piece**: `src/core/xlsx-reader.js`, a from-scratch minimal
`.xlsx` reader (`yauzl` for the zip container + a hand-written OOXML cell/
row regex extractor), NOT the `xlsx` (SheetJS) npm package — its last
npm-published version (0.18.5) has two unpatched high-severity advisories
(prototype pollution, ReDoS, no fix available). `exceljs` was tried first
and rejected: it fails outright on this file, because Google Sheets'
"Download as .xlsx" export uses a non-default XML namespace prefix
(`<x:workbook>`/`<x:sheet>`/`<x:row>`/`<x:c>` instead of the unprefixed
default) that exceljs's strict parser doesn't accept. A real bug was found
and fixed while building this: a naive greedy regex for cell boundaries
mishandled self-closing blank cells (`<x:c r="J2"/>`), swallowing the next
real cell and shifting every later column in that row left by one —
caught by testing against the real file before any write, fixed with a
lazy quantifier, and covered by a synthetic fixture
(`tests/fixtures/xlsx/sample-pocket-stock.xlsx`) reproducing the exact
shape (self-closing blank cell, shared strings, Cyrillic text, an XML
entity) in `tests/unit/xlsx-reader.test.js`.

**Source provenance**: `matching_dubai.stock_inventory.stock_source`
(added unused by migration 0009, 2026-?) is now actually written —
every row this importer upserts is tagged `stock_source = 'POCKET_LISTING'`,
distinguishing it from the main sync's implicit `'GOOGLE_SHEETS'` default.
`src/db/stockRepository.js`'s `upsertStock` had no other live caller
(confirmed: only tests referenced it before this script), so this was a
safe, non-breaking addition.

Same dry-run/`--write`/`*_ALLOW_WRITE` discipline as every other sync
script (AGENTS.md section 10): `DUBAI_POCKET_STOCK_IMPORT_ALLOW_WRITE=true`
in `.env` plus `--write` on the command line, confirmed with the user
before the first real write.

## ADR-047 — Abu Dhabi's AI parser prompt was still asking the model to classify "a Dubai real-estate message"

2026-10-07. User request: "проверь что критерии метчинга не перенесены с
учётом ключевых слов содержащих Дубай" (check that matching criteria were
not carried over with keywords containing "Dubai"). Audited
`abu-dhabi-lead-matching-service` end to end for leftover Dubai-specific
content from its BY-ANALOGY build (ADR-044): matcher (`src/matching/*`),
normalization (`structured-request.js`), schema validation (`schema.js`),
and the live `matching_abu_dhabi.matching_aliases`/`stock_inventory` data
are all clean — genuinely Abu Dhabi-specific, data-driven, no hardcoded
Dubai values (a few shared area names like Al Jurf/Saadiyat/Yas overlapping
Dubai's own stock are real coincidental geography, not contamination).

One real bug found: `src/parser/prompt.js`'s `SYSTEM_PROMPT` — sent to
OpenAI on every single Abu Dhabi message — was a byte-for-byte copy of
Dubai's prompt, opening with "Classify a Dubai real-estate social message"
and using Dubai area names (Business Bay/Marina/JVC/Arabian Ranches/Dubai
Silicon Oasis/Bur Dubai) in every classification example. RF's own
`prompt.js` was correctly re-expressed for Moscow when it was built
("Классифицируй сообщение о недвижимости в Москве..."); Abu Dhabi's never
was. Fixed: the opening line now says "Abu Dhabi", and every example area
name was swapped for a real Abu Dhabi one (Al Reem Island, Khalifa City,
Al Raha Beach, Yas Island) already present in `matching_abu_dhabi`'s own
seeded alias/stock data. `budget_min`/`budget_max`'s "AED numbers" wording
was left as-is — both Dubai and Abu Dhabi genuinely use AED, so that part
was never wrong. No test asserted on the literal prompt string; full Abu
Dhabi suite (168 unit + integration tests) still green after the fix.

## ADR-046 — Channel/route/account filters on /requests and /history; Dubai and Abu Dhabi stop dropping account_id/chat_id

2026-10-07. User request: "http://localhost:8094/history
http://localhost:8094/requests оба раздела не имею нормального фильтра по
каналу, маршруту, аккаунту" (both dashboard pages lack a proper filter by
channel, route, account). Investigation found this was two real gaps, not
just a missing UI control:

1. Dubai's and Abu Dhabi's pipelines both already had `account_id`/`chat_id`
   at matching time (`unifiedMessage.account_id`/`chat_id`; Abu Dhabi's
   `insertMatchRun` even destructured `accountId`/`chatId` as dead
   parameters) but neither `matching_dubai.match_runs` nor
   `matching_abu_dhabi.match_runs` had the columns, so the data was
   silently dropped on every insert. RF's own `matching_moscow.match_runs`
   already had and correctly persisted both (migrations 0018/0032) — RF was
   the one service doing this right.
2. Only Dubai had dashboard views (`v_request_matches`/`v_match_history`,
   migration 0008) at all. Abu Dhabi has had a real matcher live since
   ADR-044, and Moscow has had real matching live since ADR-042/ADR-038,
   but neither had anywhere on the dashboard to view its own
   requests/history.

Fix (migration `0042_match_runs_channel_account_dashboard_views.sql`):
added `account_id`/`chat_id` columns to Dubai's and Abu Dhabi's
`match_runs`; wired both pipelines to actually pass them through; added
`provider`/`account_id`/`chat_id`/`group_name` to Dubai's existing views;
created the same views for Abu Dhabi (identical column shape to Dubai's,
since its stock schema is a verbatim port) and for Moscow — deliberately
using Moscow's own native column names (`stock_joker_object_id`,
`district`/`complex`/`property_type_raw`/`price`/`agent_name`/
`agent_phone`) rather than relabeling them to Dubai's, per AGENTS.md
section 0 ("Do NOT make RF criteria fit Dubai fields or vice versa").
`dashboard/queries.js`'s `getRequestMatches`/`getMatchHistory` are now
schema-parameterized (`MATCH_RUNS_SCHEMAS` allow-list, same discipline as
`VALID_MATCH_COUNT_SCHEMAS`) with a new `hasMatchRuns` flag on `MARKETS`
distinguishing Dubai/Abu Dhabi/Moscow (real match_runs) from Oman/Saudi/
Turkey (stock visibility only, no matching logic — AGENTS.md section 0).
`/requests` and `/history` gained a market tab bar (same pattern as
`/stock`) and `provider`/`accountId`/`chatId` filter fields, uniform
across all three markets since those columns are now uniform too.

Purely additive/observability — no matching-semantics change, so this
doesn't touch the hard boundaries in AGENTS.md section 0 beyond the
dashboard already reading across schemas for display (same as the
existing `/stock` page).



2026-10-06. User request: "нужно добавить возможность выбора чатов телеграм
и ватсап групп несколько маршрутов" (need to add the ability to select
several routes for Telegram and WhatsApp group chats). Until this change,
`ingest.source_routes.route_mode` was a single value
(`DUBAI | RF | SAUDI | ABU_DHABI | BOTH | AUTO | NONE`); the only way to
route one source to more than one contour was `BOTH`, hardcoded to the
single pair `[DUBAI, RF]` (`src/sources/route-resolver.js` — confirmed
dead code during this change, zero live `require()` callers, only its own
test file). There was no way to route a source to, say, Dubai + Abu Dhabi,
or RF + Saudi, or three markets at once.

**Decision — array column, not a junction table**: `route_mode` (TEXT)
became `route_modes` (TEXT[]) via migration `0041_multi_route_source_
modes.sql`. Renamed, not just retyped, so a leftover scalar reference (a
stale `r.route_mode = $1` SQL string, a stale `patch.routeMode` in JS)
fails loudly with "column/field does not exist" instead of silently
comparing a string to an array and always being false — same deliberate-
rename-for-safety reasoning as the Dubai rename (ADR-043). Old `BOTH` rows
were converted losslessly to the literal `['DUBAI', 'RF']` array at
migration time — now just one of many possible combinations, not a magic
word.

`AUTO` and `NONE` remain mutually-exclusive sentinel states: a row may hold
`['AUTO']`, `['NONE']`, or any non-empty subset of the four real market
labels — never a sentinel mixed with a real label or with each other.
Enforced at two independent layers (same discipline as `config-
validation.js`'s `isLocationKey` for `location_*` settings):
- DB: `source_routes_route_modes_valid` CHECK constraint.
- Application: `src/sources/source-repository.js`'s new
  `validateRouteModes()`, called from `updateSourceRoute`/
  `bulkUpdateSourceRoutes` before any write; an invalid combination is
  rejected with `{ ok: false, error }` rather than silently written, and
  the dashboard's auto-saving row control now surfaces that error (a real
  HTTP 400) instead of claiming success.

**Each matcher's own gate** (`dubai-lead-matching-service`/
`rf-lead-matching-service`/`abu-dhabi-lead-matching-service`'s own
`src/gates/source-routing.js` — three independent files, stayed that way)
switched from scalar equality to array membership
(`routeModes.includes('DUBAI')` etc.) — a small, mechanical change to each
already-existing, independent `lookupSourceRoute`. Dubai's gate also
**consolidated its three per-other-contour rejection reasons**
(`source_routed_to_rf_contour` / `_saudi_contour` / `_abu_dhabi_contour`)
into one generic `not_dubai_eligible`, matching the naming convention RF's
and Abu Dhabi's own gates already used — with arrays, "routed to the
others" can now mean more than one market at once, so naming just one
would be misleading. `src/db/route-reject-cleanup.js`'s own
`DUBAI_ROUTE_REJECT_REASONS` allow-list (added the day before, ADR/route-
reject-cleanup work) was updated in the same change so the cleanup job
doesn't silently stop recognizing Dubai's route-gate noise.

`src/sources/route-resolver.js` was deliberately left untouched — it is
genuinely dead code and modeling arrays there for zero behavioral benefit
was out of scope.

**Dashboard UI** (`dashboard/sources-view.js` + `dashboard/server.js`):
the per-row route `<select>` became a checkbox group (`DUBAI`/`RF`/
`SAUDI`/`ABU_DHABI`/`AUTO`/`NONE`, `name="routeModes"`, a hidden empty
sentinel so "uncheck everything" still submits the field as `NONE`), with
small client-side JS enforcing AUTO/NONE exclusivity (UX convenience only
— the real enforcement is the two layers above). `sourceControlsScript()`'s
auto-save logic was generalized from "snapshot/restore one control" to
"snapshot/restore the whole form via FormData" to support a multi-checkbox
group. The filter dropdown and the bulk-apply control deliberately stayed
single-select (a containment filter / "apply this one route to N selected"
don't need multi-select) — just renamed to `routeModes` for consistent
backend parsing and trimmed of `BOTH`.

**Found and fixed along the way (unrelated to the feature itself, surfaced
by running the full test suite after the change)**: `pool.connect()`'s
checked-out client in `config-repository.js`'s three transaction functions
(`loadActiveV2Config`/`applyDraft`/`rollbackToVersion`) and in
`src/db/migrate.js` had no `client.on('error', ...)` listener — this had
already crashed `rf-lead-matching-service` once in production earlier the
same day (an SSH-tunnel hiccup mid-transaction threw an unhandled 'error'
event and killed the process; `pool.js`'s own error handler only covers an
*idle* client, not one checked out for a transaction). Fixed by attaching
a named listener and removing it again on release (the first attempt
leaked one listener per call onto the same physical pooled connection,
surfaced as a `MaxListenersExceededWarning` while running Dubai's own
integration suite for this change).

**Deliberately not done**: `BOTH` is not kept as a deprecated-but-readable
alias anywhere — any code or UI that still said `BOTH` now says the
explicit array instead. No migration path for in-flight `route_mode`
reads was needed since the rename is a hard break by design (see above).

## ADR-044 — Abu Dhabi: new market contour, built BY ANALOGY with Dubai, separate engine and DB

2026-10-05. User request: "создай новый рынок Абу Даби и сделай по аналогии
настройки как в Дубай но отдельный движок и БД" — the `DUBAI` rename (ADR-043,
same day) explicitly made room for this. Clarifying questions asked and
answered before building: stock source = Google Sheets (the mechanism Dubai
itself originally used, now dead for Dubai — see below); zero existing
sources pre-assigned `ABU_DHABI` (a clean bootstrap, same starting state
`SAUDI` had); a separate, dedicated Telegram bot; full working matching from
day one (not RF's original skeleton-first rollout); a Google service account
already exists (key to be supplied later), and an empty test Google Sheet
would be created now for structural testing ahead of it.

**Why BY ANALOGY, not a shared matcher**: AGENTS.md section 0 forbids one
universal Dubai+RF(+Abu Dhabi) request schema, shared stock tables, or
shared interpretation caches — even though Abu Dhabi's business semantics
are IDENTICAL to Dubai's (same AED currency, same area/project/building/
bedrooms field model, same 50/30/15/5 ranking weights), unlike RF's
genuinely different fields (rooms vs bedrooms, rubles, two-tier location
hierarchy). So Abu Dhabi's "own copy" files are near-verbatim ports of
Dubai's own copied code, not a redesign — but still a real, separate
service/schema/process, never a parameterized branch of Dubai's.

**Scaffold base — a deliberate pivot during the build**: initially scaffolded
from `dubai-lead-matching-service/` itself (the obvious "BY ANALOGY" source),
but this pulled in Dubai's full organically-grown complexity (ai_usage_log,
event_dedup retry-state-machine, shadow_gate, brokers/telegram_bots tables) —
none of which even RF has, and none of which "a complete, working matcher"
requires. Self-corrected: re-scaffolded from `rf-lead-matching-service/`
instead (RF's leaner, already-proven "new contour" shape/orchestration —
route check → cutover check → content-hash dedup → intake gate → AI parse →
match → persist → notify), then overlaid Dubai's actual matching-specific
files (parser, `matching/*`, `normalization/structured-request.js`) on top,
since Abu Dhabi needs Dubai's exact field semantics but RF's lean shape. The
10-table `matching_moscow` schema (not Dubai's ~27-table one) was confirmed,
via `information_schema` plus a grep of Dubai's own matching/candidate-query/
hard-filters code, to be the complete, sufficient set — none of Dubai's
extra migration-0009 broker-provenance columns are read by any matching
code.

**What was built:**

1. **DB** — `matching_abu_dhabi.*` schema (migration
   `0036_matching_abu_dhabi_schema.sql`): `stock_inventory` (Dubai's original
   sheet-era 21-column shape, recovered in full from git history — see
   below) / `matching_aliases` / `stock_sync_runs` / `match_runs` (including
   a `reason` column Dubai's own match-repository never needed, since Abu
   Dhabi's pipeline — RF-shaped — persists gate/route rejections through
   `insertRejectedRun`/`insertNotImplementedRun`, which Dubai's pipeline
   handles differently) / `match_results` (`UNIQUE(source_message_id,
   stock_id)`) / `runtime_settings` / `intake_rules` / `config_versions` /
   `config_draft` / `message_interpretation_cache`. Migration
   `0037_add_abu_dhabi_route.sql` adds `ABU_DHABI` to
   `ingest.source_routes.route_mode`'s CHECK constraint, additive-only,
   mirroring `0024_add_saudi_route.sql`'s exact style. Migration
   `0038_matching_abu_dhabi_settings_seed.sql` seeds version-1
   runtime_settings/intake_rules (copied verbatim from
   `matching_dubai`'s own migrations 0020/0023 — same English/Russian
   buyer-message vocabulary, brand-new contour with no operational history
   of its own yet) — added after discovering 0036 alone left the Settings
   UI and the V2 intake gate with nothing to read, the same role 0029
   played for Moscow.
2. **Service** — `abu-dhabi-lead-matching-service/`, port 8097. Own copies
   (BY ANALOGY): `src/parser/*`, `src/matching/*` (candidate-query/
   diagnostics/location-dictionary/transaction-semantics schema-name
   string-replaced to `matching_abu_dhabi`; the other matching files have
   zero schema references, copied verbatim), `src/normalization/
   structured-request.js`, `src/repositories/{match,stock}-repository.js`,
   `src/gates/source-routing.js` (own `isAbuDhabiEligible(routeMode) {
   return routeMode === 'ABU_DHABI'; }` — deliberately no `BOTH`/`AUTO`:
   `BOTH` is hardcoded to `['DUBAI','RF']` in `src/sources/
   route-resolver.js`, `AUTO` defaults to Dubai, extending either to a
   3-way concept is separate work). Thin re-export wrappers (RF's exact
   pattern): `src/gates/v2-intake-gate.js`, `src/adapters/index.js`,
   `src/notifications/telegram-sender.js`, `src/repositories/
   config-repository.js` (`schema: 'matching_abu_dhabi'`, ~18 lines).
   `src/notifications/render.js` turned out to need NO custom formatting at
   all (simpler than RF) — Dubai's own `formatMatchEntry` already reads raw
   stock fields directly (`building`/`project_community`/`area`/`bedrooms`/
   `transaction_type` + `transaction-semantics.js`'s `priceFieldForStock`),
   so it is a 1-line re-export of Dubai's module, not a custom wrapper.
   `src/services/pipeline.js` combines RF's orchestration shape with
   Dubai's matching calls; isolation (pipeline.js never `require()`s
   `dubai-lead-matching-service` or `rf-lead-matching-service` directly) is
   enforced by both a unit test and an integration test, mirroring RF's own
   precedent.
3. **Tests** — the scaffold's copied RF/Moscow test files tested the wrong
   semantics entirely (district/complex/rooms/₽ against code that actually
   speaks area/project/building/bedrooms/AED) and were replaced: matching-
   logic tests (`hard-filters`, `matcher`, `scoring`, `candidate-query`,
   `parser-schema`, `anti-hallucination`, `location-dictionary`,
   `transaction-semantics`, `structured-request`, `diagnostics`,
   `notification-render`) ported from Dubai's own suite, unmodified (same
   code under test, verbatim); `source-routing.test.js` and
   `pipeline.test.js` rewritten for Abu Dhabi's actual shape
   (`isAbuDhabiEligible`, `aliasRepo.loadAliasIndex`, `insertRejectedRun`/
   `insertNotImplementedRun`). 155 unit tests, 9 integration tests (against
   a disposable Postgres, migrations 0001-0038 applying cleanly), all
   green; root (80), Dubai (378), and RF (83) suites confirmed unaffected.
   The service was also boot-tested against the real dev DB (health check,
   a webhook call correctly rejected as `source_not_catalogued`).
4. **Google Sheets stock sync** (Phase 3, new from scratch — nothing like
   it existed in the repo; Dubai's own original sync was n8n-orchestrated
   and deleted in ADR-040, its OAuth2 credential already expired). Added
   `googleapis` as a root dependency. `src/google-sheets/sheets-client.js`
   — service-account auth (`GOOGLE_SERVICE_ACCOUNT_JSON`, a path or inline
   JSON, never committed), not the old OAuth2 flow (a service account
   never expires that way, just needs the sheet shared with it once).
   Reused `src/core/sync-normalize.js` as-is for row validation/status-
   mapping/dedup — it already existed, untouched since ADR-040 deleted its
   only caller, and is already market-agnostic. New root repositories
   (`src/db/abuDhabi{Stock,Alias,StockSync}Repository.js`, siblings of the
   existing Dubai-hardcoded ones). New script
   `scripts/abu-dhabi-sheet-stock-sync-run.js`, mirroring
   `scripts/joker-stock-sync-run.js`'s exact dry-run discipline (`--write`
   flag AND `ABU_DHABI_SHEET_SYNC_ALLOW_WRITE=true` both required to
   write). The exact sheet column contract (21 stock columns, 5 alias
   columns) was recovered in full from git history
   (`git show e233bd84^:n8n/code/stock-sync/validate-normalize-stock.js`,
   the deleted n8n Code node that validated Dubai's original sheet rows).
   An empty test spreadsheet ("Abu Dhabi Stock Inventory (Nika Estate) —
   TEST") was created with the Stock Inventory header row populated,
   confirming the 21-column contract end-to-end; it has one tab, not the
   full two-tab (Stock Inventory + Aliases) structure, since the available
   Drive tooling creates/uploads single-tab spreadsheets only — a second
   "Aliases" tab (`type,alias,canonical,parent_area,enabled`) needs to be
   added manually, same as renaming the existing tab if its default name
   doesn't match `ABU_DHABI_GOOGLE_SHEETS_STOCK_TAB`.
5. **Telegram bot** — a dedicated bot (`@abudhabimatches_nika_bot`) created
   live via one `POST /telegram/bots/create` call to the running
   telegram-worker (account `tg_main`), per the user's confirmed
   "separate bot" decision. Token wired into the service's local `.env`
   (gitignored, never committed). `ABU_DHABI_TELEGRAM_MATCH_CHAT_ID` and
   `ABU_DHABI_TELEGRAM_NOTIFICATIONS_ENABLED` are left for the user to set
   once the bot is added to a real chat.
6. **Dashboard + routing** — `dashboard/sources-view.js`'s
   `ROUTE_MODES`/`ROUTE_LABELS` gained `ABU_DHABI: 'Абу-Даби'`.
   `dashboard/abu-dhabi-settings-queries.js` (new, thin re-export mirroring
   `moscow-settings-queries.js`). `dashboard/server.js`'s ~15 inline
   `query.market === 'moscow' ? 'moscow' : 'uae'` ternaries were refactored
   into one `resolveSettingsMarket(market)` helper + a
   `SETTINGS_QUERIES_BY_MARKET` dispatch table (`uae`/`moscow`/
   `abu_dhabi`) — a 3rd copy of each ternary was exactly the kind of drift
   risk (a missed call site silently keeps treating Abu Dhabi as UAE) this
   removes; the Settings page's market tab bar gained an "Абу-Даби" tab.
   `telegram-worker/worker_api.py`'s `route_mode` `Literal` gained
   `ABU_DHABI` — and, noticed in passing, a pre-existing gap where `SAUDI`
   was also missing from that same list despite migration 0024 already
   allowing it at the DB level; fixed both together.
   `dubai-lead-matching-service/src/gates/source-routing.js` gained an
   explicit `source_routed_to_abu_dhabi_contour` rejection branch (cheap,
   matches the existing RF/SAUDI rejection clarity), and its stale top
   comment (predicting "a future ABU_DHABI label will be the same kind of
   placeholder [as SAUDI]") was corrected now that it is a real contour
   instead.
7. **Docs** — `AGENTS.md` section 0 ("TWO independent domain contours" →
   "THREE", ASCII diagram, DB ownership table, a new `ABU_DHABI`
   explanation paragraph) and `docs/MARKET_CONTOURS_AND_SOURCE_ROUTING.md`
   (routing enum throughout, new `ABU_DHABI` paragraph, DB-separation
   examples). Historical records left untouched on principle, same as
   every prior rename/addition.

**Deliberately not done / left for the user**: real Abu Dhabi stock data
and the service-account JSON key are still needed before the sheet sync can
run against real data (the dry-run path and schema/contract are fully built
and tested without them); the test spreadsheet's second "Aliases" tab needs
manual creation; `ABU_DHABI_TELEGRAM_MATCH_CHAT_ID` needs the bot added to a
real chat; `BOTH`/`AUTO` routing was not extended to a 3-way concept
(Abu Dhabi only accepts an explicit `ABU_DHABI` route for now).

## ADR-043 — UAE contour renamed to Dubai: service, schema, and routing label

2026-10-05. User request: "переделай маршрут ОАЭ в дубай потому что у нас
ещё будет Абу-Даби маршрут он тоже относится к ОАЭ но другой рынок" — a
second, distinct UAE-country market (Abu Dhabi) is coming, so the
undifferentiated "UAE" bucket (service, schema, and routing label all named
after the country) could no longer stand for one city. Renamed to name the
market actually served today, so `ABU_DHABI` can be added later as a true
sibling — the same pattern `SAUDI` already established (migration 0024): a
routing label can exist before its own dedicated contour does.

User confirmed the deep option (service + schema + routing label, not just
the routing label alone) after being shown the blast radius of each.

**Renamed, in dependency order (each phase tested — root/Dubai/RF full
suites green — before the next):**

1. **Routing label** — `route_mode='UAE'` → `'DUBAI'` in
   `ingest.source_routes` (migration `0034_rename_uae_route_to_dubai.sql`,
   modeled on 0024's constraint-swap style; all 64 existing `UAE` rows
   reclassified to `DUBAI` in the same migration — a pure rename, not an
   ambiguous split like Saudi's, so no separate operator-run reclassify
   script was needed). Code: `isUaeEligible` → `isDubaiEligible`
   (`src/gates/source-routing.js`), `route-resolver.js`'s evidence/contour
   constants, `dashboard/sources-view.js`'s `ROUTE_MODES`/`ROUTE_LABELS`
   (`DUBAI: 'Дубай'`, not "ОАЭ" — needs to read as a city now that Abu
   Dhabi is a sibling), `telegram-worker/worker_api.py`'s `route_mode`
   `Literal`.
2. **DB schema** — `matching_uae.*` → `matching_dubai.*` (migration
   `0035_rename_matching_uae_to_matching_dubai.sql`, an exact structural
   copy of 0027's `matching`→`matching_uae` rename, including its warning
   about the real production incident an uncoordinated version of that
   rename caused — see ADR-034). `src/db/migrate.js`'s
   `resolveBookkeepingSchema` extended to a 3-way priority chain
   (`matching_dubai` → `matching_uae` → `matching`). Every hardcoded
   `matching_uae` schema-default string across `src/db/*Repository.js`,
   `lead-matching-service/src/{repositories,matching,gates,config}/*`,
   `dashboard/*.js`, and all affected tests was replaced with
   `matching_dubai` — the 5 historical migration files that reference
   `matching_uae` as a fact of their own time (0017/0027/0028/0029/0032)
   were deliberately left untouched, same convention as every prior rename
   in this repo.
3. **Service directory** — `lead-matching-service/` → `dubai-lead-matching-
   service/`. `git mv` failed with "Device or resource busy" (a file
   handle held by a running process or IDE watcher) even after stopping
   every known Node process using that directory; worked around by copying
   the tree to the new path and removing the old files individually (`git
   status` confirmed all 117 tracked files as pure renames, `-M` diff
   showing only the intentional UAE→Dubai text edits as content changes —
   history fully preserved despite not using `git mv` directly). The old,
   now-empty `lead-matching-service/` directory could not be `rmdir`'d for
   the same lock reason; added to `.gitignore` as a harmless leftover
   (same pattern as `nika-matching-pilot-starter/`). Fixed the 12
   externally-literal references this broke (require() paths in
   `dashboard/`, `rf-lead-matching-service/`, and root `tests/`; a
   string-match isolation assertion in `rf-lead-matching-service/tests/
   unit/pipeline.test.js`; two `.dockerignore` rules; the Docker build/run
   example in `docs/OPERATIONS_ACCESS.md`) plus the service's own
   `package.json` name and remaining "UAE contour" prose/comments across
   both services for consistency.
4. **Docs** — `AGENTS.md` section 0 (contour name, hard rules, DB
   ownership table, a new `DUBAI` explanation paragraph modeled on the
   existing `SAUDI` one, noting Abu Dhabi as the anticipated next sibling
   label) and §5/§6/§12 matcher references; `docs/MARKET_CONTOURS_AND_
   SOURCE_ROUTING.md` (routing enum throughout, new `DUBAI` paragraph);
   `docs/OPERATIONS_ACCESS.md`, `rf-lead-matching-service/README.md`,
   `README.md`, `PROMPT_VSCODE.md`, `docs/TESTING.md`, `docs/MINI_PILOT_
   SPEC.md`, `docs/BROKER_ROUTING_AND_NOTIFICATIONS.md`, `docs/DASHBOARD_
   OPERATOR_GUIDE.md`. Historical records left untouched on principle (same
   as every prior rename): `docs/DECISIONS.md`'s own earlier ADR bodies,
   `AGENTS_NIKA_MATCHING_V2.md` and `docs/PER_MARKET_SERVICE_INDEPENDENCE_
   PLAN.md` (both explicitly self-declared historical snapshots), and
   dated factual sentences like "57 sources were marked UAE on 2026-09-27"
   in the operator guide.
5. **Live deploy** — migration 0035 (schema rename) was applied to the dev
   database and `dubai-lead-matching-service`/`dashboard`/`rf-lead-
   matching-service` were restarted in the same coordinated step (per
   ADR-034's lesson), not separately. Verified live afterward: real
   Telegram traffic flowing through with `source_route_mode: "DUBAI"`,
   zero errors, AI calls and dedup checks succeeding against
   `matching_dubai.*`.

**Deliberately not done**: `rf-lead-matching-service` itself was not
renamed (RF is unaffected by this change — it already has its own
contour/schema/service identity); `matcher_version` string literals
(`"lead-matching-service-v1"` etc., stored historically in `match_runs`
rows) were left as-is, since changing them is a separate versioning
decision, not part of this naming rename, and touching them would create
inconsistency between old and new rows without a clear benefit; a real
`ABU_DHABI` contour (schema + service) was NOT built — only the `DUBAI`
rename makes room for it later, per the user's own framing ("ещё будет").

## ADR-042 — RF (Moscow) rental requests enabled: gate whitelist gap closed, RENT path tested end-to-end

2026-10-05. A status audit of the RF contour found zero real `MATCH` ever
produced despite ~230 monitored sources and ~12,100 messages/week reaching
the intake gate. Root cause: `matching_moscow.intake_rules`'s WHITELIST
(seeded migration 0029, copied from UAE's buy-side vocabulary) had zero
coverage for the tenant-seeking rental verb ("сниму"/"снять"), even though
the BLACKLIST correctly blocks its landlord-offer mirror
("сдам"/"сдаю"/"сдаётся"/"сдается"). Two live, unambiguous rental buyer
requests (one with an explicit budget, one with budget + phone number) were
confirmed wrongly rejected as `INSUFFICIENT_BUYER_SIGNAL` and never reached
the AI parser.

A code audit found the rest of the pipeline was already RENT-capable by
design, just never exercised: `rf-lead-matching-service/src/parser/
schema.js`'s `transaction_type` enum, `hard-filters.js`'s `dealTypeFilter`,
and `candidate-query.js`'s SQL all already branched correctly on
`SALE`/`RENT`. Live Moscow stock has 840 available rental listings.

**Changes:**
- `sql/migrations/0033_matching_moscow_rental_whitelist.sql` — adds 6
  WHITELIST phrases (`сниму`, `ищу снять`, `хочу снять`, `снять квартиру`,
  `ищу аренду`, `нужна аренда`), idempotent/guarded. Already applied to the
  live dev database via the real Draft→Apply admin mechanism
  (`addDraftRule`/`applyDraft`, the same one `/settings?market=moscow`
  uses) as config_version 6; the migration makes the fix durable across
  every other environment (CI, disposable test DBs, future deploys).
- `rf-lead-matching-service/src/parser/prompt.js` — added a worked rental
  example ("Сниму квартиру в Строгино...") alongside the existing sale/
  seller examples, since none existed before.
- New test coverage: `hard-filters.test.js` (RENT-vs-rent passes, RENT-vs-
  sale fails), `candidate-query.test.js` (RENT pushes `deal_type = 'rent'`),
  `parser-schema.test.js` (`transaction_type: 'RENT'` round-trips), and one
  new integration test in `api.integration.test.js` sending the real text
  "Сниму 2-комнатную в ЮЗАО..." through the actual gate to a real `MATCH`
  against seeded rent stock — proving the whitelist fix and the RENT code
  path together, not just in isolation.
- Re-ran `scripts/joker-stock-sync-run.js --write` for Moscow/Turkey (stock
  was 7 days stale; sale/rent split unaffected by this — stock freshness
  only, no mapping change).

**Verified, no code change needed:** sampled live `deal_type='rent'` stock
prices — the bulk of residential listings are plausible monthly RUB
figures (e.g. 35,000-80,000 for studios/1-2-room apartments), confirming
`priceFilter`'s direct `price` vs. budget comparison is valid for rent the
same way it is for sale. **Found but deliberately out of scope for this
change:** a small cluster of garbage rent prices (several 100M+ RUB
"monthly rent" values, one listing priced at 1 RUB) — same class of Joker
data-quality defect as the UAE duplicate/zero-price findings
(`docs/JOKER_API_DISCOVERY.md`). These fail safe today (an ordinary buyer's
budget filter naturally excludes them), so no NEEDS_REVIEW-style defense
was built for Moscow rent prices as part of this change — flagged here for
the user to verify in Joker CRM, same standing practice as the UAE pricing
findings.

## ADR-041 — Personal notification bots per Joker broker, created via @BotFather

2026-10-04. Each broker linked to Joker CRM (`broker_external_identities.source = 'JOKER'`)
gets a personal Telegram notification bot. Telegram has no bot-creation API, so
`telegram-worker` drives @BotFather with an authorized user session
(`telegram_botfather.py`, `POST /telegram/bots/create`; transport only, no DB).
`scripts/export-joker-brokers.js` (read-only) lists the brokers as `id|name`;
`tools/telegram_create_broker_bots.py` creates the bots (resumable, delayed,
stops on BotFather limit) and records every result in ONE markdown list,
`telegram-worker/state/broker_bots.md` (gitignored). Tokens are stored in
plain text by user decision. Writing bots into `matching_uae.telegram_bots` /
linking brokers via `/start` is deliberately a later step.

## ADR-040 — Legacy n8n matching-pilot tooling fully removed

Decision date: 2026-10-02, explicit user request ("удали совсем legacy" →
"папку n8n тоже удаляем"). Confirmed via the n8n REST API before deletion:
the "NIKA PILOT - Matching" workflow was `active: false` on the real n8n
server — the active matchers have been `lead-matching-service`/
`rf-lead-matching-service` for some time (ADR-037), not an n8n Code node.

**Deleted** (all tracked in git, fully recoverable from history):
- `n8n/` in full (`workflows/nika-pilot-matching.json`,
  `workflows/nika-pilot-stock-sync.json`, `code/matching/`,
  `code/stock-sync/`).
- `scripts/build-workflows.js`, `scripts/n8n-plan.js`,
  `scripts/n8n-deploy.js`.
- `scripts/templates/` (`matching-workflow.js`, `stock-sync-workflow.js`)
  and the `scripts/lib/` files only those templates used
  (`pilot-workflows.js`, `n8n-client.js`, `sql-snippets.js`,
  `bundle-code-node.js`, `workflow-builder.js`) — `scripts/lib/
  docker-postgres.js` was kept, it's shared with the real disposable-
  Postgres test harness used by all three services.
- `tests/contracts/` in full (`workflow-contracts.test.js`,
  `stock-sync-metrics.test.js`) — both existed solely to validate
  generated n8n workflow JSON; with no n8n JSON left to generate, the
  entire "contract tests" layer had no remaining subject matter.
- The empty, already-`.gitignore`d `nika-matching-pilot-starter/`
  directory (see ADR-039's own earlier note on it being a stale,
  untracked duplicate of this repo).

**`npm run test:contracts`/`build:workflows`/`n8n:plan`/`n8n:deploy`**
removed from `package.json` and from AGENTS.md §13's required-commands
list. AGENTS.md §10 (n8n workflow rules) and §12's "Contract tests"
subsection are kept in place but marked **RETIRED**, not deleted —
historical record of the rules that applied while that tooling existed,
per this project's established "ADR-037-style" convention of marking
superseded material explicit rather than rewriting history.

**What this does NOT affect**: the "NIKA PILOT - Stock Sync" n8n workflow
itself keeps running (or failing — it's been broken by an expired Google
OAuth token since 2026-09-25, a separate, still-open issue) directly on
the real n8n server. It is stored and versioned there independently of
this repository now; redeploying or editing it in the future means
working directly in the n8n UI, not regenerating JSON from this repo's
(now-deleted) templates.

Full test suite (`npm test`) re-run green after this change: unit +
integration, no contract-test layer remaining.

## ADR-039 — External "canonical ЖК registry" proposal: adopted the grounded data, declined the parallel architecture

Decision date: 2026-09-29. The user pasted a 21-section spec from an
external conversation proposing a full canonical-complex model for Moscow
matching (`complex_id`/`region`/`district`/`moscow_area`/aliases-array
JSON records, a `chat_type` enum, Telegram-username-to-complex linking, an
"ambiguous alias" review queue, and a fuzzy-matching priority hierarchy),
explicitly asking that it NOT be implemented 1:1 and that any adoption
stay careful and within this project's own rules. Alongside it, the user
supplied `Telegram_чаты_Москва_с_округами.xlsx` — a real, hand-verified
audit of 1625 Moscow-region Telegram groups (1521 confirmed city-of-Moscow
with округ/район, 104 excluded as область/ЗелАО/ambiguous, 0 left
unverified).

**Decision — decline the parallel architecture, adopt the grounded data:**

- The proposed `complex_id` registry, `chat_type` enum, ambiguous-status
  column, and Telegram-username linking table were NOT built. The existing
  `matching_moscow.location_aliases` table (migration 0025) plus
  `alias-cache.js`/`location.js` already implement the exact "normalize →
  exact alias lookup → canonical value" model the spec itself describes —
  a second, parallel registry alongside it would duplicate rather than
  replace it, which both AGENTS.md §0 and the spec's own instruction
  ("не создавай параллельную систему, если нужный слой уже существует")
  rule out. AGENTS.md §8 already forbids fuzzy matching as primary
  behavior, so the spec's fuzzy-priority-ladder and ambiguous-alias
  review queue have no real problem to attach to today — nothing in this
  matcher produces a fuzzy or ambiguous match.
- The Excel's data WAS used, but only where independently cross-checked
  against real `matching_moscow.stock_inventory`, never imported blindly:
  - Its 514 unique canonical project names were matched against real
    `stock_inventory.complex` (available=true) → 69 direct hits. 3 were
    excluded after manual review ("Headliner", "Жилой квартал Lucky",
    "RED7" each have TWO conflicting real stock spellings — with vs
    without a parenthetical transliteration — for what looks like one
    physical building; a genuine Joker-sync data-quality gap, not
    something a one-directional alias can safely resolve, left as a
    known issue rather than silently guessed). One more ("Rotterdam") was
    excluded because its real stock value contains an invisible LRM
    character that could not be hand-transcribed reliably. The remaining
    65 were added as new `complex`-type aliases via
    `scripts/seed-moscow-location-aliases.js` (64 were genuinely new; one,
    "City Bay", was already effectively covered but harmlessly
    re-added as a self-referential row). The other 445 canonical names
    have no matching real stock complex and were left unmined — honestly
    absent rather than guessed, per AGENTS.md §8.
  - ТиНАО/Новая Москва got 4 new `district`-type aliases ("Новая Москва",
    "ТиНАО", "Коммунарка" → `Новомосковский`; "Троицк" → `Троицкий`),
    grounded in real (if thin) stock coverage: 25 rows tagged
    `district='Новомосковский'`, 2 rows `district='Троицкий'`.
  - Cross-referencing the Excel's 1521 verified groups against
    `ingest.sources.username_or_handle` found only 6 already-joined by
    either Telegram session (`tg_main`/`nikaestate_ae`) — our sessions are
    members of very few of the Excel's 1521 groups. Those 6 (ЖК Прокшино
    Основной Чат, ЖК Дмитровский парк, ЖК Волоколамское 24, ЖК
    Дмитровское Небо от ЛСР, ЖК Дмитровское небо, Дмитровское небо ЖК)
    got `monitoring_enabled=true` in `ingest.source_routes` (one also
    needed `route_mode` corrected from `NONE` to `RF`) and their chat_ids
    added to `telegram-worker/.env`'s `TELEGRAM_MONITOR_CHAT_IDS`.
- **Explicitly deferred, not decided against**: joining the other ~1515
  Excel-verified Moscow groups that no worker session currently
  belongs to. That's a materially bigger, separate operational decision
  (mass-joining new Telegram groups) than a data/config change, and stays
  a real, available scaling path for a future explicit go-ahead.
- **Unrelated, fixed in passing**: `lead-matching-service` (UAE) had
  crashed on an unhandled `pg.Pool` "Connection terminated unexpectedly"
  error during this session — restarted, `/health` confirmed green. Its
  `Pool` still has no `on('error', ...)` handler, a real robustness gap;
  flagged for a separate small fix, not addressed here.

This is additive only: no existing alias, source route, or matching
behavior was changed for anything outside the 64 new aliases and 6
sources listed above.

## ADR-038 — Moscow gets a real matching pipeline: UAE's shipped logic ported and adapted, not the stale AGENTS.md spec

Decision date: 2026-09-29. An audit found `rf-lead-matching-service` had real
stock (10,411+ Joker objects) and a real, live intake gate (ADR-036), but
`SEND_TO_AI` still dead-ended in a placeholder `NOT_IMPLEMENTED` — no AI
parser, no candidate query, no hard filters, no scoring, no
`match_results` table, no domain columns on `match_runs`, an empty
`location_aliases` table, no Telegram delivery, and no source-routing gate
(a `route_mode=RF` source was never actually forwarded to this service by
any live transport path). The user asked for UAE's real logic to be ported
and adapted to Moscow's own criteria, not left permanently blocked pending
a perfect decision.

**Decision — build off the real shipped UAE code, not `AGENTS.md`'s
documented-but-superseded spec** (ADR-037 already established this
distinction for UAE itself): UAE's actual weights are `{location: 50,
budget: 30, bedrooms: 15, propertyType: 5}`, status is binary
`MATCH`/`NO_MATCH` (any survivor ⇒ `MATCH`, no `STRONG_MATCH` tier), and
only criteria the buyer actually stated participate in the weighted
average. Moscow mirrors this shape with its own fields and one addition:

- **Fields**: `property_type, district, complex, rooms, bedrooms,
  area_sqm, floor, floors_total, price, readiness_year` (off by default:
  `deal_type` structural, `layout`/`euro_layout`/`amenities` unbuilt).
- **Location**: two tiers, `complex` (ЖК, score 100) > `district` (score
  85) — no third "citywide" tier; unlike UAE's area, Moscow's whole stock
  is already strict-scoped to the city (ADR-035), so "no district/complex
  stated" is genuine under-specification, not a valid resolution level.
- **Scoring**: `{location: 50, price: 30, rooms: 15, propertyType: 5}`,
  same 100-point total and "active-only" weighting as UAE.
- **Real addition beyond UAE**: every hard filter/scoring component is
  ALSO gated by its own `joker_*_enabled` runtime setting (migration
  0031) — an operator-disabled criterion is `active:false`, identical
  semantics to "buyer never stated it." UAE's own 5 weights remain
  hardcoded literals never read from settings (unchanged, out of scope);
  Moscow's `/settings?market=moscow` toggles are now genuinely
  load-bearing.
- **Deliberate divergence, found live, not planned upfront**: `bedrooms`
  has ~4% real coverage in Moscow's Joker stock (507/13,116) vs `rooms` at
  ~40%. Copying UAE's "unknown stock value blocks" policy for bedrooms
  would make matching non-functional. `bedrooms` uses "skip if stock value
  unknown" (`active:false`, never pushed into SQL); `rooms` — including
  explicit `STUDIO`/`FREE_PLAN` sentinels, never conflated with `rooms=0`
  — keeps the standard "unknown blocks" policy as the reliable primary
  criterion.
- **Isolation preserved**: `rf-lead-matching-service/src/services/
  pipeline.js` itself never `require()`s anything from
  `lead-matching-service` (an automated test inspects its own require()
  calls). Reused UAE code — the intake gate, config-repository, Telegram
  sender, render helpers, provider adapters — is reached through local
  thin-wrapper files instead. Code that was never UAE-specific to begin
  with (`src/core/aliases.js`, `content-dedup.js`, `ai-usage.js`,
  `scoring.js`'s `sameKey`) is imported directly from the shared root.
- **Source routing**: a new `gates/source-routing.js` mirrors UAE's own
  `ingest.sources`/`ingest.source_routes` lookup, but is eligible only for
  `route_mode IN ('RF', 'BOTH')` — never `AUTO`, which still defaults to
  the UAE contour until a real market classifier exists. Wired as the
  FIRST check in `pipeline.js`, before the intake gate and before content
  dedup, so a misrouted source is rejected regardless of gate-cutover
  state.
- **Telegram**: a separate bot (own token), one shared/general chat for
  now, no per-broker routing — mirrors UAE's own actual live delivery
  mechanism (env-var bot token + chat ID), not the dormant
  `broker_notification_routes`/`telegram_bots` tables (migration 0009),
  which remain completely unwired for both markets.
- **Persistence**: migration `0032` widens `matching_moscow.match_runs`'s
  `result_status` CHECK to add `MATCH, NO_MATCH, DUPLICATE, PARSER_ERROR,
  INSUFFICIENT_CRITERIA` and adds UAE's same domain columns
  (`parsed_request`, `no_match_reason`, `content_hash`, etc.); a new
  `matching_moscow.match_results` table (`UNIQUE(source_message_id,
  stock_joker_object_id)`, one JSONB `score_breakdown` column rather than
  a fixed per-criterion column set, since Moscow has up to 9 toggleable
  criteria vs UAE's fixed 4) upserts on rerun instead of duplicating.
- **Aliases**: `matching_moscow.location_aliases`, populated from real
  stock, not guesswork — a live audit found `district` is mostly
  RAION-level (e.g. "Хамовники", "Пресненский"), so the originally-planned
  12 okrug abbreviations were revisited: 7 okrugs (ЦАО, ЗАО, ЮАО, СЗАО,
  ЮЗАО, СВАО, ЮВАО) turned out to have a real, populated okrug-level
  `district` value of their own (Joker sometimes tags a row with the whole
  okrug spelled out instead of a specific raion, e.g. `"Центральный"` /
  `"Северо-западный"`), so those 7 got a clean 1:1 alias; the other 5
  (САО, ВАО, ЗелАО, НАО, ТАО) have no such value — only individual raion
  names — so no alias was added for them (it would incorrectly narrow the
  whole okrug down to one arbitrary raion). `scripts/seed-moscow-location-
  aliases.js` also self-mines real `complex` values that keep an inline
  Russian transliteration in parentheses (`joker-normalize.js`'s own
  convention, e.g. canonical `"Wine House (Вайн Хаус)"`) and seeds both
  halves as aliases. 54 aliases seeded to production in total.
- **Real audit finding, re-verified against `available = true` and NOT a
  live matching risk**: an unfiltered (`available` ignored) query of
  `matching_moscow.stock_inventory.district` shows Санкт-Петербург
  (Петроградский, Василеостровский, Выборгский, Адмиралтейский) and Сочи
  (Хостинский, Адлерский, and 221 of the 1431 `"Центральный"` rows) raion
  names alongside genuine Moscow ones — a `joker-market-router.js`/
  sync-side scoping gap, despite ADR-035. Re-checked scoped to
  `available = true` (the only rows `candidate-query.js` ever reads,
  `WHERE available = true` is unconditional): **zero** non-Moscow rows for
  `district = 'Центральный'` (all 1160 are `city = 'Москва'`), and only 44
  of 10,411 active rows across the whole table have `city <> 'Москва'` —
  every one of those 44 is legitimate Новая Москва (Троицкий/Новомосковский
  округа, Зеленоград, Щербинка, Румянцево, Кокошкино — officially part of
  the city, just tagged with the specific settlement name instead of
  "Москва"). The scoping gap is real in historical/deactivated sync rows
  and should still be tracked/fixed in `joker-market-router.js` separately,
  but it does not currently leak into anything a real buyer request can be
  matched against — the district-level okrug aliases added below (ЦАО,
  ЗАО, ЮАО, СЗАО, ЮЗАО, СВАО, ЮВАО) are safe as a result.

This is additive: `v2_intake_cutover_enabled = false` (the seeded
default) still means byte-identical prior behavior end-to-end. Turning it
on and reaching `SEND_TO_AI` is what activates the real chain described
above; without an `ingest.source_routes` row routed `RF`/`BOTH` and
without the shared workers' webhook URLs pointed at this service, nothing
reaches it in production regardless.

## ADR-037 — Active UAE documentation follows FILTER FIRST / RANK SECOND; legacy threshold scoring is historical

Decision date: 2026-09-29. The primary project documents still described
the original `pilot-v1` score contract (weights 30/25/15/20/10, thresholds
70/85, `STRONG_MATCH`, and furnishing as a soft score) after the active UAE
runtime had moved to `lead-matching-service` with different semantics.

**Decision:** documentation for the active UAE service must follow the
verified implementation:

- every stated criterion is evaluated as an active hard filter before
  ranking; furnishing is an exact hard filter and missing stock furnishing
  is unverifiable/blocking when the request explicitly requires it;
- ranking applies only to survivors, with weights Location 50, Budget 30,
  Bedrooms 15, Property Type 5;
- only active request criteria participate in the weighted denominator;
- ranking score orders survivors and never decides eligibility;
- any survivor is `MATCH`; no survivor is `NO_MATCH`; insufficient request
  specificity is `INSUFFICIENT_CRITERIA`;
- the active service does not generate `STRONG_MATCH`.

The old root `src/core/*` matcher, generated n8n `pilot-v1` workflow, old
database rows, incident ADRs, and dated audits remain historical evidence.
They may retain `STRONG_MATCH` and the old thresholds when clearly labeled
legacy; they must not be used as the current UAE implementation contract.
This ADR changes documentation only and does not alter matching logic.

## ADR-036 — Moscow's V2 intake gate is now REAL (BLACKLIST/WHITELIST/PROPERTY_SIGNAL evaluated against real seeded rules), reusing UAE's pure gate function, never its pipeline

Decision date: 2026-09-29. The user noticed the UAE Settings page's "Шлюз
приёма V2 — рабочий режим" section, asked what it does, and then asked
whether the same thing was needed/possible for Moscow. Investigation found
that although migrations 0029-0031 had already made
`matching_moscow.runtime_settings`/`intake_rules` fully editable (same UI,
same sections as UAE), `rf-lead-matching-service/src/services/pipeline.js`
never actually READ any of it -- every request unconditionally resolved to
`NOT_IMPLEMENTED`, regardless of what the operator toggled on
`/settings?market=moscow`. The settings were real and saved, but
functionally inert.

**Decision**: wire the intake gate for real, reusing
`lead-matching-service/src/gates/v2-intake-gate.js`'s
`evaluateV2IntakeGate()` as-is -- it is a 100% pure, side-effect-free,
market-agnostic function (no DB, no UAE-specific data, operates only on
whatever `runtimeSettings`/`intakeRules` plain data it is handed). Reused
via a new thin wrapper, `rf-lead-matching-service/src/gates/v2-intake-gate.js`
(`module.exports = require('.../lead-matching-service/src/gates/v2-intake-gate')`),
mirroring the exact pattern `rf-lead-matching-service/src/repositories/
config-repository.js` already established for schema-parameterized reuse.
Critically, `pipeline.js` itself requires ONLY the local wrapper path, never
`lead-matching-service` directly -- `tests/unit/pipeline.test.js`'s existing
"the RF pipeline never imports anything from the UAE contour" check
inspects `pipeline.js`'s own `require()` calls specifically, and this
preserves that guarantee literally, not just in spirit.

**Behavior, gated on `v2_intake_cutover_enabled` (seeded `false`, migration
0029 -- unchanged default, zero live behavior change until an operator
opts in)**:
- OFF (default): every request still resolves to `NOT_IMPLEMENTED` with
  the original `RF_MATCHER_DISABLED` reason -- byte-identical to
  pre-ADR-036 behavior. Existing tests pass unmodified in spirit (fixture
  updated only to inject a fake `configRepo` returning this same default).
- ON, gate REJECTs (BLACKLIST hit or insufficient buyer signal): persisted
  as `result_status = 'REJECTED'` -- a value migration 0018's own CHECK
  constraint allowed from day one but nothing had ever written until now.
- ON, gate approves (SEND_TO_AI rule or WHITELIST+PROPERTY_SIGNAL
  threshold met): still persisted as `NOT_IMPLEMENTED`, because there is
  still no RF AI parser/matcher to hand the approved request to (plan
  section 5.3) -- but the `reason` field now honestly says "gate approved
  as buyer signal (...)", distinct from "nothing was ever evaluated."
  **Never fabricates a MATCH/NO_MATCH outcome** -- the DB CHECK constraint
  on `result_status` is untouched and still only allows
  `NOT_IMPLEMENTED`/`REJECTED`/`ERROR`.

**Rejected**: duplicating `evaluateV2IntakeGate()`'s ~150 lines into
`rf-lead-matching-service` as a second copy -- rejected for the same
reason `config-repository.js` wasn't duplicated: the function has zero
UAE-specific content to diverge from, and a second copy would only be a
future source of behavioral drift between the two contours' gates for no
benefit.

**Not done, out of scope for this change**: event/content dedup for RF
(AGENTS.md's "shared technical event idempotency" is a separate, larger
piece of shared transport-layer plumbing, not part of "the same intake
gate as UAE"); actually turning `v2_intake_cutover_enabled` on in
production (the setting exists and is fully wired, but flipping it live
is a separate, explicit operator decision -- not made as part of this
change); starting `rf-lead-matching-service` as a running process (it is
not currently running locally or wired into any live source route).

## ADR-035 — Real bug: the "RF" Joker bucket's catch-all silently absorbed non-Russian objects; rescoped strictly to `region === 'Москва'`, schema renamed again to `matching_moscow`

Decision date: 2026-09-28, same day as ADR-034. After the `matching_russia`
rename shipped and the Joker sync resumed, the user spot-checked
`/stock?market=rf` and asked two real questions: why the URL still said
"rf" instead of the new schema name, and why the city column showed cities
that plainly weren't Moscow. A direct query against production confirmed
the second one was a real bug, not a UI issue: `resolveMarket()`
(`src/joker/joker-market-router.js`) routed *every* object whose `region`
wasn't explicitly Турция/ОАЭ/Оман/Саудовская Аравия into the "rf" bucket —
including `Санкт-Петербург`, `Краснодарский край` (Сочи), `Татарстан`
(Казань), `Самарская область`, all of `Московская область` (Moscow
OBLAST, not the city), and, with no relation to Russia at all,
`Узбекистан` (Ташкент, 25 rows) and `Грузия` (Батуми, 10 rows) — because
they all happened to share the same Joker tenant as real Moscow listings.
This was a known, documented design choice at the time (ADR-033 / the
"Moscow-agency-run CRM, not a generic all-Russia feed" framing in
`docs/PER_MARKET_SERVICE_INDEPENDENCE_PLAN.md` §5.1), not an oversight —
but the user decided, once they saw Tashkent and Batumi rows under a
"Moscow" label, that the scope should be tightened.

**Decision**: `resolveMarket()` now requires `region === 'Москва'`
exactly — the city, not the oblast, not the wider tenant. Everything else
is skipped, with a `classifySkipReason()` breakdown
(`uae_deliberate_skip` / `out_of_moscow_scope` / `no_region`) recorded on
every sync run for diagnostics, replacing the old undifferentiated
`skippedUae` counter that no longer described what was actually being
skipped. Rows previously synced under the old broad scope are not
deleted — `markMissingUnavailable()` simply stops seeing them on the next
sync and marks them unavailable, the same safe-deactivation path used
everywhere else in this pilot (AGENTS.md §9's "never delete" convention
extends naturally to a rescope, not just a disappearance from the source).

Given the rename was already mid-flight the same day, the schema itself
was renamed a second time — `matching_rf` → `matching_russia` (ADR-034) →
`matching_moscow` (this ADR) — rather than leaving a schema named "russia"
holding data now strictly scoped to one city. The market *key* used
throughout the dashboard/router code (`rf` → `moscow`) was renamed
alongside it, via `sql/migrations/0028_rename_russia_to_moscow.sql`
(guarded/idempotent, same pattern as `0027`) and the same
targeted-replace-by-verified-table-list process as ADR-034, applied to
`dashboard/`, `src/`, `rf-lead-matching-service/`, `tests/`, and docs.

**Rejected**: keeping the broad multi-city scope and just fixing the
Tashkent/Batumi outliers as one-off exclusions — rejected because the
underlying design (route by "not explicitly one of 4 other markets"
rather than by an actual positive Moscow check) would keep admitting
whatever else turns up in this Joker tenant in the future; a strict
positive match on `region === 'Москва'` is the only version of this that
can't silently regress the same way again.

**Deferred, not decided**: where Санкт-Петербург/Сочи/Казань/Самара
stock should live going forward (their own schemas, later, if there's a
reason to match against them, or simply left unsynced) — out of scope for
this fix, which only had to stop them from being mislabeled as Moscow.

## ADR-034 — Real incident: ad-hoc production schema rename with no code changes; fixed with a code-first migration (`matching`→`matching_uae`, `matching_rf`→`matching_russia`)

Decision date: 2026-09-28. Immediately after ADR-033 shipped, the user ran
`ALTER SCHEMA matching RENAME TO matching_uae` and
`ALTER SCHEMA matching_rf RENAME TO matching_russia` directly against
production, with zero application code updated first. Every query in
`lead-matching-service`, the dashboard, and the pilot's own repositories
hardcoded the old schema names literally, so the live UAE matcher broke
within seconds (confirmed: `relation "matching.intake_rules" does not
exist`). Reverted immediately via direct SSH (same tunnel credentials as
`docs/OPERATIONS_ACCESS.md`), restoring `matching`/`matching_rf` and
confirming `matching.intake_rules` readable again (41 rows) before
anything else proceeded.

**Decision**: the new names (`matching_uae`, `matching_russia`) are the
right call — they match the market-prefixed convention already used for
the Joker-fed schemas (`matching_oman`/`matching_saudi`/`matching_turkey`,
ADR-033), and remove the asymmetry of UAE having no market prefix while
RF's own name (`matching_rf`) didn't match its operator-facing "Москва"
label used everywhere else. But the rename had to be redone properly:
application code updated and fully tested against the new names FIRST,
with the actual `ALTER SCHEMA` applied to production only as the final,
explicitly-announced step, coordinated with an immediate restart of the
live `lead-matching-service`/dashboard processes — never a live rename
against running, unaware code.

**Implemented**: migration `0027` (guarded, idempotent — checks
`pg_namespace` before renaming, so it's a no-op if already renamed);
`src/db/migrate.js` fixed to resolve its own bookkeeping schema
dynamically (prefers `matching_uae` if present, else falls back to
`matching`) instead of hardcoding `matching.schema_migrations`, so a
future rename can never silently orphan migration history; every
schema-qualified reference to the 26 `matching.*` tables/views and 5
`matching_rf.*` tables across `dashboard/`, `src/`, `lead-matching-service/`,
`rf-lead-matching-service/`, `scripts/`, and all test suites replaced with
the exact DB-verified name list (word-boundary anchored, never a blind
`matching.` replace — `tests/contracts/workflow-contracts.test.js` has an
unrelated local variable also named `matching` holding parsed n8n JSON,
correctly left untouched); the two bare schema-name string literals not
caught by the dot-suffixed replace (`src/joker/joker-market-router.js`'s
`MARKET_SCHEMAS.rf` and `dashboard/queries.js`'s `MARKETS.rf.schema`,
both previously `'matching_rf'` with no trailing `.tablename`) updated by
hand to `'matching_russia'`, along with the tests that assert against
them. `nika-matching-pilot-starter/` (a separate starter tree) and
historical migration files `0001`-`0026` are explicitly untouched — they
are an append-only record of what already ran under the old names.

**Rejected**: leaving the schema names as `matching`/`matching_rf`
forever to avoid ever touching this again — rejected because the
inconsistency with the Joker-fed schemas was itself a standing footgun
(easy to typo/assume `matching_uae` already existed, as this exact
incident proved), and the user explicitly asked for the proper version of
the rename they'd already attempted once.

## ADR-033 — Joker-fed stock for Москва/Оман/Саудовская Аравия/Турция: own schema per market, stock visibility only, UAE untouched

Decision date: 2026-09-28. The user finalized the RF stock contract this
session (11 Joker fields, listed in `docs/PER_MARKET_SERVICE_INDEPENDENCE_PLAN.md`
§5.1.1) and asked for `/stock` to be filterable across 5 markets, with
every market's data in its own DB table. Implemented as: migration `0025`
adds `matching_rf.stock_inventory`/`location_aliases`/`stock_sync_runs`
(the schema itself already existed as a `NOT_IMPLEMENTED` skeleton since
migration `0018`; only the stock tables were missing, deliberately, until
a contract was approved); migration `0026` creates 3 brand-new schemas
(`matching_oman`, `matching_saudi`, `matching_turkey`) with the identical
table shape via one `DO $$ ... FOREACH ... $$` block rather than 3
near-duplicate migration files. `src/joker/` holds the pure normalization
functions (ЖК/district/rooms/area/readiness — every rule grounded in a
real value observed live, including two genuine Joker data quirks: a
broken `"28 М{2}"` area-unit literal on garage listings, and `ready-quarter`
being a bare `"1"`-`"4"` digit that must never be stored under the same
column as a 4-digit year), the market router (buckets a raw object by
`region`; UAE is an explicit skip, not an unresolved case), and the sync
orchestrator (`joker-stock-sync.js`, upsert + safe-deactivate, never
delete, one `stock_sync_runs` row per market per run).

**Rejected**: syncing Joker's own `region: "ОАЭ"` objects into a new
UAE table now — that exact ~90-object batch was already flagged in
`docs/JOKER_API_DISCOVERY.md` as data-quality-suspect (duplicate prices,
zero-price/empty-title rows) and the user's own scope boundary kept UAE on
its existing `matching.stock_inventory` source. `resolveMarket()` returns
`null` for that region as an explicit, tested skip, not a silent drop.

**Rejected**: building live Draft→Apply settings toggles for the finalized
criteria now. `dashboard/joker-criteria-reference.js` + a new read-only
section on Settings → Matching present the agreed criteria/normalization
list instead — building real toggles would be dead UI with no
`matching_rf.runtime_settings` table or RF matcher yet to consume them
(scoring weights are still undecided — §5.2 of the plan doc).

**Confirmed empty on purpose**: a full live catalog scan found zero Joker
objects tagged region `Оман` or `Саудовская Аравия` — those two schemas'
tables are correctly empty after a sync, not a bug.

## ADR-032 — Rule-card live statistics: one bounded query per page load, AUTHORITATIVE and SHADOW never silently mixed

Decision date: 2026-09-27. Adding real hit/→AI/→reject counts to every
`/settings` rule card (40+ rules) needed telemetry from
`matching.shadow_gate_evaluations`, already read by `/shadow-gate`.
Rejected querying per rule (40+ round trips on every page load) in favor of
two bounded aggregate queries for the WHOLE page: one unnests all four hit
JSONB arrays once and groups by the rule id embedded in each hit object
(`dashboard/shadow-queries.js`'s `getRulePerformanceStats`); the other
computes a per-group summary from the same scoped rows, keeping the
row-level message counts and the `DISTINCT` rule-id count in **separate**
CTEs joined at the end — combining them in one `FROM` with an unnest would
silently multiply the message counts by hits-per-message (caught in review
before it shipped). Also decided: AUTHORITATIVE-mode data always wins over
SHADOW-mode data for the same rule when both exist, but the two are never
summed/averaged — the UI always labels which one it's showing — and
`FALLBACK`-mode rows are excluded outright since they reflect a gate
infrastructure failure, not real rule behavior. See
`docs/SETTINGS_UI_SIMPLIFICATION.md` section 5 for the full design and its
documented, intentional numeric differences from `/shadow-gate`'s own
(SHADOW-only, top-20-capped) rule table.

## ADR-031 — Settings UI terminology simplification is a presentation-only mapping layer, never merged into gate logic

Decision date: 2026-09-27. The `/settings` page's rule-management UI showed
raw regex, internal source-file description comments, and backend enum
names (`BLACKLIST`/`WHITELIST`/`PROPERTY_SIGNAL`/`SEND_TO_AI`,
`REQUIRE_ANY`/`REQUIRE_BOTH`) as its primary operator-facing text —
unreadable for a non-technical operator. Rejected folding friendly labels
into `config-repository.js`/`config-validation.js` or the seeded rule data
itself, since that would make presentation wording a de facto part of the
persisted/validated schema. Instead added one new, dependency-free file,
`dashboard/rule-ui-metadata.js`, keyed by the exact seeded `pattern` string
(verified against all 41 real rows in production `matching.intake_rules` as
of this date) — never imported by anything under
`lead-matching-service/src/gates/**`, `src/matching/**`, or
`src/services/**`. `dashboard/settings-view.js` and `dashboard/shadow-view.js`
consume it to render friendly rule cards (raw fields tucked behind an
"Advanced" `<details>` disclosure, closed by default), a dynamic
active-mode banner computed from the live settings map, read-only
duplicate-pattern detection, and live-safety warnings when Live Cutover is
on. No backend enum value, threshold, rule pattern, or the Draft → Apply
mechanism changed — see `docs/SETTINGS_UI_SIMPLIFICATION.md` for the full
before/after mapping.

## ADR-030 — Matching correctness fixes: RENT price semantics, multi-area OR resolution, and read-only diagnostics — never by relaxing hard filters or inflating MATCH counts

Decision date: 2026-09-23. Follows a live forensic audit that traced why
`lead-matching-service-v1` showed `MATCH=0` despite growing traffic, and a
stock/alias completeness audit that classified every observed NO_MATCH
cause.

**RENT was never matchable at all — the highest-priority fix.** Stock
stores rentals as `transaction_type='RENT_YEARLY'` with price in
`annual_rent`; the request schema only ever produces `'SALE'|'RENT'` and
the hard filters/candidate query unconditionally compared against
`selling_price`. A bare `stock.transaction_type === request.transaction_type`
equality meant every real RENT request was rejected on the transaction
check alone, before its budget was even compared against the (always-NULL
for a rental) `selling_price`. Fixed with ONE shared module
(`lead-matching-service/src/matching/transaction-semantics.js`) that both
the SQL candidate-query layer and the JS hard-filters defense-in-depth
layer call — they can never diverge on what's compatible or which price
column applies. Only `SALE`/`RENT_YEARLY` are supported because a live
`SELECT DISTINCT transaction_type FROM matching.stock_inventory` confirmed
those are the only two values that exist; no vocabulary was guessed.

**A "known canonical registry" layer closes the project-alias gap without
inventing synonyms.** `matching_aliases` has zero `type='project'` rows
despite real stock having `project_community` values — before this fix,
every one of those genuine names resolved as "unrecognized" for lack of an
alias row nobody had created. `lead-matching-service/src/matching/
location-dictionary.js` wraps the EXISTING alias engine
(`src/core/aliases.js`, reused verbatim) with a second, read-only layer
derived from stock's own distinct `area`/`project_community`/`building`
values — a raw term matching a real stock value resolves via
`resolution_source: 'canonical'`, never written back as a fake alias row.

**Multiple acceptable areas are OR conditions, never a reason to discard a
lead.** `StructuredRequest.area` (singular) stays for backward
compatibility; `.areas` (array) is the new canonical shape, each option
resolved independently, unresolved options never silently dropped
(`unresolved_location_options` in diagnostics). SQL uses a parameterized
`area = ANY(ARRAY[...])` across resolved areas only; every other criterion
stays AND'd. A specific project/building still never broadens to its
parent area when unresolved — this work doesn't touch or weaken that
existing regression guard (ADR-020-era "The Edge" incident).

**`matching.match_runs.match_diagnostics JSONB`** (additive, nullable
migration `0019_match_diagnostics.sql`) records, per genuine buyer-path
request only, a hard-filter funnel computed via ONE aggregate SQL query
(conditional `COUNT(*) FILTER (WHERE ...)`, never N separate queries —
required given real traffic volume), explicitly separating "stock has no
value on record" from "stock has a value that doesn't satisfy the request"
for every ambiguous field (bedrooms/bathrooms/size/plot size/furnishing/
price) — real data showed 93/94 ACTIVE rows missing `furnishing`, a
significant, previously invisible false-NO_MATCH source. The hard filter
itself is NOT relaxed to compensate (final principle 9 in the underlying
spec) — `NULL` still can't be confirmed a match; this is reporting only.
Legacy `pilot-v1` never writes this column and is completely unaffected.

**Two new Telegram notification paths, both feature-flagged OFF by
default** (`TELEGRAM_NOTIFY_QUALIFIED_NO_MATCH`, `TELEGRAM_NOTIFY_NEEDS_CRITERIA`)
make a genuine, confidently-classified buyer visible even when thin stock
means the automatic outcome is `NO_MATCH`/`INSUFFICIENT_CRITERIA` — without
ever faking `result_status` or a match. Deploying this code starts no new
message stream until an operator opts in.

**`scripts/diagnose-request.js`** is a strictly read-only CLI (no OpenAI
calls, no `match_run`/`match_result` writes, no Telegram sends, no
alias/stock writes) that reuses the exact same `matchRequest()`/
`buildMatchDiagnostics()` the live service uses to diagnose any historical
request, including ones that predate the `match_diagnostics` column.

**Explicitly out of scope for this change** (each is its own future
decision, not silently dropped — see `lead-matching-service/README.md`'s
"Known deviations" section): a real city taxonomy, backfilling missing
`furnishing` source data, `matching.match_results`' cross-matcher
(`matcher_version`) ownership, and persisted notification-delivery status.
Also not touched: the RF matching contour (ADR-028), and Dashboard Summary
(a separate, already-completed piece of work — `dashboard/SUMMARY_METRICS.md`).

## ADR-029 — Source catalog lives in the existing dashboard; UAE schema physically stays `matching.*` for now; RF ships as a NOT_IMPLEMENTED skeleton

Decision date: 2026-09-22. Implements ADR-028's contract.

**Control plane, not a new service.** `ingest.sources`/`ingest.source_routes`
(migration 0017) are read/written by the EXISTING dashboard
(`dashboard/source-queries.js`, a new `/sources` page) rather than a
standalone HTTP microservice with the exact suggested route names. The
underlying logic (`src/sources/source-repository.js`,
`route-resolver.js`, `source-sync.js`) is a plain, reusable Node module,
not tied to the dashboard process — a future ingress/router service can
`require()` it directly instead of making an HTTP hop. This avoids a
second admin app the audit itself warned against, and was live-verified
against the real running telegram-worker/whatsapp-worker (89 Telegram +
24 WhatsApp real groups synced into an isolated test database).

**`matching.*` is NOT physically renamed to `matching_uae.*` yet.** The
audit explicitly allowed deferring this ("not obligatory in one commit if
it creates high migration risk") when a compatibility layer is
documented instead of a destructive rename. `matching.*` already holds
months of real production match history and is read by the live n8n
pipeline, the dashboard's existing pages, and Metabase-style external
queries — a rename is a real-schema-name break for all three with no
functional benefit today (the isolation guarantee that matters --- "a
UAE matcher never queries RF stock" --- already holds structurally, since
`lead-matching-service` only ever connects to `matching.*` and RF's own
`matching_rf.*` schema exists in a completely separate namespace with no
shared table). Follow-up: introduce `matching_uae` as a schema alias/
search_path addition, or do the rename in its own dedicated,
zero-downtime-tested migration once a maintenance window is agreed —
tracked as a known limitation, not silently dropped.

**RF ships as an honest skeleton, not a stub matcher.** `rf-lead-matching-service/`
is a real, separately deployable process (own Dockerfile, own config, own
`matching_rf.*` schema and interpretation-cache table, own tests) that
persists a durable `NOT_IMPLEMENTED` outcome for every event it receives,
rather than a fake matcher built on invented RUB/sqm/ЖК business rules
nobody has approved. See `rf-lead-matching-service/README.md` for the
exact approval sequence required before real RF matching can be built.

**Telegram auto-join's `route_mode` is echoed, not persisted, by the
worker.** Workers stay transport-only (ADR-028) — `POST /telegram/join`
and `tools/telegram_join_chats.py --route` validate and pass the value
through, but registering it into `ingest.source_routes` is left to the
dashboard's Sources page (which already supports assigning a route after
the next sync picks up the newly-joined chat). A fully automatic
join-then-register round trip is a reasonable follow-up, not implemented
here to avoid giving the CLI or the worker direct DB access.

## ADR-028 — UAE and RF are separate matching contours; source routing is shared and DB/UI-controlled

Decision date: 2026-09-22.

The project MUST NOT evolve into one universal real-estate matcher for UAE and Russia.

UAE and RF are separate domain contours with independent stock, request schemas, parsers, aliases, location models, units, hard filters, ranking/scoring, interpretation caches, match persistence, fixtures, and regression tests.

Shared components are infrastructure-only: Telegram/WhatsApp workers, raw transport envelope, technical event idempotency, source discovery/catalog, source routing, authentication, and observability.

Logical database ownership target:

```text
ingest.*          shared source/control-plane data
matching_uae.*    UAE-only domain matching data
matching_rf.*     RF-only domain matching data
```

The current `lead-matching-service` is treated as the UAE contour unless explicitly renamed. RF matching should be implemented independently (for example `rf-lead-matching-service/`). RF-specific semantics such as RUB, sqm, rooms/euro-layouts/ЖК/metro must not be forced into UAE fields such as AED/sqft/BR merely to share code.

Telegram and WhatsApp groups/channels available through active sessions must be synchronized into a persistent PostgreSQL source catalog. The existing dashboard/control UI should expose a Sources/Channels management area where an operator can enable/disable monitoring and select routing:

```text
UAE | RF | BOTH | AUTO | NONE
```

Manual routing takes precedence over AUTO. Every source must not be routed to both contours by default. Existing environment allowlists remain only a migration/bootstrap fallback and are not the long-term control plane.

Runtime target:

```text
Raw event
→ shared physical-event idempotency
→ source catalog lookup
→ monitoring_enabled
→ source route
   ├─ UAE  → UAE matcher only
   ├─ RF   → RF matcher only
   ├─ BOTH → both matchers independently
   ├─ AUTO → deterministic router/fallback
   └─ NONE → stop
```

Content interpretation caches remain contour-specific. A UAE interpretation must never be reused by RF and vice versa.

Detailed mandatory contract: `docs/MARKET_CONTOURS_AND_SOURCE_ROUTING.md`.

## ADR-027 — A budget alone is not "criteria" — reverting the ADR-020 budget addition

Real production incident: a WhatsApp request with no area, no bedrooms, no
property type, and a budget of "up to 100,000,000 AED" (effectively
unbounded) matched **74** listings — apartments, villas, an office studio —
spanning every area in the stock, every single one at 100/100
STRONG_MATCH. User's framing: "если запрос не содержит критериев для
метчинга — это NO match, потому что мы не можем сопоставить критерии
точно."

Root cause: `request-schema.js`'s `hasAnyCriteria` gate (the "is this
request specific enough to safely match against the whole stock" check
from ADR-020) had `budget_min`/`budget_max` added to its criteria list —
done at the time to fix what looked like a latent gap ("a request stating
only a budget is real signal too"). This incident proves that reasoning
wrong: a budget ceiling narrows nothing about *which* stock item is
relevant — it doesn't identify a location or a property category, it just
filters price. With every other field null, "unknown doesn't penalize"
gives full credit on all remaining criteria (including the property-type
hard gate itself, since an unstated request property type never blocks —
ADR-025), so literally any stock priced under the ceiling scores 100/100.
This is the exact same failure shape ADR-020 already fixed for
property_type alone, just for budget instead.

Fix: removed `budget_min`/`budget_max` from `hasAnyCriteria`, back to only
`area || building || bedrooms !== null` — attributes that can be compared
*exactly* against one specific stock item (a location, a building, a
bedroom count) rather than a loose numeric filter. Budget stays real
signal for *scoring* a candidate (`budgetScore`) and for the hard price
gate (ADR-018/025) once a request has cleared this bar some other way —
it is only excluded from deciding whether the request is specific enough
to match at all, same treatment as `property_type`.

## ADR-026 — Contract test parses every generated Code-node source as real JS

Self-inflicted incident during the ADR-025 fix: `matcher.js`'s
`require('./scoring')` destructure was reformatted across multiple lines
for readability. `bundle-code-node.js`'s `stripModuleLines` only recognizes
a `const { a, b } = require(...)` destructure written on ONE line (a
single-line regex, run per source line) — split across lines, none of them
matched, so the raw `const { computeScore, ... } = require('./scoring');`
text landed unstripped inside the "Deterministic Match" bundle, right
after `scoring.js`'s own `function computeScore(...)` declaration in the
same scope. Result: `SyntaxError: Identifier 'computeScore' has already
been declared` inside n8n's task-runner sandbox — invisible in
`build-workflows.js` (which only concatenates text, never parses it) and
invisible in every existing test (all of which import `src/core/*.js`
directly via Node's own `require`, never the bundled/stripped text n8n
actually runs). Deployed and active for ~4 minutes before a live webhook
test surfaced it; one real WhatsApp request landed in that window,
recovered by replaying its exact captured payload through the fixed
pipeline (it correctly resolved to `transaction_type_mismatch` — a RENT
request against the pilot's SALE-only stock — so no notification was ever
missed, only its `match_runs` row).

Fix: reverted the multi-line destructure back to the single-line style
already used everywhere else in `src/core/*.js` (the bundler's actual
contract, previously undocumented). Added a contract test — `every
generated Code-node source is syntactically valid, standalone JS` — that
runs `new vm.Script(...)` (wrapped in a function, matching how n8n's task
runner actually executes a Code node's body, since these all use a
top-level `return`) over every Code node in both generated workflows. This
parses the exact bundled/stripped text before it ever reaches a real
webhook, closing the blind spot every other test had.

## ADR-025 — Property type is a hard gate; budget range gates both bounds independently

Real production incidents (Telegram and WhatsApp, three separate occurrences):
Townhouse and Villa requests fanned out to dozens of unrelated Apartment
listings, every single one at exactly 85/100 STRONG_MATCH — "движок не
понимает тип недвижимости — сток townhouse и villa сравнивает с
квартирами."

Root cause #1: `propertyTypeScore` (scoring.js) is only 15 of 100 weighted
points. With no stated area/bedrooms (both then score full credit under
"unknown doesn't penalize") and property type scoring exactly 0/15 on a
genuine mismatch, the total lands at
location(30)+bedrooms(25)+budget(20)+furnishing(10) = 85 — clearing
STRONG_MATCH on a listing that is a fundamentally different physical
product (an apartment is not a townhouse or villa). Same problem class as
budget (ADR-018) and bedrooms (ADR-019): a criterion scored as only part of
100 can never, by itself, force a real mismatch below threshold.

Root cause #2, found investigating the same incidents: one of them stated
a budget **range** (e.g. 3,000,000–7,000,000 AED), and the actual stock
shown was priced at 890,000 AED — well under the minimum. `isBudgetWithinTolerance`'s
old `if (budgetMax) {...} else if (budgetMin) {...}` only ever checked ONE
bound when both were stated (whichever branch matched first), so the
minimum was silently never enforced whenever a maximum was also present.

Fixes, both in `src/core/scoring.js`:
- New hard gate `isPropertyTypeAcceptable(request, stock)` — no stated
  request type never blocks (unknown doesn't penalize); no stock type on
  record blocks (unverifiable, same asymmetry as bedrooms/budget); a real
  mismatch blocks. Alias resolution (`aliases.js`) still collapses true
  spelling synonyms ("Flat" → "Apartment") to the same canonical value
  before this runs, so it only ever blocks a genuine category difference.
- `isBudgetWithinTolerance` now checks `budgetMax` and `budgetMin`
  independently rather than as an if/else-if chain, so a stated range
  gates both directions at once.
- `matcher.js` adds `propertyTypeOutOfRange` alongside `priceOutOfRange`/
  `bedroomsOutOfRange`, forcing `NO_MATCH` regardless of total score.
- `no-match-reason.js`'s `property_type_mismatch` reason now reads the
  hard-gate flag instead of the raw score, matching the ADR-018/019
  pattern for the same robustness reason.

Regression tests reproduce all three real incidents literally (Townhouse
vs Apartment with no stated area/bedrooms; the 3-7M range vs 890K stock).

## ADR-024 — AI token/cost tracking on the dashboard, not an OpenAI balance API

Asked to show the OpenAI account's $ balance and token usage on the
dashboard. OpenAI exposes no API for a project's remaining prepaid/credit
balance (the old `/dashboard/billing/credit_grants` endpoint is gone for
paid accounts) and no API for its own per-model pricing either — the only
way to see a literal account balance is the billing page in the browser.
Scraping that private web UI was rejected (fragile, against terms of use).

Built the achievable, more useful thing instead: track our own pipeline's
actual spend, not the account-wide balance. Every `chat/completions`
response already carries a `usage` object (`prompt_tokens`/
`completion_tokens`/`total_tokens`) — `src/core/ai-usage.js` extracts it
(`extractUsageFromOpenAiResponse`, never throws on a malformed response)
and prices it against a hand-maintained per-model rate table
(`estimateCostUsd`; OpenAI doesn't expose its own prices via API, so this
must be updated by hand if a priced model's rate changes). Model-name
matching handles OpenAI returning a dated snapshot in the response
(`gpt-4o-mini-2024-07-18`) even when the request asked for the bare alias
— `resolvePricingKey` matches the longest known pricing key as a `-`
boundary prefix, confirmed against the real live response.

Wired as a telemetry side-branch, not part of the critical match/notify
path: `Validate Parser Result` (which already has the raw OpenAI response)
computes `aiUsage` and a new `PostgreSQL - Log AI Usage` node inserts it
into `matching.ai_usage_log` (migration 0013) in parallel with the normal
alias/stock/match pipeline — never chained in front of it. That node has
`onError: 'continueRegularOutput'` (new passthrough on `node()` in
`workflow-builder.js`) so a telemetry-write failure can never block a real
match from reaching Telegram.

Dashboard gained `/ai-usage`: KPI cards (spend today/7d/30d/all-time, total
tokens, total requests), a day/week/month bar chart
(`date_trunc` bucketing bound from a fixed allow-list, `renderBarChart` —
plain CSS flex bars, no charting library), and a recent-requests table.
Verified live: a real webhook call logged real token counts and a nonzero
estimated cost end-to-end.

## ADR-023 — Requester display name as a fallback when no contact link exists

Follow-up to ADR-022: "также ещё есть проблема с контактными данными из
whatsapp напрямую нет контакта в сообщении." Investigated
`whatsapp-worker/server.js`'s existing `sock.signalRepository.lidMapping
.getPNForLID(...)` call: it is a purely local cache/DB read, never an
active network lookup — confirmed by reading Baileys' own
`lid-mapping.js` (`getLIDForPN` does trigger a USync fetch on a cache
miss; `getPNForLID` does not, there is no reverse "resolve this LID to a
phone number" protocol exposed to clients at all). A WhatsApp phone
number only ever reaches our cache when the server itself chooses to
attach a `participant_pn`/`sender_pn` stanza attribute to a message —
entirely the server's decision, not ours, and not something any client
action (including messaging the person first) can force. This is a
genuine WhatsApp privacy-platform limitation, not a bug.

Since a contact link can legitimately never arrive for some senders, added
a name fallback: `matching.match_runs.requester_name` (migration 0012),
threaded through the same additive-plumbing path as `requester_contact_url`
(`Validate Parser Result` → `Deterministic Match` → `Insert Match Run` →
`Build Telegram Messages`). `telegram.js`'s REQUEST section now renders
`🙋 <name>` whenever a name was captured, independent of whether
`📞 <contact>` is also present — so a broker always has *something* to
search the source group by, even for a WhatsApp sender behind an
unresolved LID or a Telegram user with no public `@username`. Verified
live against the exact WhatsApp-LID scenario (`sender_id` ending in
`@lid`, `author_contact: null`, `author_name: 'Иван Петров'`): message
rendered `🙋 Иван Петров` with no `📞` placeholder, DB row persisted all
three fields correctly.

## ADR-022 — Requester contact captured at ingestion time, never re-resolved later

Real complaint: Telegram match notifications showed the buyer's request
criteria but no way to actually contact them — no username, no link.
Investigated the production monitoring workflow's own envelope-building
nodes (`Raw Telegram -> DEVI Envelope`, `Raw WhatsApp -> DEVI Envelope`):
both **already compute** a contact link the moment the raw message
arrives — `authorProfileUrl: https://t.me/<sender_username>` for Telegram
(built from the message event's own `sender_username`), `https://wa.me/
<phone>` for WhatsApp (parsed from the sender's JID). This is exactly the
right time to capture it: a group message can later be deleted or edited,
and there is no reliable way to re-resolve the sender by message ID after
the fact — "нельзя постоянно привязывать [контакт] к исходным сообщениям."
The gap was that `Explode Raw Leads for Matching Pilot` never forwarded
this already-computed field into the payload our matching pilot receives
— only `author_name` (a display name, not a clickable contact) made it
through.

Fix is purely additive plumbing, no new resolution step, no second call
to Telegram/WhatsApp needed:

- `Explode Raw Leads for Matching Pilot` (production node, manual paste)
  now also forwards `author_contact: lead.authorProfileUrl || null` and
  `sender_id: lead.senderId || null`.
- Threaded through the pilot's own pipeline unchanged in shape at every
  step (`Validate Parser Result` → `Deterministic Match` → `PostgreSQL -
  Insert Match Run` → `Build Telegram Messages`), the same way `groupName`/
  `sourceUrl` already flow alongside the parsed request without being part
  of `matcher.js`'s domain model.
- New `matching.match_runs.requester_contact_url` / `requester_sender_id`
  columns (migration 0011) — persisted once, permanently, independent of
  whether the source message still exists.
- `telegram.js`'s match message gained a `📞 <contact>` line in the
  REQUEST section, shown only when a contact was actually captured —
  never a placeholder when the sender has no public username/phone
  Telegram could expose (common for phone-only accounts with no
  username set).

## ADR-021 — Content-based dedup for the matching pilot's own webhook

Real complaint: the same buyer post cross-posted to several Telegram
groups (or reposted within one group) previously ran the full pipeline
again for every repost — separate AI-parse calls, separate match_runs,
separate Telegram alerts for what is the same request. Production
monitoring's own dedup (`Universal Filter + Normalize`'s
`sameChannelDedupe`/`crossChannelDedupe`) does not help here: `Explode Raw
Leads for Matching Pilot` branches directly off `Raw Monitor Primary Lead
Gate`, in parallel with — not downstream of — the node that computes that
dedup, so every repost still reaches our webhook as a "new" request (see
the earlier session's node-wiring investigation).

Added independent, portable dedup entirely within the pilot's own
webhook, with no changes to the shared production workflow:

- `src/core/content-dedup.js`'s `computeContentHash({ text, authorName })`
  keys on **author + exact normalized text** (case/whitespace folded,
  content untouched) — mirrors devi's own `authorName` + `messageExact`
  convention. A repost by the same author hashes identically; a different
  author writing superficially similar but distinct text never collides.
- New `matching.match_runs.content_hash` column (migration 0010).
- New workflow nodes, first in the pipeline, before the OpenAI call (to
  also save the API cost of re-parsing a repost): `Compute Content Hash`
  → `PostgreSQL - Check Duplicate Request` (`SELECT EXISTS(... WHERE
  content_hash = $1 AND created_at > now() - interval '48 hours')`,
  always exactly one row) → `IF - Is Duplicate Request`. The TRUE branch
  (a real duplicate) has no outgoing connection — the execution simply
  ends, no AI call, no match_run, no Telegram message. The FALSE branch
  continues into the existing pipeline unchanged.
- The AI parser node's `original_text`/`model` expressions now reference
  `$('NIKA Matching Webhook')` by name instead of the implicit `$json` —
  it no longer sits directly after the webhook trigger.
- 48-hour dedup window — long enough to catch same-day cross-posting
  across a broker's usual group list, short enough that a genuinely new
  post from the same person days later is never suppressed.

## ADR-020 — Real incident: `property_type` alone matched every villa in Dubai (74 STRONG_MATCH messages for one ambiguous post)

A "villa plot" request named 5 specific areas (Al Khawaneej, Al Barsha,
Al Warsan, Al Awir, Al Warqa) — a shape the pilot's single `area` field
can't hold, so the AI parser returned `area: null` — with a budget stated
as "Market Price" (unparseable, `budget_max: null`). Only
`property_type: "Villa"` survived extraction. `request-schema.js`'s
`hasAnyCriteria` check treated `property_type` on its own as enough to
consider the request "has usable criteria," skipping the
`parser_missing_fields` gate. With every other field null, "unknown
doesn't penalize" then gave full credit on location/bedrooms/budget/
furnishing, scoring **100/100 STRONG_MATCH against every villa in the
entire stock regardless of location** — 74 Telegram messages for one
ambiguous post.

`property_type` is real signal for *scoring* a specific candidate, but on
its own it is not specific enough to decide a request can be safely
matched against the whole stock — unlike area/building/bedrooms/budget,
knowing "some kind of villa" says nothing about *where* or *how much*.
Removed `property_type` from `hasAnyCriteria`'s check; a request needs at
least one of area/building/bedrooms/budget_max/budget_min to be
considered matchable. (Also fixed a related latent gap found while
touching this: `budget_max`/`budget_min` were never part of this check at
all before — a request stating only a budget was wrongly treated as
having no usable criteria either.)

This is a different bug class from ADR-018/019 (a specific bad pairing
slipping past a *known* per-field mismatch) — here the request itself was
too vague to safely evaluate against the whole stock at all, which is
exactly what `parser_missing_fields` exists to catch; it just wasn't
catching this particular shape of vague request.

**Separate, not yet addressed**: this specific request also revealed the
schema can't represent "any of these N named areas" — `area` is a single
string. A future improvement would let the parser return multiple areas
and match if stock is in any of them, rather than only being safe because
the whole request now gets rejected as insufficient. Filed for later;
today's fix is the correct, safe behavior (no match at all) even without
that enhancement.

## ADR-019 — Bedrooms is a hard gate too (real incident: 5BED request shown 4BED/3BED villas at 75/100)

Same problem class as ADR-018, found immediately after shipping it, from
a real Telegram alert: a request for a 5-bedroom villa (budget up to 10M,
no area stated) was shown a 4-bedroom villa and a 3-bedroom villa, both
scored exactly 75/100 — `location(30) + propertyType(15) + budget(20) +
furnishing(10) = 75`, zero bedroom credit, but 75 still clears the
70-point MATCH threshold on the other four criteria alone.
`bedroomsScore()` was already correctly scoring the mismatch as 0 — the
gap was the same as budget's: a 0 on one of five weighted criteria was
never enough by itself to force the overall result to NO_MATCH.

Added `isBedroomsAcceptable()` (`src/core/scoring.js`): unlike budget,
there is no percentage tolerance here — a stated bedroom count must match
exactly, since "1 bedroom off" is precisely the case reported as
unacceptable. `matcher.js` forces a candidate's status to `NO_MATCH`
whenever `isBedroomsAcceptable()` is false, the same hard-override
mechanism ADR-018 introduced for price, now driven by either flag. As
before: no stated request bedroom count never blocks ("unknown doesn't
penalize"), but a stock row with no recorded bedroom count is treated as
unverifiable and blocks — matching `bedroomsScore`'s existing asymmetry
(missing stock data already scored 0 there, unlike furnishing's "missing
stock data never penalizes"). `no-match-reason.js`'s `bedrooms_mismatch`
now reads the new `bedroomsOutOfRange` flag instead of the raw score, for
the same robustness reason as the budget fix.

Area (ADR-006), transaction_type (ADR-012), budget (ADR-018), and now
bedrooms (ADR-019) are the four hard gates; property_type and furnishing
remain purely scored criteria for now — no reported incident has shown
them independently pushing a bad match over the threshold yet.

## ADR-018 — Budget/price is a hard gate, not just a scored criterion

Real complaint: matched stock sometimes had a price far outside the
buyer's stated budget. Root cause: budget was only 20 of 100 weighted
points (`src/core/scoring.js`'s `budgetScore`), scored in graduated bands
(0-5% over = partial credit, 5-10% over = less credit, >10% over = 0) —
but scoring 0 on budget never blocked a match by itself, since
location(30)+bedrooms(25)+propertyType(15)+furnishing(10) alone sum to 80,
already above the 70-point MATCH threshold. A listing 2x over budget could
still surface as a MATCH purely on the other four criteria.

Added `isBudgetWithinTolerance()` (`src/core/scoring.js`) as a hard gate,
same treatment area (ADR-006) and transaction_type (ADR-012) already get:
if `stock.selling_price` exceeds `budget_max` by more than
`MATCH_PRICE_TOLERANCE_PCT` (default 10%) — or, symmetrically, falls more
than that percentage below a stated `budget_min` when no `budget_max` was
given — the candidate's status is forced to `NO_MATCH` in
`matcher.js`, regardless of total score. "Unknown doesn't penalize" still
holds: no stated budget bound, or no stock price, never blocks. The
existing graduated bands still apply *within* the tolerance window (a
listing 3% over budget still scores less than one at or under budget) —
this only adds a hard wall at the existing tolerance boundary that
was previously enforced by score value alone and could be overridden by
the other four criteria. `no-match-reason.js`'s `all_candidates_over_budget`
now reads the new `priceOutOfRange` flag instead of the raw budget score,
so it reports correctly even if a deployment configures a non-zero
`MATCH_BUDGET_SCORE_OVER_10`.

## ADR-017 — AI parser schema: `is_request` boolean replaced by four independent classification labels

Researching a competing product (Devi AI)'s "AI Leads Filter" settings —
see `docs/DEVI_CHANNEL_MONITORING_RESEARCH.md` — surfaced a concrete gap
in ADR-016's fix: a single `is_request: boolean` collapses several
genuinely different reasons a post isn't a buyer/renter request into one
undifferentiated `false`, which then always reports the same generic
`not_a_request` NO_MATCH reason regardless of whether the post was a
seller's own listing, spam, or someone just asking a question.

Replaced `is_request` with four independent booleans the AI parser
returns, mirroring Devi's own category shape (`buyingIntent`/`seekInfo`/
`promotion`/`spam`): `buying_intent` (genuine buyer/renter demand — the
old `is_request`, same permissive default of `true` when the parser
omits it), `seeking_info` (a question or complaint, not a stated
requirement), `promotion` (a seller/broker advertising their own
listing/business/job), `spam` (no genuine value). All three new labels
default to `false` (conservative) when omitted. Each is an independent
hard gate in `matchRequest()` (`src/core/matcher.js`) — any one true (or
`buying_intent` false) blocks a match regardless of what extraction
fields happen to be populated, same "must win over coincidental field
extraction" principle ADR-016 established. `no-match-reason.js` now
reports the specific cause (`spam_content` / `promotion_listing` /
`seeking_info` / `not_a_request` as a residual fallback) instead of one
generic reason for all four situations, checked in that priority order
(spam first, since a post can plausibly trip more than one label).

The system prompt (`scripts/templates/matching-workflow.js`) was
restructured to match Devi's own design principle, made explicit in
their prompt: keep the free-text prompt narrow (classification
instructions and context only) and let the AI commit to independent
named labels rather than one holistic relevance judgment — an LLM is
more reliable at "does this post match description X" per category than
at silently weighing competing signals into a single verdict.

Deliberately deferred (not part of this change): Devi's fully
configurable version of this — an editable prompt, an editable Key/Name/
Description filter table, and a Disabled/Manual analyze/Auto analyze
mode, all stored in a database and edited through a settings UI without
a redeploy. That is a materially larger feature (new schema, new
dashboard page, n8n reading config dynamically instead of at build time)
and was scoped out for now in favor of shipping the classification
improvement itself first.

## ADR-016 — Real incident: roommate-wanted post matched as STRONG_MATCH via `is_request=false` bypass (2026-09-14)

A roommate-wanted post ("Ищу соседку в однокомнатную квартиру в зал. Район
JVC" — "looking for a female roommate for a 1-bedroom apartment... JVC
area") reached a real 7-STRONG_MATCH Telegram alert
(`match_run.id=81`, `source_message_id=telegram:telegram_1813303517-457880`,
kept in Postgres as a historical record of the incident rather than
deleted). The AI parser correctly returned `is_request: false` for this
text, but still extracted `area: "JVC"` since the district is literally
named — `matcher.js` never actually checked `parsedRequest.is_request` at
all, only the `parser_missing_fields` warning (an "are all fields null?"
check), which the coincidentally-present `area` was enough to defeat. User
report verbatim: "это полный провал - не корректно работает."

Fix: added a `notARequest = parsedRequest.is_request === false` hard gate
in `matchRequest()` (`src/core/matcher.js`), OR'd into the existing
`blocked` condition alongside `missingParserFields`/`staleStock`/
`transactionTypeMismatch` — it wins regardless of which individual fields
the parser still managed to extract. Added a new `not_a_request` reason to
`src/core/no-match-reason.js`'s `REASONS` list, checked with the highest
priority of the whole cascade (before even `parser_missing_fields`), so the
dashboard/DB always shows the real cause instead of masking it as
"parser_missing_fields" or a coincidental area/bedroom mismatch. Regression
test added in `tests/unit/matcher.test.js` using the literal incident text.
Verified live: replaying the exact incident text through the production
webhook after deploy now yields `NO_MATCH` / `not_a_request` with
`parsed_request.is_request: false` and no Telegram alert.

## ADR-001 — Google Sheets is not runtime storage

Google Sheets is used for humans to edit Stock Inventory and Aliases. PostgreSQL is the runtime source queried by matching.

## ADR-002 — AI only parses requests

AI converts accepted free text to structured JSON. Deterministic code performs aliases, scoring, matching, persistence, and alert selection.

## ADR-003 — Every successful match is sent to Telegram

There is no Top-3 truncation. Message chunking is allowed; omission is not.

## ADR-004 — NO_MATCH is technical data

NO_MATCH is stored in PostgreSQL for debugging and omitted from the human Google Sheets Match Log.

## ADR-005 — Existing production monitoring is protected

Pilot integration is additive and isolated from existing listener/filter/dedupe branches.

## ADR-006 — Area is a viability filter, not just a scored criterion

`matcher.js` only scores stock whose (resolved or literal) area matches the
request's area; a completely wrong-area listing is excluded before scoring
rather than merely losing 30 of 100 points. Without this, a listing in the
wrong city could still reach the 70-point MATCH threshold on
bedrooms+type+budget+furnishing alone. Location's weight (30) instead
differentiates "same area, matching building" from "same area, different
building" among already-viable candidates.

## ADR-007 — Stale stock sync and missing parser fields hard-gate to NO_MATCH

Even if per-field scoring would otherwise sum to a passing score, a request
is forced to `NO_MATCH` when the stock snapshot is older than
`STOCK_STALE_HOURS` or the AI parser returned no usable criteria at all. Both
situations mean the score cannot be trusted (unknown criteria default to
"don't penalize", which would otherwise let an empty parse look like a
100/100 match against anything).

## ADR-008 — n8n Code-node JS is generated, never hand-duplicated

`scripts/build-workflows.js` concatenates the literal, unit-tested source of
`src/core/*.js` (via `scripts/lib/bundle-code-node.js`) into each Code node's
`jsCode`, appending only thin n8n-specific glue (`$input`/`$json` wiring).
There is no second hand-maintained copy of the matching/scoring/telegram
logic living inside workflow JSON to drift out of sync with the tested code.

## ADR-015 — One Telegram message per match, STOCK vs REQUEST side by side

Replaced the old "one message (or chunk) listing N matches" format with one
self-contained message per successful match, mirroring a broker-friendly
layout the user provided: a `📤 STOCK:` block (the matched listing) and a
`🎯 REQUEST:` block (the accepted lead's criteria) side by side, plus
`🔍 MATCH FOUND (i of N)`, score/status, `stock_id` (kept for traceability
even though not in the visual mock), broker contact, and the original
request link. This drops the old length-based chunking entirely — a single
match block is always short, so `telegram.js` no longer needs
`config.telegram.maxMessageLength` at all. Every message still carries the
full source_message_id and its position out of the total, so "never omit a
successful match" (AGENTS.md §6) holds — it is satisfied by N separate
messages instead of packed chunks.

## ADR-014 — Real incident: commercial listing matched as residential (2026-09-14)

A restaurant-business-for-sale post ("Looking for a ready restaurant
business in Dubai? ... Продаётся полностью готовый ресторан в Dubai
Marina...") reached a real 5-STRONG_MATCH Telegram alert. Root causes,
both fixed:

1. The upstream `rawFilterV2` buyer-intent regex matches bare
   "ищу"/"looking for" with no property context, so job ads, casting
   calls, and this business listing all passed our own pre-screen in
   `Explode Raw Leads for Matching Pilot`. Added
   `src/core/property-prescreen.js`'s `looksLikePropertyRequest()` — an
   explicit residential-keyword check required IN ADDITION to
   `rawFilterV2.passed`, tested directly against this incident's text and
   several other false positives found in production logs (§ REGRESSION
   tests in `tests/unit/property-prescreen.test.js`).
2. The AI parser returned `is_request: true, property_type: "restaurant"`
   for this non-residential listing. `matchRequest()`'s "unknown doesn't
   penalize" scoring meant 3 of 5 criteria defaulted to full credit
   (bedrooms/budget/furnishing all null), clearing the 85 STRONG_MATCH
   threshold on `area` + coincidental `furnishing` match alone despite
   `property_type` correctly scoring 0. Strengthened the AI parser's
   system prompt (`scripts/templates/matching-workflow.js`) to explicitly
   require `is_request=false` for seller listings, commercial/business
   posts, and non-residential `property_type` values — verified against a
   live OpenAI call with the exact incident text before deploying.

Fix (1) lives in `Explode Raw Leads for Matching Pilot`, a node the user
added directly to the production workflow — it is not part of either
pilot workflow's generated JSON and must be updated there by hand (or via
an explicit, narrowly-scoped API patch to that one node, same as the
earlier webhook-body-wrapping fix).

## ADR-013 — `telegram_post`/`whatsapp_post` moved from stock to match_results

User correction: these columns described the ACCEPTED REQUEST's original
chat post (which channel + link the buyer's message came from), not the
stock listing — `broker`/`broker_contact` correctly stay on
`stock_inventory` since those genuinely are stock properties. Migration
0008 drops `telegram_post`/`whatsapp_post` from `stock_inventory` (they were
always empty there in practice) and adds them to `matching.match_results`
instead, populated per successful match from the request's `provider` +
`source_url` via `src/core/source-links.js`'s `deriveSourcePostLinks()`.
`notes` stays on `stock_inventory` — it holds real per-listing remarks, a
separate concept. The Telegram notification header now also prints
"Original request: `<source_url>`" once (`telegram.js`'s
`buildTelegramMessages` gained a `sourceUrl` param) — this is what
MINI_PILOT_SPEC calls the "original message link", distinct from a stock
listing link. The Google Sheets Match Log tab needs `telegram_post` /
`whatsapp_post` headers added (autoMapInputData will then place these
automatically — see AGENTS.md's sheet-column notes).

## ADR-012 — Explicit `transaction_type_mismatch` NO_MATCH reason

Discovered via a real production lead: a RENT request scored against
SALE-only stock was previously diagnosed under whatever generic reason fell
out of the scoring cascade (e.g. `bedrooms_mismatch`), hiding the real cause.
`matcher.js` now hard-gates on `parsedRequest.transaction_type` not being in
`config.matchAllowedTransactionTypes` (checked right after
`parser_missing_fields`/`stock_not_synced`, before any area/bedroom/budget
diagnosis) and reports `transaction_type_mismatch` explicitly. A request with
no stated transaction type is not gated — nothing to contradict yet.

## ADR-011 — Dashboard is a small read-only Node web page, not a Sheets export

Considered syncing `matching.v_stock_match_counts` / `v_request_matches` /
`v_match_history` out to Google Sheets tabs (mirroring Stock Sync in
reverse). Rejected: these are naturally filterable, growing tables, not a
single KPI row, and duplicating them into Sheets on a timer just to view
data that already lives in Postgres adds a stale copy and a sync job for no
real benefit — direct SQL (Metabase or this dashboard) is strictly better.
Built `dashboard/` instead: a dependency-free Node `http` server (no
Express) that queries `matching.v_*` read-only and renders plain HTML —
`/`, `/stock`, `/stock/:id`, `/requests`, `/history` (with query-string
filters). Optional HTTP Basic Auth via `DASHBOARD_USERNAME`/`_PASSWORD`
since it displays real lead data (names, requests); unauthenticated mode is
only safe on a private network. `npm run dashboard` to start it.

## ADR-010 — All pilot tables/views live in a dedicated `matching` schema

Verified against the real database: the `matching_pilot` role has `CREATE`
only on a schema named `matching` (already provisioned by the DBA), not on
`public` — and correctly has read-only `SELECT` on `public.devi_messages`
with no `INSERT`/`UPDATE`/`DELETE`. Every migration, repository query, and
generated n8n SQL node therefore targets `matching.<table>` explicitly
(`matching.stock_inventory`, `matching.match_runs`, etc.); `public` is never
written to. This also matches `devi_messages`'s real columns
(`author_name_raw`/`author_name_norm`, not `author_name`) in the optional
`matching.v_match_history_with_source` enrichment view.

## ADR-009 — `n8n:deploy` never touches the production workflow

`scripts/n8n-deploy.js` only ever creates/updates the two pilot workflows,
resolved by an exact stored workflow ID (never fuzzy name matching), and
exposes no delete call. Wiring the existing production monitoring workflow
to the pilot's webhook is a manual step — `npm run n8n:plan` prints the exact
additive HTTP Request node/branch to add by hand. This keeps the
higher-blast-radius action (editing a live production workflow) a deliberate
human action even when `ALLOW_PRODUCTION_WORKFLOW_MUTATION=true`.

