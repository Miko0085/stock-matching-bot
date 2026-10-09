# Joker CRM export guide — filtering, pagination, account nuances, field review

Practical reference for anyone writing or maintaining a Joker → `stock_inventory`
sync. Everything here is grounded in live API calls made during the
2026-09-29/30 UAE-stock investigation (see `docs/DECISIONS.md` ADR for the
sync itself) and the original `docs/JOKER_API_DISCOVERY.md` audit
(2026-09-28) — read that file too; this one extends it with confirmed
filtering behavior and a full field-availability review, it does not
replace it.

## 1. Account / tenant model

One Joker CRM tenant (`moscow.nikaestate.ru`) holds **all markets in one
object pool** — Moscow, Saint-Petersburg, Krasnodar region, Tatarstan,
Moscow oblast, Samara oblast, Turkey, Uzbekistan, Crimea, Georgia, Cyprus,
Greece, and the UAE all live in the same `/api/objects` catalog. There is
**no per-market endpoint or account** — every sync (Moscow, Oman, Saudi,
Turkey, UAE) reads the exact same endpoint and separates markets itself
by inspecting each object's `region` field client-side.

Full live breakdown (2026-09-30, 14,939 objects scanned):

| region | count |
|---|---|
| Москва | 10,411 |
| Санкт-Петербург | 2,065 |
| Краснодарский край | 769 |
| Татарстан | 669 |
| Московская область | 579 |
| Самарская область | 128 |
| *(no region)* | 104 |
| **ОАЭ** | **102** |
| Турция | 29 |
| Узбекистан | 25 |
| Крым | 19 |
| Грузия | 14 |
| Ленинградская область | 6 |
| Южный Кипр | 5 |
| Тверская область | 4 |
| Владимирская область | 4 |
| Москва и Московская область | 3 |
| Греция | 1 |
| Башкортостан | 1 |
| Карачаево-Черкесия | 1 |

## 2. Auth

`JOKER_API_BASE_URL` (default `https://moscow.nikaestate.ru/api`) +
`JOKER_API_TOKEN`, both env vars. Token goes on every request as a plain
query param (`?token=...`), no header-based auth. Client lives at
`dashboard/joker-client.js` (`listJokerAgents`, `listJokerObjectsPage`) —
reuse it, don't write a second HTTP client.

## 3. The one big gotcha: `params` is a single JSON-encoded query value

`limit`, `offset`, `filter`, and `full` are **not** flat query-string
parameters — they must all live inside one `params` query value, itself a
JSON string:

```
GET /objects?full=1&params={"limit":200,"offset":0,"filter":{"archived":true}}
```

`dashboard/joker-client.js`'s `listJokerObjectsPage({limit, offset, full,
filter})` already builds this correctly — never hand-build the query
string. Passing `limit`/`offset`/`filter` as flat, sibling query params
(the "obvious" way) causes the request to hang/time out rather than
erroring cleanly — already documented as the first thing that goes wrong
in `docs/JOKER_API_DISCOVERY.md` §"why the first calls timed out".

## 4. Pagination

No total-count field anywhere. Page with `limit`/`offset` until a page
returns an empty `data` (`{}`/`[]`) — that's end-of-catalog. `data` is a
**dict keyed by object id** when non-empty, flips to `[]` when the page is
past the end — `joker-client.js` already normalizes both shapes to a
plain array. `limit=200` is the convention already used by every existing
sync (`src/joker/joker-stock-sync.js`); no evidence it needs to be lower.

## 5. Filtering — what actually works (tested live, 2026-09-30)

There is **no per-object status field at all** — confirmed independently
twice (2026-09-28 and 2026-09-30): fetching the exact same object with
`filter: {archived: true}` vs. no filter returns the identical field set,
no extra marker. "Is this active" is **purely a function of which query
returns it**:

| Filter tried | Result |
|---|---|
| *(no filter)* | Returns the current/non-archived catalog (the "active" set) |
| `filter: {archived: true}` | ✅ **confirmed working** — returns archived/deactivated listings |
| `filter: {city: [...]}` | ❌ **confirmed NOT working** — silently ignored; a live test passing `filter: {city: ['Дубай','Абу-Даби']}` still returned Moscow rows unfiltered |
| `filter: {region: 'ОАЭ'}` | ❌ **confirmed NOT working** — same silent-ignore behavior |

**Practical consequence**: you cannot ask the API for "just the UAE
objects" or "just Dubai" server-side. Every market-specific sync
(Moscow/Oman/Saudi/Turkey today, UAE as of this work) does a **full,
unfiltered catalog pull** and filters client-side on `region` after the
fact — this is not a workaround, it's the only approach the API supports,
and it's already the production pattern in `src/joker/joker-stock-sync.js`.
A full pull of the ~14,900-object catalog at `limit=200` takes roughly
1-2 minutes.

Given the admin UI's own filter panel (Объекты → Фильтр) *does* offer a
"Населённые пункты" (settlements) dropdown that visibly narrows results,
that filter almost certainly keys off an internal location ID looked up
from a separate reference list, not the literal city string the object
itself exposes — worth confirming with whoever administers Joker before
assuming `filter.city` could ever be made to work by passing a different
value shape.

## 6. `full=1` vs `full=0`

`full=0` returns only the top-level fields (id, title, type, deal_type,
region, city, price, dates, etc.) — enough for a region-count scan.
`full=1` additionally returns `params` (the free-form attribute bag) and
`layouts` (see §7) — required for any real field mapping (bedrooms, area,
furnishing, etc. all live inside `params`).

## 7. Structural gotcha: single-unit listings vs. multi-layout project listings

This is the most important structural finding from this session and the
easiest to get wrong silently.

- **Single-unit listing** (e.g. `type: "Квартиры - вторичное жильё"`,
  `"ОАЭ Квартиры (готовое жильё)"`, most houses): the object represents
  one specific, sellable unit. Its own top-level `price` is the real
  price.
- **Multi-layout project listing** (e.g. `type: "Квартиры в
  новостройках"`, most of `"ОАЭ Квартиры в новостройках (off-plan)"`):
  the object represents a whole building/development, and a `layouts`
  dict holds one entry per floor-plan/unit type actually for sale, each
  with its own `title`/`price`/`params`. **The parent object's own
  top-level `price` is not a real per-unit price for these** — confirmed
  on a real example (Joker id 25602): top-level `price: 1,103,947,737`
  (nonsensical), while its two real `layouts` had sane prices
  `14,161,000` and `19,880,000` AED.

Detect this with `Object.keys(obj.layouts || {}).length > 0`. Of the 102
live UAE objects (2026-09-30), 37 have layouts, 65 don't. **Never read a
project-listing's top-level `price` as if it were a single sale price.**
Building real support for layouts means expanding one Joker object into
N stock rows (one per layout) — not yet built (see the UAE sync ADR).

## 8. Property-type signal: three different fields, none complete alone

| Field | What it is | Coverage (of 65 single-unit UAE candidates) |
|---|---|---|
| top-level `type` | Coarse Russian category (`"Квартиры - вторичное жильё"`, `"ОАЭ Квартиры (готовое жильё)"`, `"Дома, дачи, коттеджи"`, `"Коммерческая недвижимость"`, ...) | 100% (always present) but only distinguishes market segment/construction status, **not** physical form (apartment vs villa vs townhouse) |
| `params[*].name === "Тип недвижимости"` | Finer, Dubai-specific (`"Апартаменты"`, `"Вилла"` observed) | **28%** (18/65) |
| Free-text `title`/`description` | e.g. `"3-к.апартаменты..."`, `"коттедж 822.9 м²..."` | Usable as a fallback signal, not structured |

None of these map 1:1 onto UAE's own existing `property_type` vocabulary
(`Apartment`, `Villa`, `Townhouse`, `Penthouse`, `Office`, `Retail`,
`Bulk-Sale-Unit` — confirmed live from `matching_dubai.stock_inventory`'s
real distinct values). A translation table is unavoidable and will be
incomplete for the 72% of objects missing "Тип недвижимости" — those fall
back to a coarser guess off `type`/title text, which should be treated as
lower-confidence.

## 9. Field-by-field review against the target stock-inventory columns

Reviewed against `matching_dubai.stock_inventory`'s real column list, using
live field-presence stats over the 65 real single-unit UAE candidates
(2026-09-30 pull). "Coverage" means non-null/non-empty on that sample.

| Target column | Joker source | Coverage | Notes / issues |
|---|---|---|---|
| **status** | *(no equivalent field exists anywhere in the object)* | — | Confirmed twice independently: Joker has no status field at all. Must be **derived**: present in a full default-query pass = active-eligible; absent from a later pass = inactive. Never read off a field because there isn't one. |
| **transaction_type** | `deal_type` (`sale`/`rent`) | 100% | Direct, clean map to `SALE`/`RENT`. |
| **city** | `city` | 100% | **Inconsistent spelling**: `Dubai` (49), `Дубай` (34), `Абу-Даби` (19) for the same two real cities — needs a normalization table before use as a match key. |
| **area** | `district` / `microdistrict` | **0% / 2%** | Effectively **missing** for UAE — both fields were null on every single-unit candidate but one. The real neighborhood name (e.g. "Jumeirah Village Circle") only exists embedded inside the free-text `address` string, in no fixed position. |
| **project_community** | *(no dedicated field)* — `complex`/`development` | **0%** | Both always null on every UAE object seen. The project/community name, when present, is embedded in `address` (comma-separated, but segment order/count varies — see two real examples: `"Dubai, Jumeirah Village Circle, District 10, Binghatti Corner"` vs. `"Dubai, Falcon City of Wonders, Wadi Al Safa 2, Dubailand"`). Parsing this reliably needs a defined convention, ideally confirmed with the Joker admin, not guessed. |
| **building** | *(no dedicated field)* | 0% | Same as `project_community` — only reachable via fragile `address` parsing. |
| **bedrooms** | `params.BedroomsCount` | **28%** (18/65) | The dedicated UAE-specific field (per `docs/JOKER_API_DISCOVERY.md`'s own earlier finding) but sparsely filled in. No reliable fallback confirmed yet. |
| **bathrooms** | `params[*].name` containing "санузл" (`"Количество санузлов"` / `CombinedWcsCount`) | **35%** (23/65) | Present under different param keys/labels depending on listing type — must match by name substring, key numbers are not stable across objects. |
| **property_type** | `type` (coarse) + `params["Тип недвижимости"]` (fine, 28% coverage) | see §8 | Needs a translation table into UAE's real vocabulary; incomplete for most objects. |
| **selling_price** | `price` (when `deal_type=sale`, single-unit only) | ~88% usable | AED, confirmed by the user. Real defects found: a 4-way exact-duplicate-price cluster (obj ids 27451/27452/27455/27460, all 779,569,054 AED — clearly placeholder, not real), 3 more duplicate-price pairs/groups, and the entire 22-object `"ОАЭ Квартиры в новостройках (off-plan)"` single-unit subgroup has `price: 0` for every one of them. |
| **annual_rent** | `price` (when `deal_type=rent`) | 8/65 objects are rent | **Rent period is still unconfirmed** (annual vs monthly) — flagged as unresolved in the original 2026-09-28 audit too; not re-confirmed this session. Do not assume "annual" without checking a real rent listing's price against a plausible AED/month or AED/year rate. |
| **size_sqft** | `params["Общая площадь ( sqft )"]` (already in sqft, UAE-specific fields) OR `params.area.value` (m², needs conversion) | 62% sqft-native, 95% m²-only fallback | Mixed units depending on which category a listing falls under — must check which param is present before converting, never assume m² universally. |
| **plot_size_sqft** | `params["Площадь участка"]` (`lot-area`) | confirmed present on houses (`"Дома, дачи, коттеджи"`, 5 objects) | Unit is **"сот." (сотка = 100 m²)**, not sqft or m² — needs its own conversion (`1 сотка ≈ 1076.4 sqft`), distinct from the regular area conversion. Not present on apartment-type listings (expected — no plot). |
| **furnishing** | `params["Мебелировка ( Furnishing )"]` | **8%** (5/65) | **Correction to the earlier 2026-09-28 audit**, which stated furnishing "does not exist on this CRM's object model" — that finding was based on Moscow-market objects only. The newer UAE-specific listing categories (`"ОАЭ Квартиры..."`) *do* carry it, just rarely filled in. |
| **view** | `params["Вид из окон ( View )"]` | 20% (13/65) | Free text (`"Бассейн"`, `"Sea / Marina"`, etc.), no fixed enum observed yet. |
| **broker** | `agent.name` | 100% | Direct. |
| **broker_contact** | `agent.phone` / `agent.email` | high (agent-level, not per-listing) | Direct — same agent record shape already used by Moscow's sync. |
| **notes** | *(no direct equivalent)* — `description` | 52% non-empty | Long free text if you want to store it; not structured. |
| **raw_location** | `address` | **100%** | The one genuinely reliable "everything about location" field — full free-text string, always present. Recommended as the honest fallback wherever `area`/`project_community`/`building` can't be confidently parsed out. |

### Summary of what's simply missing (not a mapping problem — the data isn't there)

- **status** — no field exists; must derive from full-pass presence/absence, always.
- **area / project_community / building** as clean structured fields —
  effectively 0% on UAE objects; only recoverable (partially, unreliably)
  by parsing free-text `address`.
- **Rent period** (annual vs monthly) for `annual_rent` — never confirmed for this tenant.

### Summary of what's present but needs real normalization work before use

- `city` spelling (Dubai/Дубай/Абу-Даби).
- `property_type` (three overlapping, none-complete signals — §8).
- `size_sqft` (mixed sqft/m² depending on category — check which param exists first).
- `plot_size_sqft` unit (сот., not sqft/m² — separate conversion).
- `bathrooms`/`furnishing`/`view` (name-keyed params, param key numbers shift per object — always match by `.name`, never by a hardcoded `param_NN` key).

### Known real data defects (not normalization issues — actual bad data)

- 4-way identical-price cluster: object ids **27451, 27452, 27455,
  27460** — four different apartments (different floors/sizes), all
  priced at exactly 779,569,054 AED.
- 3 further duplicate-price groups among the 65 candidates (prices
  6,155,883 / 22,288,545 / 44,577,090 each repeat 2-4 times across
  distinct listings).
- All 22 objects in `"ОАЭ Квартиры в новостройках (off-plan)"` (the
  single-unit subset, not the layouts one) have `price: 0` — e.g. ids
  27606, 27608, 27610, 27611, 27612, 27614-27618 and 13 more.
- 37/102 objects are multi-layout project listings whose own top-level
  `price` must never be read directly (§7).

## 10. Rate limits / webhooks

Still unconfirmed either way — only ever a handful of sequential requests
made in any one session so far, no 429/`Retry-After` observed, but no
real answer either (same open item as the original 2026-09-28 audit).
Treat a full-catalog sync as sequential, not parallel, until this is
tested deliberately. No webhook support documented anywhere — polling
(a scheduled full sync) is the only integration model.
