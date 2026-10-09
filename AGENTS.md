# AGENTS.md — Nika Estate Matching Pilot

> **THIS FILE IS THE PRIMARY INSTRUCTION FOR ANY CODING AGENT.**
> Read this file completely before reading README.md, docs, source code, workflow JSON, or making any changes.
>
> **MANDATORY CURRENT ARCHITECTURE:** read `docs/MARKET_CONTOURS_AND_SOURCE_ROUTING.md` immediately after this file. Its Dubai/RF contour separation and DB/UI source-routing rules override any older pilot text that assumes one universal matcher.

## 0. NON-NEGOTIABLE MARKET-CONTOUR ARCHITECTURE

The matching platform has THREE independent domain contours:

```text
DUBAI MATCHING
RF MATCHING
ABU_DHABI MATCHING
```

(Renamed from "UAE MATCHING" 2026-10-05 — see the `DUBAI` routing-label note
below. `ABU_DHABI` became a real third sibling contour the same day,
2026-10-05 — built BY ANALOGY with Dubai's own matching semantics (same
AED/area-project-building field model, same 50/30/15/5 ranking weights)
but with its own service, schema, and routing label, never folded into
Dubai's. See the Abu Dhabi ADR in `docs/DECISIONS.md` for the full build.)

They may share transport, raw ingress, technical event idempotency, source discovery/catalog, and source routing. They MUST NOT share market-specific matching semantics.

Hard rules:

- The current `dubai-lead-matching-service` is the Dubai contour (renamed from `lead-matching-service`/`UAE`, 2026-10-05).
- RF matching must be a separate service/module (for example `rf-lead-matching-service/`).
- Abu Dhabi matching must be a separate service/module (`abu-dhabi-lead-matching-service/`).
- Do NOT create one universal Dubai+RF+Abu-Dhabi request schema.
- Do NOT put Dubai, RF, and Abu Dhabi stock into one runtime matching table.
- Do NOT share Dubai/RF/Abu-Dhabi interpretation caches.
- Do NOT make RF or Abu Dhabi criteria fit Dubai fields or vice versa — even though Abu Dhabi's field MODEL mirrors Dubai's exactly, its stock/aliases/caches/match tables are their own, never Dubai's.
- Dubai-specific, RF-specific, and Abu-Dhabi-specific units/semantics each stay inside their own contour.
- A Dubai matcher MUST NEVER query RF or Abu Dhabi stock/tables. An RF matcher MUST NEVER query Dubai or Abu Dhabi stock/tables. An Abu Dhabi matcher MUST NEVER query Dubai or RF stock/tables.
- Shared workers remain transport-only and must not contain Dubai/RF/Abu-Dhabi property matching logic.

Target logical DB ownership:

```text
ingest.*            = shared transport/source-control data
matching_dubai.*    = Dubai-only matching data (renamed from matching_uae, 2026-10-05)
matching_moscow.*   = RF-only matching data (city of Moscow strictly — Joker-fed stock, added 2026-09-27, rescoped 2026-09-28)
matching_abu_dhabi.* = Abu-Dhabi-only matching data (real matching logic, added 2026-10-05; stock synced from a dedicated Google Sheet, not Joker — DISTINCT from the Joker-fed `matching_oman`/`matching_saudi`/`matching_turkey` stock-visibility-only schemas below)
matching_oman.*     = Oman-only stock data (Joker-fed, added 2026-09-27; currently no matching logic, stock visibility only)
matching_saudi.*    = Saudi Arabia-only stock data (Joker-fed, added 2026-09-27; currently no matching logic, stock visibility only — DISTINCT from the `SAUDI` source-routing label below, which is a different subsystem)
matching_turkey.*   = Turkey-only stock data (Joker-fed, added 2026-09-27; currently no matching logic, stock visibility only)
```

`matching_moscow`/`matching_oman`/`matching_saudi`/`matching_turkey` today hold **stock visibility only** — real objects synced from Joker CRM (`moscow.nikaestate.ru`), normalized (`src/joker/joker-normalize.js`), browsable at `/stock?market=moscow|oman|saudi|turkey`. None of them have real matching/scoring logic yet (no approved contract for that — see `docs/PER_MARKET_SERVICE_INDEPENDENCE_PLAN.md` §5.2, scoring weights still undecided). Dubai keeps reading its own existing `matching_dubai.stock_inventory` (unchanged); Joker is not (yet) its source.

`matching_moscow` is **strictly scoped to `region === 'Москва'`** (2026-09-28, tightened from an earlier broad catch-all that silently absorbed Санкт-Петербург/Сочи/Казань/Самара, Moscow OBLAST, and even Узбекистан/Грузия objects just because they shared the same Joker tenant — see ADR-035 in `docs/DECISIONS.md`). Objects outside that scope are skipped (`src/joker/joker-market-router.js`'s `classifySkipReason`), never deleted if already synced — a rescope only marks previously-synced out-of-scope rows unavailable.

Source/channel management is DB/UI-driven:

- Telegram and WhatsApp groups available in active sessions must be synchronized into PostgreSQL.
- The existing dashboard/control UI must expose a Sources / Channels management surface.
- Operator can enable/disable monitoring and assign a route. **Multi-route selection (2026-10-06, migration 0041, user request)**: a source's route is now `route_modes`, an array, not a single value — any non-empty combination of the four real labels (`DUBAI`, `RF`, `SAUDI`, `ABU_DHABI`) may be assigned at once (e.g. a source can be `[DUBAI, ABU_DHABI]`), OR exactly one of the two sentinels `AUTO`/`NONE` (never mixed with a real label or with each other). `BOTH` is **retired** as a stored value — it used to be the only way to route to more than one contour, hardcoded to the single pair `[DUBAI, RF]`; any combination is now just an array, so `BOTH` no longer means anything special. Enforced at two independent layers: the DB's own CHECK constraint, and `src/sources/source-repository.js`'s `validateRouteModes` at the application layer.
- `DUBAI` (renamed from `UAE`, 2026-10-05, migration 0034) is the routing label for the Dubai market contour (the current `dubai-lead-matching-service`/`matching_dubai.*`). It was renamed from the old undifferentiated `UAE` label because a second, distinct UAE-country market — Abu Dhabi — was coming: `UAE` could no longer mean one bucket, it had to name the specific city actually served so `ABU_DHABI` could be added as a true sibling label (same pattern `SAUDI` below already established: a label can exist before its own dedicated contour does — though in Abu Dhabi's case the dedicated contour arrived the same day). All 64 sources previously tagged `UAE` were reclassified to `DUBAI` by migration 0034 — a pure rename, not a judgment call, since every one of them was already Dubai traffic.
- `SAUDI` (added 2026-09-27, migration 0024) is a routing LABEL only, exactly like `RF` today — no `saudi-lead-matching-service` exists. A source whose `route_modes` includes `SAUDI` (and no other real label this contour recognizes) is correctly rejected by the Dubai contour (never mis-processed as Dubai stock) and simply waits, tagged, for a future dedicated service. Adding a real Saudi contour (its own `matching_saudi.*` schema and service) is a separate, larger change and must update this file and `docs/MARKET_CONTOURS_AND_SOURCE_ROUTING.md` when it happens, same as DUBAI/RF/ABU_DHABI.
- `ABU_DHABI` (added 2026-10-05, migration 0037) is a real third contour, not a bootstrap-only label like `SAUDI`: `abu-dhabi-lead-matching-service/` (port 8097) is a complete, independently-running matcher with its own `matching_abu_dhabi.*` schema (migration 0036), own AI parser, own deterministic matcher (Dubai's exact field model/ranking weights, ported BY ANALOGY — see ADR in `docs/DECISIONS.md`), own Telegram bot, and its own Google Sheets stock/aliases sync (`scripts/abu-dhabi-sheet-stock-sync-run.js`), not Joker. Zero existing sources were pre-assigned this label at launch (a clean bootstrap, same starting state `SAUDI` had) — an operator assigns it manually via `/sources`.
- Manual route assignment overrides AUTO.
- Do NOT send every source to every contour by default.
- Current env allowlists are migration/bootstrap fallback only, not the long-term control plane.
- Re-syncing worker groups must NEVER erase an operator's monitoring/routing decisions.

Required shared runtime order:

```text
Raw Telegram/WhatsApp event
→ shared technical event idempotency
→ source lookup
→ monitoring_enabled?
→ source route (route_modes, an array)
    includes DUBAI      → Dubai contour also runs, independently
    includes RF         → RF contour also runs, independently
    includes ABU_DHABI  → Abu Dhabi contour also runs, independently
    includes SAUDI      → waits, tagged, for a future dedicated service
    = [AUTO]            → deterministic market router/fallback (defaults to DUBAI)
    = [NONE]            → stop
```

Each contour's own gate checks array membership (`routeModes.includes('DUBAI')`, etc.) — a source routed to `[DUBAI, ABU_DHABI]` is processed independently by both, exactly as `BOTH` used to work for its one hardcoded pair, now generalized to any combination.

Any change that violates these boundaries is forbidden unless the user explicitly changes the architecture and the same commit updates both this file and `docs/MARKET_CONTOURS_AND_SOURCE_ROUTING.md`.

## 1. Project goal

Build the smallest safe production pilot that matches already-filtered Telegram/WhatsApp buyer requests against Nika Estate stock and records/alerts every successful match.

Target flow:

```text
Existing Telegram / WhatsApp monitoring
→ existing filter + dedupe + devi_messages
→ accepted lead
→ AI structured request parser
→ alias normalization
→ PostgreSQL active stock search
→ deterministic scoring
→ PostgreSQL match_runs + match_results
→ EVERY MATCH to Telegram
→ successful matches to Google Sheets Match Log
→ mini dashboard / Metabase over PostgreSQL
```

## 2. ABSOLUTE RULE: DO NOT BREAK PRODUCTION

The existing production monitoring flow is protected.

### Forbidden without explicit user authorization

- deleting, disabling, renaming, rewiring, or replacing existing production nodes;
- changing existing Telegram or WhatsApp listener webhooks;
- changing listener URLs, sessions, accounts, Evolution/Baileys connections, or DEVI routes;
- rotating/changing production credentials inside the workflow;
- changing the behavior of `Universal Filter + Normalize`, `Postgres - Save + Dedupe`, or `Keep Only Accepted New Leads` just to support the pilot;
- activating destructive workflow changes without tests and a rollback artifact;
- destructive SQL (`DROP`, `TRUNCATE`, mass `DELETE`) against production tables.

### Allowed integration pattern

The pilot is additive only:

```text
Keep Only Accepted New Leads
├── existing branches unchanged
└── NEW matching pilot branch / webhook call
```

Prefer creating separate workflows:

1. `NIKA PILOT - Stock Sync`
2. `NIKA PILOT - Matching`

If the existing workflow must be touched, add only one small isolated branch after `Keep Only Accepted New Leads`. Do not modify existing branches.

Default safety flags in `.env` must remain:

```text
N8N_ALLOW_WRITE=false
ALLOW_PRODUCTION_WORKFLOW_MUTATION=false
```

Only create/update n8n workflows when `N8N_ALLOW_WRITE=true`.
Never mutate the existing production workflow unless `ALLOW_PRODUCTION_WORKFLOW_MUTATION=true` is explicitly set by the user.

## 3. Data ownership

- Google Sheets = human editing surface only.
- PostgreSQL = runtime source used by every realtime match.
- Google Sheets must NEVER be queried for stock during processing of a Telegram/WhatsApp request.
- Stock/Aliases sync runs daily and manually on demand.
- Existing `devi_messages` remains the source for original accepted messages.

Pilot runtime tables:

- `stock_inventory`
- `matching_aliases`
- `stock_sync_runs`
- `match_runs`
- `match_results`

Do not duplicate the original lead/message payload into `match_results`; reference the existing DB message ID.

## 4. Pilot stock scope

Operational matching uses only:

```text
status = ACTIVE
```

Default pilot transaction type:

```text
SALE
```

Source mapping when importing the original export:

- `live` → `ACTIVE`
- `pocket` → `ACTIVE`
- `takendown` → do not load into active runtime matching stock
- `takendown_validation_failed` → do not load into active runtime matching stock; mark/review separately if needed

Canonical sale price is always `selling_price`.

## 5. Matching rules

AI does NOT choose a property.

AI is used only to convert accepted free text into structured request JSON.
All matching, normalization, pricing checks, scoring, status decisions, persistence, and alert selection are deterministic code.

Current Dubai structured-request fields:

- transaction_type
- area
- areas
- project
- building
- bedrooms_min
- bedrooms_max
- property_type
- budget_min
- budget_max
- bathrooms_min
- bathrooms_max
- size_sqft_min
- size_sqft_max
- plot_size_sqft_min
- plot_size_sqft_max
- furnishing
- cash_buyer (metadata only; must not change property compatibility score)
- ai_confidence

The active Dubai matcher (`dubai-lead-matching-service`) is **FILTER FIRST, RANK
SECOND**:

- a candidate must pass every active hard filter before it can be ranked;
- a request criterion that was not stated is inactive and excluded from the
  ranking denominator;
- any surviving candidate is `MATCH`;
- zero survivors is `NO_MATCH` (or `INSUFFICIENT_CRITERIA` when the request
  lacks the minimum required specificity);
- the ranking score orders survivors only and never decides match
  eligibility;
- the active matcher does not generate `STRONG_MATCH`.

Current ranking weights:

```text
Location       50
Budget         30
Bedrooms       15
Property Type   5
```

Ranking details:

```text
Location: Building = 100, Project = 95, Area = 80
Budget: at/under maximum = 100, 0-5% over = 75, 5-10% over = 50
Total: round(sum(active weight * component score) / sum(active weight))
```

The 10% price tolerance is a hard-filter ceiling configured by
`MATCH_PRICE_TOLERANCE_PCT`; it applies to `budget_max`, not to
`budget_min`. A price beyond the ceiling is excluded before ranking.

Active hard filters are location, transaction type, property type, budget,
bedrooms, bathrooms, size, plot size, and furnishing when the corresponding
request criterion is stated. Furnishing is **not** a score component. An
explicit furnishing requirement must match exactly; missing furnishing in
stock is unverifiable and blocks that candidate. If the request does not
state furnishing, the furnishing filter is inactive and does not penalize or
block the candidate.

The root `src/core/*` matcher and generated n8n `pilot-v1` workflow are
legacy compatibility paths. They may still contain historical weighted
threshold semantics and `STRONG_MATCH` rows, but they are not the contract
for the active Dubai service and must not be used as its implementation guide.

## 6. CRITICAL TELEGRAM RULE

**EVERY successful match must be sent to Telegram.**

For the active Dubai matcher, successful means:

```text
MATCH
```

Historical `pilot-v1` results may contain `STRONG_MATCH`; when that legacy
path is operated, those rows remain successful for compatibility and must
not be dropped from delivery/reporting.

Do NOT implement “Top 3 only” delivery.
Top matches may be visually ranked, but all successful matches must be represented in Telegram.

If the result cannot fit in one Telegram message:

- split safely into multiple messages;
- preserve Request ID / source message ID in every part;
- preserve ordering by score descending;
- never silently omit lower-ranked successful matches.

`NO_MATCH` is not sent to Telegram.

## 7. NO_MATCH rule

`NO_MATCH` must be persisted in PostgreSQL `match_runs` for debugging.
It is not written to the human Google Sheets Match Log.

Useful reasons include:

- `location_not_found`
- `unresolved_specific_location`
- `no_stock_in_building`
- `no_stock_in_project`
- `no_stock_in_area`
- `partial_location_resolution_no_match`
- `transaction_mismatch`
- `bedrooms_mismatch`
- `property_type_mismatch`
- `over_budget`
- `bathrooms_mismatch`
- `size_mismatch`
- `plot_size_mismatch`
- `furnishing_mismatch`
- `location_unspecified`
- `insufficient_criteria`

Store enough debug information to reproduce why a request did not match.

## 8. Aliases

Aliases are mandatory.

Lookup order:

```text
normalize input
→ exact alias lookup
→ canonical value
→ deterministic matching
```

Do not use fuzzy matching as the primary pilot behavior.
Never silently convert an unresolved alias to a random similar location/building.

Unknown alias should be diagnosable from `match_runs` and later added to the `Aliases` Google Sheet.

## 9. Match persistence and dedupe

One request can match many stock items.
One stock item can match many requests.

`match_results` = one Request ↔ one Stock pair.

Prevent duplicate match rows. Pilot uniqueness:

```text
UNIQUE(source_message_id, stock_id)
```

Reprocessing should UPSERT score/status/debug fields instead of creating duplicate business matches.

Dashboard Match Count must count unique request IDs, not technical reruns.

## 10. n8n workflow rules

**RETIRED 2026-10-02** (user decision, see `docs/DECISIONS.md`): the n8n
matching-pilot workflow tooling (`n8n/`, `scripts/build-workflows.js`,
`scripts/n8n-plan.js`, `scripts/n8n-deploy.js`, and their supporting
`scripts/lib/`/`scripts/templates/` files) was deleted. The legacy "NIKA
PILOT - Matching" workflow was already `active: false` on the real n8n
server at the time; the active matchers are `lead-matching-service`/
`rf-lead-matching-service`, never an n8n Code node. Everything below this
line is kept only as historical record of the rules that applied while
that tooling existed — recoverable in full from git history if ever
needed again.

Treat workflow JSON as code.

- Store generated workflow JSON under `n8n/workflows/`.
- Store Code-node source under `n8n/code/` where practical.
- Keep node names stable and descriptive.
- Secrets MAY be embedded directly in n8n workflow JSON when this is the simplest implementation for this project.
- Credential IDs / `.env` variables may still be used where convenient, but they are not mandatory.
- Before creating/updating a workflow through the n8n API, save the generated JSON locally.
- Every deployment script must support dry-run.
- Never delete workflows through deployment scripts.

## 11. Secrets

Project rule: secrets are allowed inside generated/importable n8n workflow JSON.

This includes API keys, bot tokens, webhook secrets, database credentials, and other integration secrets when embedding them directly makes the workflow easier to deploy or maintain.

`.env` remains supported for deployment scripts and shared configuration, and n8n Credentials may still be used where convenient, but neither is mandatory for runtime workflow secrets.

Do not remove an embedded secret merely because it is embedded. Do not add contract tests that fail solely because a workflow JSON contains secret literals.

## 12. Tests are a release blocker

A change is not complete because “the workflow imports.”
It is complete only when tests pass.

Minimum required test layers:

### Unit tests

- text normalization;
- area aliases;
- building aliases;
- property type aliases;
- studio / bedrooms normalization;
- ranking calculation with weights 50/30/15/5;
- inactive criteria excluded from the weighted average;
- ranking score never changes MATCH eligibility;
- price tolerance bands;
- furnishing hard-filter behavior when stated;
- absent request furnishing leaves the filter inactive;
- active Dubai matcher never generates `STRONG_MATCH`;
- ranking;
- Telegram message chunking;
- all successful matches are included in Telegram output;
- NO_MATCH reason selection;
- match dedupe/upsert logic.

### Integration tests

Against a disposable PostgreSQL database:

- migrations apply cleanly;
- stock sync upsert;
- aliases upsert;
- only ACTIVE stock is queried;
- original source message can be linked;
- MATCH creates `match_runs` + `match_results`;
- NO_MATCH creates `match_runs` and zero `match_results`;
- rerun does not duplicate the same Request ↔ Stock match.

### Contract tests

**RETIRED 2026-10-02 along with section 10's n8n tooling** — there is no
more generated n8n JSON to validate (`tests/contracts/` was removed).
Kept as historical record:

Validate generated n8n JSON:

- required workflows exist;
- workflow JSON may contain embedded secret literals; this must not fail contract tests;
- pilot does not delete/replace protected production nodes;
- matching workflow contains PostgreSQL read, parse, score, match-run save, match-result save, Telegram delivery;
- stock sync contains Sheets read → PostgreSQL upsert;
- all-match Telegram behavior is present;
- required integration credentials/secrets are present either by reference or embedded directly in workflow JSON.

### Smoke test

Use fixtures to run at least:

1. exact building match;
2. area-only match;
3. alias (`P4` → `Peninsula Four`);
4. price 5% above budget;
5. price >10% above budget;
6. explicit furnishing requirement against missing/mismatched stock data;
7. multiple successful stock matches — ALL sent to Telegram payload builder;
8. NO_MATCH persisted only to PostgreSQL;
9. duplicate rerun;
10. stale stock sync warning.

Do not deploy when mandatory tests fail.

## 13. Required commands

The completed project must provide commands equivalent to:

```bash
npm test
npm run test:unit
npm run test:integration
npm run lint
```

(`npm run test:contracts`, `npm run build:workflows`, `npm run n8n:plan`,
`npm run n8n:deploy` were retired 2026-10-02 along with section 10's n8n
tooling — see `docs/DECISIONS.md`.)

## 14. Definition of Done

Pilot is done only when:

- existing monitoring still behaves exactly as before;
- stock and aliases sync from Google Sheets to PostgreSQL;
- realtime matching reads PostgreSQL only;
- AI parser returns validated structured JSON;
- aliases normalize before matching;
- deterministic matcher stores run/results;
- every current `MATCH` reaches Telegram (and legacy `STRONG_MATCH` remains
  deliverable for backward compatibility);
- every successful match goes to Google Sheets Match Log;
- NO_MATCH stays in PostgreSQL for debugging;
- duplicate reruns do not duplicate business matches;
- dashboard can show Match Count per stock and open its matched requests;
- all mandatory tests pass;
- required pilot artifacts and workflows are deployable with the configured credentials/secrets.

## 15. Working behavior for agents

Before editing:

1. Read `AGENTS.md`.
2. Read `docs/MINI_PILOT_SPEC.md`.
3. Read `docs/TESTING.md`.
4. Inspect existing code/workflows before deciding architecture.
5. Run baseline tests.

During work:

- make small reversible changes;
- add/update tests together with behavior;
- do not “clean up” unrelated production logic;
- do not change business rules without updating docs/tests;
- record material architectural decisions in `docs/DECISIONS.md`.

Before declaring completion:

1. run all tests;
2. validate generated n8n JSON and required integration configuration;
3. produce an n8n deployment plan/diff;
4. verify production workflow was not modified unexpectedly;
5. provide exact created/updated workflow IDs and test results.
