# Per-market independent services, one shared dashboard — plan & checklist

**Status:** section 5.1 (RF stock contract, Joker source, normalization) is now IMPLEMENTED (2026-09-27/28) — see migrations `0025`/`0026`, `src/joker/*`, `scripts/joker-stock-sync-run.js`, and `/stock?market=moscow|oman|saudi|turkey`. Moscow's own runtime settings/intake rules/Draft→Apply and V2 intake gate are now IMPLEMENTED too (2026-09-28/29, ADR-036, migrations 0029-0031). Moscow's real domain matching (AI parser, candidate query, hard filters, scoring, `match_results`, Telegram delivery, source-routing gate) is now IMPLEMENTED as of 2026-09-29 (ADR-038, migration 0032) — ported from UAE's own shipped code (not the historical `AGENTS.md` pilot-v1 spec, see ADR-037) and adapted to Moscow's own criteria/settings. The table in section 2 below predates this and is left as historical context; ADR-038 is the current source of truth for what changed. Oman/Saudi/Turkey and this document's section 5.2/scoring-weights framing for THOSE markets remain planning only — stock visibility, no matching/scoring code, per the explicit scope boundary agreed at the time.

**Relationship to existing architecture docs:** this document does not change `AGENTS.md` §0 or `docs/MARKET_CONTOURS_AND_SOURCE_ROUTING.md` — it is fully consistent with both and simply makes one thing explicit that neither spelled out: **the dashboard/control-plane UI is shared across markets, but each market's own configuration (rules, thresholds, Draft→Apply) must stay physically separate, mirroring the existing "shared routing, separate domain logic" rule.** If anything here ever needs to contradict those two files, they win, and both must be updated together per their own change-control rules.

## 1. The target end-state (confirmed intent)

> "нужно сделать на каждый маршрут свой lead-matching-service независимый по настройкам, портам и т.д., но дашборд у них общий, чтоб управлять из одного места"

Restated precisely:

- **Each market/route (UAE, RF, and eventually SAUDI) is its own independent service**: own process, own port, own database schema, own business rules (triage/parser/aliases/hard filters/ranking), own runtime settings and intake rules, own Draft → Apply config versioning, own AI usage if any. None of this is shared or unioned across markets — this is already the hard rule in `AGENTS.md` §0.
- **One shared dashboard process manages all of them.** An operator opens one URL and can see/configure UAE settings, RF settings, (later) Saudi settings, and cross-market concerns (Sources/Channels routing) — without needing to know which physical service or schema backs which page. This is a **UI/control-plane concern only** — the dashboard talks to each market's own config-repository/schema separately, exactly the way `dashboard/settings-queries.js` today only ever re-exports `lead-matching-service`'s own `config-repository.js`; a future `dashboard/rf-settings-queries.js` would re-export `rf-lead-matching-service`'s own (not-yet-built) config-repository the same way, never a shared one.

This is not a new architectural decision — it is the natural consequence of §0's existing rules once you ask "so where does the human who sets thresholds and rules actually click?" The dashboard already does this for Sources/Channels (one shared page manages routing for every market); this plan extends the same shape to each market's own business settings.

## 2. Current status per market

| | **UAE** | **RF** | **SAUDI** |
|---|---|---|---|
| Service | `lead-matching-service/` — real, in production | `rf-lead-matching-service/` — real process, **domain matching NOT_IMPLEMENTED** | **Does not exist.** `SAUDI` is a routing label only (migration 0024) |
| Port | `MATCHER_PORT` (8095) | `RF_MATCHER_PORT` (8096) | — |
| DB schema | `matching_uae.*` (physically renamed from `matching`, migration 0027, 2026-09-28 — resolves the ADR-029 compatibility gap) | `matching_moscow.*` (renamed from `matching_rf`, migration 0018 skeleton + migration 0027 rename, 2026-09-28) — schema + `match_runs` (status ∈ `NOT_IMPLEMENTED/REJECTED/ERROR` only) + interpretation-cache table reserved, both otherwise empty | — |
| Business rules (triage, parser, aliases, hard filters, ranking) | Implemented (this is the whole existing pilot) | **None.** Every event just persists `NOT_IMPLEMENTED` | — |
| Runtime settings / intake rules / Draft→Apply | Implemented (`matching_uae.runtime_settings`, `matching_uae.intake_rules`, `matching_uae.config_draft`, `matching_uae.config_versions` — migrations 0020-0023, exposed at `/settings`) | **None** | — |
| Dashboard settings page | `/settings` (this IS the UAE settings page today, even though the URL doesn't say "uae") | **None** | — |
| Routing (`ingest.source_routes.route_mode`) | `UAE` | `RF` | `SAUDI` (rejected by the UAE contour, correctly, until a real service exists) |

The isolation guarantee that actually matters — "a UAE matcher never touches RF stock/schema and vice versa" — already holds structurally today (confirmed by an automated test in `rf-lead-matching-service/tests/integration/api.integration.test.js`). What's missing is (a) RF's own business rules and (b) a dashboard settings surface for RF once those rules exist. SAUDI is earlier still: it doesn't even have RF's skeleton yet.

## 3. The "independent settings" template (what UAE already has, to be replicated — never shared)

UAE's existing Phase 2 config model (`lead-matching-service/src/repositories/config-repository.js`, migrations 0020-0023) is the reference shape every future market's settings should follow, each in its **own** schema:

- `<schema>.runtime_settings` — key/value toggles and numeric thresholds (dedup, AI cache, buyer-signal thresholds, matching dimension toggles, budget tolerance, gate cutover flag/policy).
- `<schema>.intake_rules` — the rule groups (UAE's are `BLACKLIST`/`WHITELIST`/`PROPERTY_SIGNAL`/`SEND_TO_AI`; an RF equivalent would need its own groups and its own Russian-language patterns — not a reuse of UAE's English/Russian mixed pattern set, since RF's buyer-intent phrasing, spam patterns, and property-detail signals are a different domain problem, not a translation exercise).
- `<schema>.config_draft` — singleton Draft→Apply staging row, same mechanism, own table.
- `<schema>.config_versions` — append-only version history + snapshot + diff, same mechanism, own table.

None of these tables are shared across markets — each market gets its own full set, in its own schema, read/written by its own service's own repository code. The dashboard's job is only to render a settings page per market by calling that market's own repository (never a cross-schema query, never a merged settings row).

## 4. Dashboard UX shape (proposed, not yet built)

- Keep `/settings` as-is for now (it's UAE's page; renaming its URL is a separate, low-value churn that can wait).
- When RF gets real settings, add them as their own page(s) — e.g. `/settings/rf` — backed by a new `dashboard/rf-settings-queries.js` that re-exports RF's own (future) config-repository, exactly mirroring today's `dashboard/settings-queries.js` pattern. A small market switcher/nav (UAE | RF | …) ties them together visually without merging any data model.
- `/sources` (routing) and `/shadow-gate`-style analytics, if RF ever gets an equivalent, follow the same "one URL segment per market, one repository per market" shape.
- This is UI-shell sharing only — same dark theme, same nav, same auth, same Node process/port (8094) — never shared business data.

## 5. Per-market checklist: what must be approved before building real settings/matching

### RF — from `rf-lead-matching-service/README.md`, in order

1. **RF stock contract** — what fields a Joker (or other RF stock source) row actually, reliably provides.
2. **RF request schema + location hierarchy** — округ/район/metro/ЖК/корпус; none of this maps cleanly onto UAE's area/project/building, and must not be forced to.
3. **RF budget/size semantics** — RUB, sqm (not sqft), rooms vs bedrooms (a distinct Russian real-estate concept, not a translation of UAE's "bedrooms").
4. **RF's own triage/parser/aliases/hard-filters/ranking**, each with its own regression fixtures — not reusable 1:1 from UAE.
5. Only then: wire a real source route (`route_mode = 'RF'`/`'BOTH'`) to actually deliver events to the service.

**Decisions made 2026-09-28** (owner: user/RF business lead) — recorded here verbatim as the current answer; still subject to change until actually implemented:

#### 5.1 RF stock source — DECIDED, mechanism built, contract drafted from a live audit

A manually curated Google Sheet, so an operator can visually control exactly what gets exported from Joker CRM before it ever reaches the database — then Sheet → PostgreSQL sync, same shape as the original UAE pilot's Stock Sync (`AGENTS.md` §3: "Google Sheets = human editing surface only; PostgreSQL = runtime source"). This means RF needs its own `matching_moscow.stock_inventory` + a Sheets→`matching_moscow` sync job, structurally the same pattern as UAE's existing sync but a separate table/job — not a shared sync pipeline.

**The Joker CRM tenant (`moscow.nikaestate.ru`) already integrated for `/brokers` turns out to BE the natural RF stock source** — `docs/JOKER_API_DISCOVERY.md` (an earlier session's live audit) confirms this tenant's ~14,880 objects are overwhelmingly Moscow/Sochi/SPb residential listings; the ~220 UAE-tagged objects in the same tenant were flagged there as data-quality-suspect (duplicate prices, zero-price/empty-title rows, inconsistent city tagging) and explicitly **not** recommended for syncing without a conversation with whoever administers Joker. For RF, this tenant looks like real, usable inventory.

**Live audit performed 2026-09-28** against the 21 RF agents the user named as "whose stock to look at": all 21 matched a real `/api/agents` row on the first try (manager_ids `245`–`339`, e.g. Багдасарян Артур→294, Качалова Наталья→276, Калядин Максим→322). Pulling live objects for two of them confirmed the field set is exactly what `JOKER_API_DISCOVERY.md` predicted, plus several fields not seen in that earlier sample (this account is clearly RF-market, not commercial-only):

- Residential `type` taxonomy confirmed: `Квартиры - вторичное жильё` (secondary apartments), `Квартиры в новостройках` (new-build apartments), `Дома, дачи, коттеджи` (houses/dachas/cottages) — plus `Коммерческая недвижимость` (commercial), which should be **excluded** from buyer-matching stock, same principle as UAE's own `is_request`/promotion filtering.
- Cities/areas seen: mostly Moscow + affluent Moscow-region localities (Барвиха, Жуковка, Николина Гора, Одинцово, etc.) plus Сочи, Казань, СПб — confirms this is a premium Moscow-region-weighted portfolio, not a generic all-Russia feed.
- New-build-specific fields confirmed present (absent from the earlier commercial-heavy sample): `ready-quarter`, `building-state`, `building-name`, `IsEuroFlat` (euro-layout), `BedroomsCount` (separate from `rooms`), `AgentBonus - Value`/`AgentBonus - PaymentType` (broker commission fields — internal, not for a buyer-facing sheet).

**Draft RF stock sheet created 2026-09-28**: a new Google Sheet, `RF Stock — Joker CRM (черновик)`, seeded with a header row and two real example rows (object IDs 12740, 12692, both belonging to named agents) pulled live from Joker. Its ID is recorded as `RF_GOOGLE_SHEETS_SPREADSHEET_ID` in `nika-matching-pilot-starter/.env`, parallel to the existing `GOOGLE_SHEETS_SPREADSHEET_ID` (UAE) — two separate spreadsheets, never one shared sheet with a market column, matching this plan's own guardrails (section 6). Draft columns: ID Joker, Ссылка, Агент, ID агента, **Телефон агента, Email агента** (added 2026-09-28 — both come straight off the same Joker object payload's `agent.phone`/`agent.email`, no extra API call needed; same real-PII-in-a-live-operational-tool pattern already established for `/brokers`, not a documentation file), Тип сделки, Тип объекта, Город, Округ/Район, ЖК/Комплекс, Комнаты, Спальни, Площадь (м²), Этаж, Этажей в доме, Цена (руб), Готовность/Год постройки, Планировка, Обновлено в Joker, Включить в матчинг (да/нет), Примечание — the last two columns exist specifically so the human curator (not a sync job) decides what actually becomes live matching stock, per the "visually control what's exported" requirement.

*(Note: this sheet was recreated twice on 2026-09-28 — the Drive connector available in this session can create/replace a whole file but has no in-place cell-edit capability, so adding columns meant publishing a new file and trashing the old one each time; the ID above is the current, correct one. A CSV field-count bug on the first "add phone/email" attempt shifted one example row's columns by one — caught by reading the file back before telling the user it was done, then fixed by recreating it a second time.)*

**Resolved 2026-09-28**: schema built (migrations 0025/0026), sync job built (`src/joker/joker-stock-sync.js`), stock browsable at `/stock?market=moscow|oman|saudi|turkey`. **Still genuinely open**: which of these fields are actually load-bearing for real SCORING (blocked on 5.2's still-undecided weights) — today every field is stored and shown, but nothing matches against them yet.

**Superseded, same day (2026-09-28)**: the "premium Moscow-region-weighted portfolio, not a generic all-Russia feed" framing two paragraphs up undersold how broad the original catch-all actually was in production — a live audit after the first full sync found it also absorbing Узбекистан (Ташкент) and Грузия (Батуми) objects, plus every Moscow OBLAST town, purely because they shared one Joker tenant with real Moscow listings. The user asked to scope strictly to the city of Moscow; `src/joker/joker-market-router.js`'s `resolveMarket()` now requires `region === 'Москва'` exactly, the schema was renamed `matching_rf`→`matching_russia`→`matching_moscow` (ADR-034/ADR-035 in `docs/DECISIONS.md`), and everything outside that scope is skipped (tagged `out_of_moscow_scope`/`no_region` for diagnostics), never silently absorbed. Previously-synced non-Moscow rows are not deleted — the next sync's safe-deactivation marks them unavailable, same as any other stock row that drops out of scope.

#### 5.1.1 Finalized matching criteria from Joker (2026-09-28)

Full catalogue of parameters actually observed across Joker objects (confirmed live against real data, this audit + `JOKER_API_DISCOVERY.md`), grouped by what they are, with the 11 the user selected for pre-enabled matching marked **[ON]**. Everything else exists in the raw payload but stays off by default, same "toggle per criterion, no forced defaults" convention already used for UAE's Matching section (`renderMatchingSection`).

| Group | Field (Joker key) | Status | Notes |
|---|---|---|---|
| Identity/location | `type` (property category) | **[ON] Тип объекта** | 4 residential values + `Коммерческая недвижимость` (excluded from buyer matching), `Земельные участки`, `Гараж` |
| | `city` | **[ON] Город** | |
| | `district` / `microdistrict` | **[ON] Округ/Район** | fallback chain: `district`, else `microdistrict` |
| | `development` / `complex` / `params['building-name']` | **[ON] ЖК/Комплекс** | 3 possible source fields, first non-empty wins |
| Size/layout | `params.rooms` | **[ON] Комнаты** | can be non-numeric: `"Студия"`, `"Свободная планировка"` (confirmed live, e.g. object 27456) |
| | `params.BedroomsCount` | **[ON] Спальни** | UAE-market-only field per `JOKER_API_DISCOVERY.md`; on this RF-heavy account it IS populated (e.g. object 26334: rooms=4, BedroomsCount=3) — keep both, never collapse into one column |
| | `params.area` | **[ON] Площадь (м²)** | free text `"108 м²"`; garages show a broken unit literal `"28 М{2}"` (confirmed live, objects 26730/26747/26950/27001/27060/27434) — parser must tolerate both |
| | `params.floor` | **[ON] Этаж** | |
| | `params['floors-total']` | **[ON] Этажей в доме** | |
| Price | `price` | **[ON] Цена (руб)** | bare numeric string, RUB implied by tenant (no currency field) |
| Readiness | `params['built-year']` / `params['ready-quarter']` | **[ON] Готовность/Год постройки** | **mixed units, confirmed live**: `built-year` is a 4-digit year (`"2008"`) or year+suffix (`"1915 г."`); `ready-quarter` is a **bare small integer** (`"1"`, `"2"`, `"4"` — confirmed on new-build objects 26833/26890/27162/27164) meaning quarter-of-year, NOT a year. Displaying both under one column without a label risks reading `"1"` as a corrupt year — needs a quarter/year split (see normalization below) |
| Not selected, available if wanted later | `params['rooms-type']` (Планировка: Изолированная/Смежная/Свободная), `params.IsEuroFlat`, `params['building-state']`, `params.ParkingType`, `params.IsPenthouse`, `params['window-view']`, `params['ceiling-height']`, `deal_type` (sale/rent) | off | `deal_type` should probably be a hard filter like UAE's transaction_type, not a scored criterion — flagging for the next design pass |
| Never for buyer-facing matching | `agent.*`, `contact.*`, `params['AgentBonus - Value']`, `params['AgentBonus - PaymentType']`, `param_NN` generic/unlabeled fields (`param_18`, `param_49`, `param_57`, `param_129`, `param_138`, etc. — meaning not yet decoded) | excluded | internal/broker-only or unidentified |

#### 5.1.2 Normalization — both sides, with real examples

Per `AGENTS.md` §8's existing alias model (`normalize input → exact alias lookup → canonical value → deterministic matching`, no fuzzy matching as primary behavior): the SAME canonical value must be reachable from (a) a raw Joker stock row and (b) a buyer's free-text request, via one shared alias table per field — never two separate normalizers that can drift apart.

**ЖК/Комплекс** — real values observed in one export: `ЖК «Событие»`, `ЖК Victory Park Residences` (no quotes), `МФК «Neva Towers»`, `Комплекс апартаментов «Поклонная 9»`, a complex name starting with an invisible zero-width space (confirmed byte-for-byte in the raw export), `ЖК «WILL TOWERS» ` (trailing space before the comma). Normalization rule: strip leading zero-width/whitespace chars, strip the generic prefix (`ЖК`, `МФК`, `Комплекс апартаментов`, `Элитный комплекс`), strip guillemets `«»`, trim, lowercase for the lookup key, keep the original (cleaned) string as the display name. A buyer typing "хочу в Событие" or "ЖК Событие" or "жк событие" must all resolve to the same canonical key as the stock row's `ЖК «Событие»`.

**Округ/Район** — observed: `Одинцовский р-н`, `Наро-Фоминский р-н`, `Красногорский р-н`, plain `Одинцово`/`Красногорск` (city, no district), `Хамовники`/`Пресненский`/`Раменки` (Moscow districts with no `р-н` suffix). Normalization rule: strip the `р-н`/`р-он` suffix before lookup so `"Одинцовский р-н"` and a buyer's `"Одинцовский район"` or `"в Одинцово"` land on the same alias entry — this needs a real district/area alias table (analogous to UAE's `matching_uae.matching_aliases` for area/building), not string equality.

**Комнаты (rooms)** — non-numeric values confirmed live: `"Студия"`, `"Свободная планировка"`. Same "studio == 0" convention `JOKER_API_DISCOVERY.md` already recommended for UAE-sourced Joker stock applies here too; `"Свободная планировка"` (open-plan, no fixed room count) needs its own explicit sentinel, not silently coerced to 0 or dropped.

**Площадь (area)** — confirmed formats: `"108 м²"`, `"950 м²"`, and the broken `"28 М{2}"` on garage listings (a real encoding bug in Joker's own data for the `Гараж` category, not something to "fix" upstream — the parser must accept it). Normalization: strip everything after the leading number, parse as float, treat `м²`/`М{2}`/`m2`/`кв.м` as equivalent units.

**Готовность/Год постройки** — do NOT store `built-year` and `ready-quarter` in one free-text column in the real schema (the settings-page label can still say "Готовность/Год постройки" as one human concept, but the underlying data needs two fields: `readiness_year` (nullable int) and `readiness_quarter` (nullable int 1-4), so a bare `"1"` is never misread as a year, and a UI can render "1 кв. 2026" style output.

**Тип объекта** — `Коммерческая недвижимость` excluded from buyer-facing matching entirely (business rule, same principle as UAE's promotion/is_request filtering); `Квартиры - вторичное жильё` / `Квартиры в новостройках` / `Дома, дачи, коттеджи` / `Земельные участки` / `Гараж` each need a short canonical label for both the stock row and a buyer's free-text property-type mention (e.g. "хочу коттедж" / "ищу новостройку").

#### 5.2 RF scoring weights — STILL OPEN

No answer yet ("пока не знаю"). UAE's Location(30)/Bedrooms(25)/Property Type(15)/Budget(20)/Furnishing(10) model cannot be assumed for RF — whether furnishing matters at all for the RF market, and what takes its place (new-build vs secondary? finish level?), is undecided. **This blocks building RF's ranking/scoring code** — everything else in this section can proceed in parallel, but real match scoring cannot ship without this.

#### 5.3 AI parser — DECIDED (conditional)

Decision: if the underlying prompt/logic does not actually need to change based on market/filter criteria, reuse the same parser; if it does, build RF's own. Given that RF's request schema is genuinely different from UAE's (округ/район/ЖК/метро instead of area/building/project; RUB instead of AED; sqm instead of sqft; комнаты as a distinct concept from bedrooms — all confirmed different in `docs/MARKET_CONTOURS_AND_SOURCE_ROUTING.md` §5), the practical conclusion is: **RF needs its own system prompt and its own parsed-request JSON shape** (the output schema itself differs), but this does **not** require a separate AI client/provider/model/retry/caching subsystem — the same underlying AI-call infrastructure (`lead-matching-service`'s AI client pattern) can be reused, parameterized with RF's own prompt text and RF's own output schema/validation. This is analogous to how the same Postgres server hosts both `matching_uae.*` and `matching_moscow.*` without becoming a shared *data* model — the AI *infrastructure* can be shared without the *prompt content* being shared.

#### 5.4 RF intake rules (buyer-intent / spam) — DRAFT CONTENT PROVIDED 2026-09-28

The user provided real candidate phrase lists for two of RF's four rule groups. These are recorded below as a **first draft**, not yet validated against real RF market messages, and not yet seeded into any table — turning this into actual `matching_moscow.intake_rules` rows is a separate implementation step.

**BLACKLIST (Заблокированные сообщения) — decision: reuse UAE's BLACKLIST *concept*, in Russian.**

UAE's BLACKLIST already contains 9 Russian-language phrases (used because UAE buyer messages are themselves often in Russian) — these transfer to RF's own seeded set as-is, same text, same meaning (seller/landlord announcing their own listing, not a buyer request):

```
сдам, сдаю, сдаётся, сдается, продам, продаю, продаётся, продается, от собственника
```

UAE's remaining BLACKLIST rules (broker-solicitation spam: "do you have a client looking to buy", "have a client looking to buy", "send us your client's requirements", "agents are welcome", "buyer-side commission is yours", "do you have a client looking for", a For-Sale/For-Rent header) are English-only and have no RF equivalent yet. **Decision 2026-09-28: exclude anything that could collide with WHITELIST's "broker describing their own client's need" pattern** (`клиенту нужен`/`клиенту нужна`/`есть клиент`/`есть прямой клиент`/etc. — see block below). Concretely, this means dropping the earlier draft phrases built around "чужой покупатель/клиент" (e.g. "пришлите своих клиентов", "ищу покупателя", "нужен покупатель на объект") entirely, rather than trying to word them carefully enough to avoid ambiguity — that sub-category (a broker soliciting *other* agents' clients/buyers for a referral split) needs real observed RF spam examples before it can be safely written, not a guessed translation next to a lexically similar legitimate pattern. What remains is only the zero-ambiguity commission/agent-collaboration spam signal, which has no buyer-intent equivalent at all:

```
агентам рады, работаем с агентами, агентское вознаграждение
комиссия покупателя ваша, агентские 50/50
```

This is intentionally a smaller BLACKLIST draft than first proposed — narrower but safe. The "someone else's buyer/client" spam sub-category can be added later, once real RF broker-spam messages are reviewed for actual wording, per the same "no rule invented, only from observed messages" principle `AGENTS.md` already applies to UAE.

**WHITELIST (Намерение купить) — draft phrase list as provided, preserved verbatim, organized by apparent sub-theme for readability (grouping is my own annotation, not the user's — content is unedited):**

*Broker describing their own client's need:*
```
ищу для клиента, ищем для клиента, клиент ищет, клиенту нужен, клиенту нужна,
клиент рассматривает, есть клиент, есть прямой клиент, прямой клиент, под клиента,
запрос от клиента, есть запрос, нужен объект, нужна квартира, нужна вилла,
нужны варианты, ищу объект, ищу квартиру, ищу виллу, ищу апартаменты,
кто может предложить, у кого есть, скиньте варианты, пришлите варианты,
что есть в наличии, клиент готов смотреть, клиент готов купить, готов на просмотр,
нужен просмотр
```

*Direct buyer intent:*
```
хочу купить, хотим купить, планирую купить, ищу квартиру, ищем квартиру, ищу виллу,
ищу недвижимость, ищу апартаменты, ищем апартаменты, хочу приобрести,
рассматриваю покупку, интересует покупка, готов купить, готовы купить,
что можно купить, что есть в продаже, какие есть варианты, нужен брокер,
нужен риелтор, посоветуйте брокера, посоветуйте риелтора, порекомендуйте брокера,
к кому обратиться по недвижимости
```

*New-build / developer / investment / installment intent:*
```
хочу купить в новостройке, ищу новостройку, рассматриваю новостройку,
интересует новостройка, какие есть новостройки, какие новые проекты,
какой проект выбрать, посоветуйте проект, хочу купить от застройщика,
ищу от застройщика, напрямую от застройщика, рассматриваю покупку от застройщика,
хочу инвестировать в недвижимость, ищу объект для инвестиций,
квартира для инвестиций, что купить для инвестиций, куда инвестировать в недвижимость,
какие проекты для инвестиций, что можно купить с рассрочкой, интересует рассрочка,
нужен график платежей, какие есть варианты с рассрочкой
```

*General comparison / rental-investment / agency questions:*
```
что лучше купить, где лучше купить, где лучше инвестировать, куда лучше инвестировать,
какой район лучше для покупки, какой район лучше для инвестиций, что купить под сдачу,
что купить для аренды, что купить до [сумма], что есть до [сумма],
какие варианты до [сумма], кто занимается недвижимостью, кто может помочь с покупкой,
нужен специалист по недвижимости, посоветуйте агентство,
как продать квартиру, как лучше продать обьект, как продать апартаменты
```

**Deferred 2026-09-28:** the final three phrases ("как продать квартиру/обьект/апартаменты") are seller intent, not buyer intent — flagged, but the decision on whether to keep/drop/reroute them is explicitly postponed ("пока оставь, решим позже"). They stay in the WHITELIST draft above, unchanged, until revisited.

**PROPERTY_SIGNAL (Детали объекта) — DECIDED: empty at launch.** No seeded rules, mirroring how UAE's `SEND_TO_AI` group also ships with 0 rules today (an intentional, already-documented empty-group state, not an oversight).

**SEND_TO_AI (Всегда отправлять в ИИ) — interpreted as also empty at launch** ("всё остальное также" was read as covering this 4th group, since only BLACKLIST/WHITELIST/PROPERTY_SIGNAL were discussed explicitly — confirm or correct if this reading is wrong).

#### 5.5 Runtime settings / thresholds — DECIDED

Reuse UAE's current default *values* for RF's own `matching_moscow.runtime_settings` row set (dedup toggles, `content_dedup_ttl_hours`, `ai_cache_ttl_days`, `budget_tolerance_pct`, `buyer_signal_policy`, etc.) as the starting point, **with one confirmed exception: `property_signal_threshold = 0` for RF, not UAE's `1`.**

Reasoning (confirmed 2026-09-28): UAE's current default of `1` assumes `PROPERTY_SIGNAL` has seeded rules to hit. Since RF's `PROPERTY_SIGNAL` group is decided to be **empty at launch** (5.4), a message can never accumulate a `property_signal` hit count ≥ 1 — a threshold of `1` would mean **every single RF message is rejected forever**, regardless of how obvious the buyer intent is. `property_signal_threshold = 0` is satisfied unconditionally (`count >= 0` is always true), which keeps the `REQUIRE_BOTH`/`REQUIRE_ANY` policy *mechanism* identical to UAE while making it behave as "whitelist signal alone is sufficient" until real `PROPERTY_SIGNAL` rules are eventually written for RF — at which point this threshold should be revisited and likely raised.

### SAUDI — earlier than RF

SAUDI currently has **no service at all**, only a routing label. Before any settings/business-rule work, it needs RF's *skeleton* step first:

1. Stand up `saudi-lead-matching-service/` (own process/port, e.g. `SAUDI_MATCHER_PORT`), own `matching_saudi.*` schema, own interpretation-cache table, own `NOT_IMPLEMENTED` webhook/health endpoints, own isolation test — mirroring exactly what `rf-lead-matching-service/` already did for RF.
2. Update `AGENTS.md` §0 and `docs/MARKET_CONTOURS_AND_SOURCE_ROUTING.md` in the same commit (both already require this for any contour-set change).
3. Then the same RF-style approval checklist above, adapted for the Saudi market (currency, location hierarchy, property vocabulary, etc. — almost certainly closer to UAE's shape than RF's, but must still be verified and approved explicitly, not assumed).

## 6. Explicit non-goals / guardrails (restating existing hard rules, not new ones)

- No shared `runtime_settings`/`intake_rules` table across markets, ever — each market's schema owns its own.
- No "universal" settings UI form that tries to parameterize both UAE and RF fields at once.
- No RF rule authored by translating a UAE rule's regex into Russian — RF rules must come from real RF buyer/spam message examples.
- No production route change (`route_mode = 'RF'`/`'SAUDI'` actually receiving real traffic) until that market's full approval checklist above is signed off, per `AGENTS.md` §2's "do not break production" and the RF README's own explicit "not wired into production traffic" statement.
- The dashboard sharing ports/process/theme across markets is a UI convenience only; it must never become a second path by which one market's data reaches another market's queries.

## 7. Suggested sequencing (for discussion, not decided)

Updated 2026-09-28 to reflect section 5's decisions:

1. ~~Answer the RF open questions in section 5~~ — done for stock source mechanism (5.1), AI parser approach (5.3), BLACKLIST/WHITELIST draft content with the cross-list conflict resolved (5.4), and runtime settings incl. `property_signal_threshold = 0` (5.5). **Still blocking:** RF scoring/ranking weights (5.2) and the exact RF stock contract/columns (5.1). The seller-intent phrases at the end of the WHITELIST draft (5.4) are explicitly deferred, not blocking.
2. Resolve the still-open items in step 1 (needs the RF business owner, not engineering work).
3. Build RF's own `matching_moscow.stock_inventory` + Sheets sync job (5.1), RF's own system prompt + parsed-request schema (5.3), and seed `matching_moscow.intake_rules`/`matching_moscow.runtime_settings`/`matching_moscow.config_draft`/`matching_moscow.config_versions` from section 5.4/5.5's decided content, following the UAE template in section 3. Ranking/scoring code still needs 5.2 answered first.
4. Add `dashboard/rf-settings-queries.js` + an RF settings page, following section 4's shape.
5. Only then consider flipping any real source's `route_mode` to `RF`/`BOTH` in production.
6. SAUDI follows the same sequence, starting from its own skeleton (section 5's SAUDI subsection).

## 8. Next step

This document is deliberately a checklist of open questions, not a build plan — the honest answer to "can we build RF settings now" is "not yet, the business rules aren't approved." Once the RF open questions in section 5 have real answers, this doc should be updated with them and a follow-up implementation plan (and an ADR in `docs/DECISIONS.md`) can be written against a concrete, approved RF contract.
