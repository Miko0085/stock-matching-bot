# Market Contours & Source Routing — Mandatory Architecture

**Status:** MANDATORY / CURRENT ARCHITECTURE  
**Project:** Nika Estate / AI Broker Agent / Matching  
**Effective date:** 2026-09-22

> This document is a hard architectural contract. If older pilot/TZ/README text conflicts with this document, this document and `../AGENTS.md` take precedence.

## 1. Core rule: DUBAI, RF, and ABU_DHABI are independent matching contours

The system MUST NOT evolve into one universal real-estate matcher.

There are three independent domain contours:

```text
DUBAI MATCHING CONTOUR
RF MATCHING CONTOUR
ABU_DHABI MATCHING CONTOUR
```

(`ABU_DHABI` became a real third contour 2026-10-05 — built BY ANALOGY with
Dubai's own matching semantics, same field model and ranking weights, but
its own service/schema/routing label, never folded into Dubai's. See the
Abu Dhabi ADR in `docs/DECISIONS.md`.)

They may share transport and ingress infrastructure, but they MUST NOT share domain-specific matching logic.

Mandatory separation:

```text
Telegram Worker ─┐
                 │
WhatsApp Worker ─┼──► Shared Ingress / Source Router
                 │
Future Workers ──┘
                         │
              ┌──────────┼──────────────┐
              ▼          ▼              ▼
         DUBAI CONTOUR  RF CONTOUR   ABU_DHABI CONTOUR
              │          │              │
         DUBAI parser   RF parser    ABU_DHABI parser
         DUBAI aliases  RF aliases   ABU_DHABI aliases
         DUBAI stock    RF stock     ABU_DHABI stock
         DUBAI filters  RF filters   ABU_DHABI filters
         DUBAI ranking  RF ranking   ABU_DHABI ranking
         DUBAI AI fallback  RF AI fallback  ABU_DHABI AI fallback
         DUBAI cache    RF cache     ABU_DHABI cache
         DUBAI results  RF results   ABU_DHABI results
```

## 2. What may be shared

Only infrastructure-level concerns may be shared:

- Telegram transport;
- WhatsApp transport;
- provider adapters / raw envelope transport contracts;
- account/session lifecycle;
- source/group discovery;
- source catalog;
- technical event idempotency;
- source routing;
- observability infrastructure;
- authentication / API transport helpers.

Shared code MUST NOT contain DUBAI/RF property semantics.

## 3. What MUST NOT be shared

DUBAI and RF MUST have independent:

- stock tables;
- stock import/sync rules;
- request schemas;
- parsers;
- deterministic triage rules;
- AI prompts/fallback logic;
- aliases/dictionaries;
- location hierarchy;
- property-type normalization;
- unit semantics;
- budget/currency semantics;
- hard filters;
- matching rules;
- ranking/scoring;
- interpretation caches;
- match runs/results;
- regression fixtures and tests.

Do not create a monster `UniversalStructuredRequest` containing nullable fields for both markets.

Do not make RF semantics fit DUBAI fields, and do not make DUBAI semantics fit RF fields.

## 4. Database separation

One PostgreSQL instance is acceptable. Logical data ownership MUST be separated by schema.

Target ownership:

```text
ingest.*
matching_dubai.*
matching_moscow.*
matching_abu_dhabi.*
```

Recommended shared tables:

```text
ingest.processed_events
ingest.sources
ingest.source_routes
ingest.source_sync_runs
```

DUBAI examples:

```text
matching_dubai.stock_inventory
matching_dubai.location_aliases
matching_dubai.message_interpretation_cache
matching_dubai.match_runs
matching_dubai.match_results
```

RF examples:

```text
matching_moscow.stock_inventory
matching_moscow.location_aliases
matching_moscow.message_interpretation_cache
matching_moscow.match_runs
matching_moscow.match_results
```

ABU_DHABI examples (migration 0036; same column shape as DUBAI's own stock_inventory/match_runs/match_results, since its field model is a direct port, but a completely separate schema):

```text
matching_abu_dhabi.stock_inventory
matching_abu_dhabi.matching_aliases
matching_abu_dhabi.message_interpretation_cache
matching_abu_dhabi.match_runs
matching_abu_dhabi.match_results
```

**Joker-fed stock-only schemas** (added 2026-09-27, migrations 0025/0026): `matching_moscow.stock_inventory`/`location_aliases`/`stock_sync_runs` (Москва/Moscow market), plus `matching_oman.*`, `matching_saudi.*`, `matching_turkey.*` — each an identical 3-table shape (`stock_inventory`, `location_aliases`, `stock_sync_runs`), populated by `src/joker/joker-stock-sync.js` from Joker CRM (`moscow.nikaestate.ru`). These are **stock visibility only** — no matching/scoring logic exists for any of them yet (RF's own `match_runs`/`message_interpretation_cache` from migration 0018 remain a separate, still-`NOT_IMPLEMENTED` skeleton). `matching_saudi.*` here is a **distinct concept** from the `SAUDI` *routing label* in section 8 below — one is Joker stock data, the other is which contour an incoming Telegram/WhatsApp message routes to; neither reads the other today. DUBAI deliberately keeps reading its existing `matching_dubai.stock_inventory`, not a Joker-fed one — a future Joker→DUBAI sync is separate work (`docs/PER_MARKET_SERVICE_INDEPENDENCE_PLAN.md` §5.1). `matching_abu_dhabi.*` is also **not** Joker-fed — its stock/aliases sync from a dedicated Google Sheet instead (`scripts/abu-dhabi-sheet-stock-sync-run.js`), the same mechanism DUBAI originally used before its own sync was retired (ADR-040).

A DUBAI matcher MUST NEVER query `matching_moscow.*`/`matching_abu_dhabi.*` (or `matching_oman.*`/`matching_saudi.*`/`matching_turkey.*`).
An RF matcher MUST NEVER query `matching_dubai.*`/`matching_abu_dhabi.*`.
An ABU_DHABI matcher MUST NEVER query `matching_dubai.*`/`matching_moscow.*`.

## 5. Units and criteria are market-specific

### DUBAI

The DUBAI contour may use concepts such as:

- AED;
- sqft;
- bedrooms / BR;
- area/community;
- project;
- building/tower;
- bathrooms;
- furnishing;
- view;
- cash/mortgage;
- Dubai/UAE-specific property vocabulary.

### RF

The RF contour must be designed independently and may use:

- RUB;
- sqm / m² / кв.м;
- rooms;
- bedrooms when explicitly meaningful;
- Russian layout semantics such as euro-layouts;
- city / district / okrug;
- metro;
- residential complex / ЖК;
- корпус;
- new-build / secondary;
- handover/readiness;
- finish;
- mortgage;
- RF-specific property vocabulary.

**Forbidden:** parsing Russian `100 м²` into a field named `size_sqft` without explicit conversion.
Preferred design: RF owns `size_sqm_*`; DUBAI owns its own area semantics.

No unit conversion is required merely to make the two contours share one matcher.

## 6. Shared raw ingress, separate market processing

Workers emit transport-level events only.

Example:

```json
{
  "provider": "telegram",
  "account_id": "tg_main",
  "chat_id": "-100123456789",
  "message_id": "123",
  "chat_name": "Example Group",
  "sender_id": "456",
  "text": "raw original message",
  "source_url": "..."
}
```

The worker MUST NOT decide property compatibility, parse stock criteria, or choose a matching contour from real-estate semantics.

Routing happens in the shared ingress/source-routing layer.

## 7. Source Catalog is the source of truth for monitored groups

Telegram and WhatsApp groups/chats available in active sessions MUST be synchronized into PostgreSQL automatically.

The UI must expose this catalog and allow an operator to decide:

- listen / do not listen;
- route to any combination of DUBAI / RF / SAUDI / ABU_DHABI (2026-10-06, migration 0041: multi-route selection — a source may be routed to more than one contour at once, not just the old hardcoded DUBAI+RF `BOTH` pair);
- disabled;
- optional AUTO/fallback state (mutually exclusive with a real route, never combined);
- notes / labels / priority if useful.

`.env` allowlists such as `TELEGRAM_MONITOR_CHAT_IDS` and `WA_MONITOR_GROUP_IDS` are legacy/bootstrap fallback only. They MUST NOT remain the long-term control plane.

## 8. Recommended source tables

Minimum source catalog:

```text
ingest.sources

id
provider                 telegram | whatsapp
account_id
external_source_id       Telegram chat_id / WhatsApp group JID
source_type              group | channel | supergroup | community | other
name
username_or_handle
member_count             nullable
joined                    boolean
available                 boolean
last_seen_at              nullable
last_synced_at
metadata                  jsonb
created_at
updated_at
```

Unique identity should be based on:

```text
(provider, account_id, external_source_id)
```

Routing/config:

```text
ingest.source_routes

source_id
monitoring_enabled
route_modes                TEXT[] -- any non-empty combination of DUBAI | RF | SAUDI | ABU_DHABI, OR exactly one of AUTO | NONE (2026-10-06, migration 0041; BOTH retired as a stored value, see section 13)
manual_override           boolean
notes
updated_at
updated_by                nullable
```

It is acceptable to combine source + routing into one table initially, but keep source identity separate from domain-specific matching data.

**`DUBAI`** (renamed from `UAE`, migration 0034, 2026-10-05) is the routing
label for the Dubai market contour. It was renamed because a second,
distinct UAE-country market — Abu Dhabi — is coming: `UAE` could no longer
mean one undifferentiated bucket, it had to name the specific city actually
served today so `ABU_DHABI` can be added later as a true sibling label, the
same way `SAUDI` below was added as a label before any Saudi service
existed. All 64 sources previously tagged `UAE` were reclassified to
`DUBAI` by migration 0034 — a pure rename, not a judgment call, since every
one of them was already Dubai traffic.

**`SAUDI`** (migration 0024, 2026-09-27) is a routing label only — there is no
Saudi matching contour and no `saudi-lead-matching-service`. It exists so a
real Saudi Arabia source can be tagged correctly (found live: 9 Telegram
groups had been folded into `UAE` — now `DUBAI` — for lack of any other
bucket) instead of being mis-routed into the DUBAI contour.
`dubai-lead-matching-service`'s source-routing gate rejects a `SAUDI`-routed
message the same way it rejects `RF` — correctly, not a bug — until a
dedicated service exists. Building that service is a separate, larger
change and must update section 1's contour list and this table together,
same as any DUBAI/RF change.

**Update 2026-09-27**: a `matching_saudi.*` schema DOES now exist (migrations
0025/0026, section 4) — but it is Joker-fed **stock visibility data only**
(browsable at `/stock?market=saudi`), a completely separate concern from
this routing label. It currently holds zero rows (no Joker objects tagged
Saudi Arabia exist yet) and has no relationship to incoming message routing
— a `SAUDI`-routed message still resolves to `NOT_IMPLEMENTED`/rejected
exactly as described above. Do not conflate the two "Saudi" things when
reading this file.

**`ABU_DHABI`** (migration 0037, 2026-10-05) is, unlike `SAUDI`, a routing
label backed by a REAL, independently-running contour from day one:
`abu-dhabi-lead-matching-service` (port 8097), its own `matching_abu_dhabi.*`
schema (migration 0036, section 4), own AI parser and deterministic matcher
(Dubai's exact field model/ranking, ported BY ANALOGY), own Telegram bot,
and its own Google Sheets stock/aliases sync. `dubai-lead-matching-service`'s
and `rf-lead-matching-service`'s source-routing gates both reject an
`ABU_DHABI`-routed message (never mis-processed as Dubai or RF traffic);
`abu-dhabi-lead-matching-service`'s own gate accepts any `route_modes` array
containing `ABU_DHABI` (2026-10-06, migration 0041: a source can be routed
to Abu Dhabi alongside any other real market, e.g. `[DUBAI, ABU_DHABI]`) —
deliberately not `AUTO` yet, since it defaults to Dubai until a real
deterministic market classifier exists; giving AUTO a share of Abu Dhabi
traffic as a side effect of this gate's existence would be the same silent-
guess mistake this document already warns against. Zero existing sources
were pre-assigned this label at launch (same clean-bootstrap starting state
`SAUDI` had) — an operator assigns it manually via `/sources`.

## 9. Automatic source synchronization

### Telegram

The control plane/source-sync layer may query the existing Telegram Worker using its authenticated APIs, for example:

- accounts;
- dialogs/destinations/groups;
- group audit where useful.

It MUST discover groups from the already-connected Telegram session. It MUST NOT open a second Telethon session merely to inventory groups.

### WhatsApp

The control plane/source-sync layer may query the existing WhatsApp Worker using:

- `GET /whatsapp/accounts`;
- `GET /whatsapp/groups?account_id=...`.

It MUST use the existing Baileys-connected account.

### Sync behavior

Sync MUST be idempotent:

- upsert discovered sources;
- update name/username/member metadata;
- never reset an operator's routing choice merely because a source was re-synced;
- mark disappeared/unavailable sources rather than deleting historical configuration immediately;
- record sync timestamp/status.

## 10. UI requirements

The existing matching interface/dashboard should gain a **Sources / Channels** management area rather than introducing a separate unrelated admin product unless technically necessary.

Minimum UI behavior:

- list Telegram + WhatsApp sources;
- filter by provider;
- filter by account;
- search by group/channel name, username or ID;
- show current connection/discovery status;
- show monitoring on/off;
- show route: any combination of DUBAI / RF / SAUDI / ABU_DHABI, or AUTO, or NONE (2026-10-06, migration 0041 — a checkbox group, not a single dropdown);
- bulk-select rows;
- bulk enable/disable monitoring;
- bulk assign market route (one route choice applied to every selected row);
- edit one source instantly;
- sync/refresh sources on demand;
- show last sync time;
- clearly show sources discovered but not configured.

Changes made in UI MUST persist to PostgreSQL and become effective without editing `.env` manually.

## 11. Runtime routing rule

Preferred runtime order:

```text
Raw provider event
↓
shared event idempotency
↓
lookup source in ingest.sources/source_routes
↓
monitoring_enabled?
    no  → STOP
    yes → route_modes (array, 2026-10-06 migration 0041)
             ├─ includes DUBAI      → DUBAI contour also runs, independently
             ├─ includes RF         → RF contour also runs, independently
             ├─ includes ABU_DHABI  → ABU_DHABI contour also runs, independently
             ├─ includes SAUDI      → waits, tagged, for a future dedicated service
             ├─ = [AUTO]            → deterministic market router/fallback (defaults to DUBAI)
             └─ = [NONE]            → STOP
```

Each contour's own gate checks array membership -- a source routed to
`[DUBAI, ABU_DHABI]` is processed independently by both (see section 13,
which still describes this "more than one contour independently" behavior,
just no longer gated behind one magic `BOTH` value).

Do NOT send every message to every matching contour by default.

Manual route assignment has precedence over AUTO.

## 12. AUTO routing

AUTO is optional and must be fallback, not the primary architecture.

A deterministic router may use strong evidence such as:

DUBAI:
- Dubai/UAE geography;
- AED;
- known DUBAI project/area aliases.

RF:
- Moscow/Russia geography;
- RUB/₽;
- known Russian ЖК/metro/district aliases.

If confidence is insufficient, keep the source/message unresolved or route according to an explicit operator policy.

Do not spend an OpenAI call on every message merely to identify the market when the source itself is already manually assigned.

## 13. Multi-contour routing (formerly "BOTH routing")

Some mixed communities may legitimately route to more than one contour at
once. **`BOTH` is retired as a stored value (2026-10-06, migration 0041)**
— it used to be the only way to do this, hardcoded to the single pair
`[DUBAI, RF]`; `route_modes` is now an array, so a source can hold any
non-empty combination of the four real labels (e.g. `[DUBAI, RF]`,
`[RF, ABU_DHABI]`, or all four), not just that one pair.

When a source's `route_modes` holds more than one real label:

- the same raw event is handed to every contour named in the array;
- each contour parses/classifies/matches independently;
- each contour uses its own interpretation cache;
- each contour persists its own result;
- one contour's rejection must not suppress another contour's processing;
- cross-contour stock is still forbidden.

## 14. Deduplication boundaries

Technical event idempotency may be shared before routing:

```text
provider + account_id + chat_id/group_id + message_id
```

This only answers: "Have we already received this physical event?"

Content interpretation cache MUST be contour-specific:

```text
matching_dubai.message_interpretation_cache
matching_moscow.message_interpretation_cache
```

Never reuse a DUBAI interpretation as an RF interpretation or vice versa.

## 15. Joining a new Telegram source

Telegram auto-join remains a transport operation using the worker's existing persistent Telethon client.

After a successful join:

1. obtain canonical Telegram marked chat ID;
2. upsert the source into `ingest.sources`;
3. optionally assign route/monitoring from operator input;
4. do not silently choose a market if none was supplied;
5. do not automatically leave a chat when monitoring is turned off.

The CLI/UI may support:

```text
join target
+ account
+ monitoring
+ optional route (any combination of DUBAI/RF/SAUDI/ABU_DHABI, or AUTO, or NONE)
```

## 16. Worker responsibilities

Workers remain transport-only.

Allowed worker responsibilities:

- maintain Telegram/WhatsApp sessions;
- list accounts/groups/dialogs;
- join Telegram group/channel explicitly requested by operator;
- receive events;
- normalize provider transport fields;
- technical delivery/retry;
- enforce a technical monitoring subscription supplied by the control plane.

Forbidden worker responsibilities:

- buyer/seller classification;
- market-specific property parsing;
- stock access;
- property matching;
- scoring;
- DUBAI/RF business rules.

## 17. Control-plane behavior

The source catalog/UI is configuration/control plane.

It may:

- sync source lists from workers;
- persist monitoring state;
- persist market routing;
- push/serve effective monitored-source configuration to workers/router;
- show health and source status.

It MUST NOT become a third property matcher.

## 18. Migration from current env allowlists

Current env-based monitored lists must remain backward-compatible during migration.

Target sequence:

1. add DB source catalog;
2. sync existing Telegram/WhatsApp groups;
3. import current env allowlists into DB once or mark them as bootstrap sources;
4. build UI management;
5. make DB/control-plane routing authoritative;
6. keep env values only as emergency/bootstrap fallback;
7. remove dependence on manual env editing after acceptance.

Do not switch production routing destructively in the same change that introduces the catalog.

## 19. DUBAI service ownership

The current `dubai-lead-matching-service` (renamed from `lead-matching-service`, 2026-10-05) is the DUBAI contour.

Do NOT expand it into a universal DUBAI+RF matcher.

RF-specific parsing that has already leaked into the DUBAI local parser (for example Russian `млн`, `кв.м`, `спальни`) must not be used as justification for a shared domain model. During refactor, move RF-specific rules into the RF contour.

## 20. RF service ownership

RF matching should be implemented as a separate module/service, for example:

```text
rf-lead-matching-service/
```

It may reuse infrastructure patterns and pure technical helpers, but not DUBAI domain contracts blindly.

Before RF production cutover define separately:

- RF stock contract;
- RF request schema;
- RF location hierarchy;
- RF room/layout semantics;
- RF budget rules;
- RF size semantics;
- RF hard filters;
- RF ranking;
- RF aliases;
- RF regression dataset.

## 21. Change-control rules

Any future change that:

- mixes DUBAI/RF stock;
- introduces one shared universal request schema;
- routes every event to both by default;
- makes workers perform property matching;
- makes `.env` the permanent group-management UI;
- shares interpretation cache between markets;
- converts market-specific criteria just to satisfy a shared matcher;

is an architecture violation unless the user explicitly changes this contract.

Any intentional deviation must update this document and `AGENTS.md` in the same commit.

## 22. Required tests

Shared/control-plane tests:

- source sync idempotency;
- provider/account/source identity uniqueness;
- manual route survives re-sync;
- monitoring off stops routing;
- DUBAI route never calls RF matcher;
- RF route never calls DUBAI matcher;
- a multi-market `route_modes` array calls every named contour independently;
- NONE calls none of them;
- AUTO never overrides manual route;
- AUTO/NONE can never be combined with a real market, or with each other;
- event duplicate is stopped once before contour processing;
- source unavailable does not delete historical route configuration.

DUBAI tests remain DUBAI-only.
RF tests remain RF-only.

## 23. Target architecture

```text
                     CONTROL PLANE / UI
                            │
               Sources / Channels management
                            │
                       PostgreSQL
                    ingest.sources
                 ingest.source_routes
                            │
                            ▼
Telegram Worker ─┐    Shared Ingress/Router
                 ├──────────┬───────────┐
WhatsApp Worker ─┘          │           │
                            ▼           ▼
                       DUBAI Matcher   RF Matcher
                            │           │
                            ▼           ▼
                    matching_dubai.*  matching_moscow.*
```

This separation is mandatory.
