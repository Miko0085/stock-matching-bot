# Joker API Discovery

Real, authenticated findings against the live Joker CRM tenant, gathered
2026-09-15. Per `docs/JOKER_CRM_ADAPTER.md`: nothing here is guessed —
every field name below was observed in a real response. Real personal
data (names/phones/emails of actual staff) returned by the API is
**not** reproduced verbatim in this file — only field shapes and
sanitized/placeholder values, per "save sanitized fixtures."

## Credentials and base URL

```
JOKER_API_BASE_URL=https://moscow.nikaestate.ru/api
JOKER_API_TOKEN=<see .env — not committed>
```

Stored in `.env`/`.env.example` (`JOKER_API_BASE_URL`, `JOKER_API_TOKEN`),
never hardcoded in source. The token was shared in a chat message during
this session — treat it as already provisioned for this project, but note
that it was pasted in plaintext outside of a secrets manager; rotating it
once a proper secrets flow exists would be reasonable hygiene.

## Auth mechanism

Query-string token on every request: `?token=<token>`. No header-based
auth, no OAuth, no per-tenant path segment beyond the subdomain
(`moscow.nikaestate.ru` — the tenant is baked into the hostname, not a
request parameter).

## Endpoints verified live and responsive

| Endpoint | Method | Response time | Notes |
|---|---|---|---|
| `/api/agents` | GET | ~0.5s | Returns `manager_id`, `manager_name`, `manager_phone`, `manager_email`, `manager_position` |
| `/api/users` | GET | ~0.5s | Returns `id`, `name`, `phone`, `email`, `position` — overlaps heavily with `/api/agents` (see below) |
| `/api/lead_statuses` | GET | ~0.5s | Returns `status_id`, `status_name` (Russian labels, e.g. "Новый", "Отказ") |
| `/api/developments` | GET | ~15s | Slow but succeeds — returns nested `objects[]`/`developer{}` per development |

## `/api/objects` — RESOLVED: it was pagination shape, not a broken endpoint

**Correction to the earlier version of this document.** Every attempt
that timed out (`limit=1`, `limit=2`, `id=1`, `full=0`, `published=1`, all
as flat query-string parameters) was hitting the exact same bug: this
endpoint's `limit`/`offset`/`id`/`filter` are **not** flat query
parameters — they must be nested inside the single `params` query
parameter as a JSON string (the same shape `/api/leads` and `/api/deals`
already showed in the public docs' example URL — `/api/objects` uses that
convention too, it just isn't obvious from the docs' own parameter list,
which prints `limit (int)` / `offset (int)` at the same indentation as
`token`, implying flat params). Sending flat `limit=1` is silently
ignored, so every one of those "cheap" test calls was actually asking the
server to serialize its **entire live catalog — 14,880 objects, ~127,000
images** — which blows well past nginx's 60s upstream timeout and comes
back as a bodiless `504` (curl reports that as `HTTP_CODE:000`/exit 28
since no headers ever arrive within the client timeout either). It was
never a broken handler — it was every test in this session accidentally
requesting a full unpaginated dump.

**Working call**:

```
GET /api/objects?token=<token>&full=1&params=%7B%22limit%22%3A200%2C%22offset%22%3A0%7D
```

i.e. `params={"limit":200,"offset":0}`, URL-encoded as one query value.
Confirmed live: `limit=2, offset=0` answered in **0.68s**; a 30-row page
with `full=1` in **1.3s**. Paginating the full catalog at `limit=200` is
~75 requests (14,880 ÷ 200), ~3s each.

**Two parsing gotchas, both confirmed live**:

1. `params` must be URL-encoded as a whole JSON string; `limit`/`offset`/
   `id`/`filter` all live *inside* it, never as sibling query params.
2. **`data` is a dict keyed by object ID** (`{"12620": {...}, "12621":
   {...}}`), not an array — iterate `Object.values(data)`, never
   `data[0]`. **Edge case**: when a page has zero results (e.g. `offset`
   past the end of the catalog), `data` flips to an **empty array `[]`**
   instead of `{}` — a mapper must handle both shapes
   (`Array.isArray(data) ? [] : Object.values(data)`).

## Real object shape (sanitized — field names/shapes only, no real PII)

Confirmed against real commercial and residential (apartment) listings,
`full=1`:

```json
{
  "id": 12631,
  "number": "J12631",
  "title": "3-к.квартира, 108 м², 3/6 эт.",
  "type": "Квартиры - вторичное жильё",
  "deal_type": "sale",
  "description": "...",
  "address": "с. Эсто-Садок, ул. Березовая, д. 16",
  "region": "Краснодарский край",
  "city": "Сочи",
  "district": null,
  "microdistrict": null,
  "roads": [],
  "subways": [],
  "street": "...", "house": "...", "corpus": null, "apartment": null,
  "room_number": null,
  "coordinates": [43.6888329, 40.2499229],
  "price": "53000000",
  "date_create": { "date": "2022-05-06 13:51:46.000000", "timezone_type": 3, "timezone": "Europe/Moscow" },
  "date_update": { "date": "2022-07-07 18:11:38.000000", "timezone_type": 3, "timezone": "Europe/Moscow" },
  "images": ["/var/www/jokercrm/web/images/objects/12620/....jpg"],
  "video": null,
  "exclusive": false,
  "development": null,
  "complex": null,
  "url": "https://moscow.nikaestate.ru/catalog/sale/vtorichka/object/12631",
  "contact": { "id": 4, "name": "<redacted>", "phone": "<redacted>", "phone_two": null, "email": null, "manager_id": 25, "created": {"date": "...", "timezone": "Europe/Moscow"}, "type": "Продавец (Арендодатель)" },
  "agent": { "id": 84, "name": "<redacted>", "phone": "<redacted>", "email": "<redacted>", "position": "Брокер отдела продаж" },
  "params": {
    "rooms": { "name": "Количество комнат", "value": "3" },
    "area": { "name": "Общая площадь", "value": "108 м²" },
    "living-space": { "name": "Жилая площадь", "value": "65 м²" },
    "kitchen-space": { "name": "Площадь кухни", "value": "15 м²" },
    "floor": { "name": "Этаж", "value": "3" },
    "floors-total": { "name": "Этажей в доме", "value": "6" },
    "bathroom-unit": { "name": "Тип санузла", "value": "Совмещенный" },
    "rooms-type": { "name": "Планировка", "value": "Изолированная" },
    "balcony": { "name": "Тип балкона", "value": "2 балкона" },
    "building-type": { "name": "Тип дома", "value": "монолит" },
    "window-view": { "name": "Вид из окон", "value": "на улицу" }
  }
}
```

### Concrete field mapping to our canonical `stock_inventory`

| Canonical field | Joker source | Notes |
|---|---|---|
| `external_listing_id` | `id` | integer, stable |
| `transaction_type` | `deal_type` | `"sale"` / `"rent"` — direct map to `SALE`/`RENT` |
| `property_type` | `type` | **free-text Russian category**, not a clean enum: observed `"Квартиры - вторичное жильё"` (apartments/secondary), `"Дома, дачи, коттеджи"` (houses/dachas/cottages), `"Коммерческая недвижимость"` (commercial). Needs a translation table; commercial `type` values should be filtered out entirely (out of scope, same as our own `is_request`/`promotion` filtering) |
| `bedrooms` | `params.rooms.value` | **Not `room_number`** — that top-level field was `null` on every real apartment observed. `params.rooms.value` is a numeric string (`"3"`), needs parsing. Only present when `full=1` |
| `size_sqft` | `params.area.value` | Free text `"108 м²"` (**square meters, not sqft** — needs unit conversion for the Dubai/sqft pilot schema, and only present with `full=1`) |
| `selling_price` / `annual_rent` | `price` | Numeric string, no separate currency field — this tenant is RUB. Route to `selling_price` when `deal_type=sale`, `annual_rent` when `deal_type=rent` (rent period, e.g. per month vs per year, still unconfirmed) |
| `city` | `city` | Direct |
| `area` | `district` or `microdistrict` | Both nullable independently (the Sochi example above has neither populated — only `region`/`city`); needs a fallback chain, not a single field |
| `building` | — | No direct field; `development`/`complex` (both null in every example seen so far) are presumably populated for new-build listings inside a named residential complex — unconfirmed, needs an example with a real ЖК |
| `responsible_broker_id` | `agent.id` | Maps to the same numeric ID space as `/api/agents`' `manager_id` (needs the deliberate cross-check flagged earlier, now actually checkable) |
| `listing_owner_broker_id` | `contact.manager_id` | **Tentative** — `contact` is the property owner/client (`contact.type: "Продавец (Арендодатель)"`), and `contact.manager_id` is who manages *that client relationship*, which is not necessarily the same person as `agent.id` (confirmed different in the sample above: `agent.id=84`, `contact.manager_id=25`). This is the closest real distinction to "listing owner" vs "responsible broker" this CRM exposes — not a confirmed 1:1 semantic match to our two fields, but a reasonable mapping to ship with |
| `source_updated_at` | `date_update.date` | Nested object, not a plain string — `{date, timezone_type, timezone}`; parse `date` as `Europe/Moscow` local time |
| `furnishing` | — | **Does not exist** on this CRM's object model, confirmed (no such key anywhere in `params` across all samples). Leave `null` for Joker-sourced stock |
| — (no field) | — | **No `status`/`published`/`archived` field is ever returned on the object itself**, confirmed by fetching `params={"filter":{"archived":true}}` and finding the *exact same field set*, no extra marker. Active/inactive is a **query-time filter only** — see below |

### Status/deactivation model (confirmed)

There is no per-object status field. Determining "is this still active" is
purely a function of which filtered query returns it:

- Default query (no `filter`) → active/current catalog
- `params={"filter":{"archived":true}}` → confirmed working, returns
  archived/deactivated listings (same field shape, no extra marker)

**Sync implication**: safe deactivation (per `JOKER_CRM_ADAPTER.md`, "mark
explicitly inactive/deleted stock safely," never blind truncate) means:
fetch the full active set by paginating the default query, and any
previously-synced `external_listing_id` that does **not** appear in this
run's active set gets marked inactive in `stock_inventory` — not deleted.
Optionally cross-check newly-missing IDs against the `archived: true`
filter to log *why* it disappeared, though that's an enhancement, not a
requirement for safe deactivation.

### Pagination (confirmed)

No `total`/`count` field anywhere in the response — the client must page
until an empty result (`data` becomes `[]`) to know it has reached the
end, rather than computing a fixed page count up front (75 pages was this
session's estimate from a known catalog size, not something the API
states).

## `/api/agents` vs `/api/users` — overlapping, not identical

Both returned what looks like the same underlying staff list, but under
different field names and with a different filter: `/api/users` included
at least one row `/api/agents` did not (an entry with a generic
"info@nikaestate.ru"-style contact, no phone, no position — looks like a
shared/system account rather than an individual broker). Field mapping:

| `/api/agents` | `/api/users` | Meaning |
|---|---|---|
| `manager_id` | `id` | The identifier — **not yet confirmed whether these two IDs are the same numeric space** (i.e. does `agents[].manager_id == 82` refer to the same person as `users[].id == 82`?). Spot-checking the sanitized sample data during this session, the numeric IDs *did* line up for the rows present in both lists, but this needs a deliberate cross-check with more data before the adapter trusts it as a given, per `JOKER_CRM_ADAPTER.md`'s "do not assume Joker agent, owner and responsible user are equivalent." |
| `manager_name` | `name` | Full name, single field (not split first/last) |
| `manager_phone` | `phone` | Nullable; formats observed both as `+7(966)034-0199` and `+79660316371` (inconsistent formatting — normalize before storing) |
| `manager_email` | `email` | Nullable, but present for every row observed |
| `manager_position` | `position` | Nullable free text, e.g. "Специалист по недвижимости" (Property Specialist), "Брокер отдела продаж" (Sales Department Broker) |

**Open question for the adapter, now actually checkable**: `agent.id`
observed on real objects (e.g. `84`) needs a deliberate cross-check
against `/api/agents`' `manager_id` space (not just spot-checked) before
the mapper trusts it as the same ID space — cheap to confirm once actual
sync code queries both.

## What remains genuinely unverified

Down to a short list now that `/api/objects` works:

```
development/complex field shape — every sample this session had both
  null (standalone listings); needs an example inside a named ЖК to see
  the real shape
rent price period (per month vs per year) — `price` on rent listings has
  no visible period field; may be implied by convention or by `params`
distinct property-type taxonomy per deal_type (`type` mixes residential
  and commercial categories in one free-text field; needs the full
  distinct value set across a larger sample to build a translation table
  cleanly, and to decide which `type` values to exclude as non-residential
  — mirrors our own is_request/promotion filtering, ADR-017)
rate limits (still only a handful of requests total this session; no
  429/Retry-After seen, not a real answer either way)
webhook availability (no webhook endpoint anywhere in the documented API
  surface — Joker sync should still be assumed poll-only)
```

## Status against `docs/JOKER_CRM_ADAPTER.md`'s "Required discovery phase" checklist

| Item | Status |
|---|---|
| API base URL | ✅ confirmed |
| Authentication method | ✅ confirmed (query-string token) |
| Tenant/account identifier | ✅ confirmed (subdomain-scoped, `moscow.nikaestate.ru`) |
| Users endpoint | ✅ confirmed, live |
| Agents endpoint | ✅ confirmed, live |
| Object/listing endpoint | ✅ **confirmed, live** — required `params={"limit":...,"offset":...}` JSON-encoded, not flat query params |
| Pagination | ✅ confirmed (`limit`/`offset` inside `params`; no total count — page until empty) |
| Incremental filtering | ⚠️ `filter.archived` confirmed working; `date_update`-based incremental filtering not yet tried |
| Object status values | ✅ confirmed — there are none; active/archived is filter-time only, not a returned field |
| Listing owner field | ⚠️ tentative mapping (`contact.manager_id`) — plausible, not semantically confirmed |
| Responsible user field | ✅ confirmed (`agent.id`/`agent.name`/etc.) |
| Price field / currency | ✅ confirmed (`price`, bare numeric string, RUB implied by tenant) |
| Property type | ⚠️ confirmed as free-text `type`, translation table still needed |
| Area/community/building representation | ✅ confirmed (`city`/`district`/`microdistrict`, both nullable; no `building` equivalent found yet) |
| Bedrooms | ✅ confirmed — `params.rooms.value`, not `room_number` |
| Furnishing | ✅ confirmed absent from this CRM's object model |
| Publication/active status | ✅ confirmed (filter-time only, see above) |
| updated_at | ✅ confirmed (`date_update.date`, nested with timezone) |
| Deleted/archive behavior | ✅ confirmed (`filter.archived`, no destructive delete needed on our side) |
| Rate limits | ⚠️ still unconfirmed, small sample |
| Webhooks | ⚠️ none documented — assume polling-only |

## Dubai/UAE inventory exists in this same tenant — but data quality is suspect

This CRM tenant is not Moscow-only: one listing's own description text
says "Nika Estate — международное агентство... Москве, Сочи, ...,
**Дубае**, Марбелье, Ташкенте," and a distinct-value scan across a
~1,600-object sample (16 pages of 100, spread evenly across the full
14,880-object catalog) confirmed it: **`region: "ОАЭ"` appeared 24 times
in that sample** (`city` split across `"Dubai"` (18), `"Дубай"` (4),
`"Абу-Даби"` (2) — inconsistent spelling for the same country).
Extrapolated across the full catalog: **roughly 220 UAE objects**
(24 ÷ 1,600 × 14,880).

**This is directly relevant** — it's the same market this pilot matches
against — but a closer look at the 24 real UAE objects on one page (IDs
27451–27519, all created the same day, 2026-05-29 — one bulk-import
batch) turned up data-quality red flags serious enough that this should
**not** be treated as ready-to-sync inventory without checking with
whoever administers Joker first:

- **Identical price across clearly different listings**: `779569054`
  appears on 4 separate objects with different floors and layouts (a
  penthouse and a regular apartment on different floors, both "35 → 24th
  floor of 48" and "40th floor of 50" — priced exactly the same to the
  unit). `24411263` repeats on two more. Real distinct listings do not
  coincidentally share an 9-digit price to the exact digit.
- **Zero-price, empty-title objects**: IDs 27496 and 27504 have
  `price: 0` and `title: ""` — incomplete records.
- **Prices don't scale sensibly in any currency**: a rented studio at
  `1379767` vs. a similarly-sized 1-bedroom rental at `168055` (8x
  cheaper for a *larger* unit) on the same page, same currency
  presumably — inconsistent with AED, RUB, or USD pricing for these unit
  descriptions.
- One listing tagged `city: "Дубай"` describes itself in the text as
  being in **Masdar City, Abu Dhabi** — city/region tagging for the UAE
  subset is not reliably accurate.

**Working hypothesis, not confirmed**: this looks like a single, recent,
possibly-test or incompletely-processed bulk import, not curated,
sync-ready inventory the way the Moscow/Sochi/SPb listings appear to be
(those had varied, plausible prices and no exact-duplicate values in the
samples pulled this session). **Recommendation**: before building any
Joker → `stock_inventory` sync that includes UAE objects, ask whoever
manages the Joker CRM tenant whether this Dubai/Abu Dhabi batch is real,
finalized inventory or a test import — do not sync it into the matching
pilot's live stock on the assumption it's usable as-is.

**New field observed only on UAE-market objects**: `params.BedroomsCount`
("Количество спален") — distinct from `params.rooms` ("Количество
комнат", total room count including living areas, the Russian-market
convention). On the one full example pulled, `rooms: "3"` but
`BedroomsCount: "2"` — for UAE-sourced stock, prefer `BedroomsCount` over
`rooms` for the canonical `bedrooms` field; Moscow-market objects sampled
so far don't carry this key at all, so the mapper needs both paths.
`rooms` can also be the literal string `"Студия"` (Studio) rather than a
number — same "studio == 0 bedrooms" handling our own `normalizeBedrooms`
already does should apply here too.

## Conclusion

Both broker identity discovery (agents/users) **and stock/object
discovery are now unblocked** with real, confirmed field shapes. The
`JokerMapper`'s canonical `stock_inventory` mapping can be implemented
against real fields (see the mapping table above) rather than guessed —
the two remaining soft spots (`type` → `property_type` translation table,
and `contact.manager_id` → `listing_owner_broker_id` semantic confirmation)
are refinements to do alongside writing the mapper, not blockers to
starting it. The `JokerSyncService` (sync run bookkeeping via
`joker_sync_runs`, paginated fetch, safe upsert-not-truncate,
filter-based deactivation) can now be built end-to-end against real
Moscow/Sochi/SPb data. **UAE objects specifically need a data-quality
conversation with the Joker CRM administrator first** (see above) before
they're treated as real, syncable Dubai stock for this pilot.
