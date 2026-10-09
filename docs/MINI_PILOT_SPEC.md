# Mini Pilot Specification

> **Current-runtime note (2026-09-29):** the active Dubai matcher is
> `dubai-lead-matching-service`. It uses hard-filter eligibility followed by a
> ranking-only score and produces `MATCH`/`NO_MATCH` (plus pipeline outcomes
> such as `REJECTED`, `DUPLICATE`, `PARSER_ERROR`, and
> `INSUFFICIENT_CRITERIA`). The root `src/core/*` matcher and generated n8n
> `pilot-v1` workflow are legacy compatibility artifacts; their historical
> thresholds and `STRONG_MATCH` status do not describe the active service.

## Scope

Create a minimal matching system on top of the existing Nika Estate monitoring flow.

### Existing system is preserved

The current listeners, filters, dedupe, existing notifications, and logging stay unchanged.
Matching starts only after an already accepted, non-duplicate lead.

## Inputs

### Existing accepted lead

At minimum matching must preserve/access:

- existing DB record/message ID;
- provider;
- source URL;
- group name;
- author name/contact metadata;
- original text;
- posted_at.

### Google Sheets source data

Sheet `Stock Inventory` is human-managed stock.
Sheet `Aliases` is human-managed normalization data.
Sheet `Match Log` is human-readable successful-match history.

Google Sheets is not part of realtime matching.

## Runtime PostgreSQL tables

### `stock_inventory`

Recommended fields:

- `stock_id` text primary/unique key
- `status`
- `transaction_type`
- `city`
- `area`
- `project_community`
- `building`
- `bedrooms`
- `bedrooms_label`
- `bathrooms`
- `property_type`
- `selling_price`
- `annual_rent`
- `size_sqft`
- `plot_size_sqft`
- `furnishing`
- `view`
- `broker`
- `broker_contact`
- `telegram_post`
- `whatsapp_post`
- `notes`
- `source_updated_at`
- `synced_at`

Realtime pilot search defaults to:

```sql
status = 'ACTIVE'
AND transaction_type = 'SALE'
```

### `matching_aliases`

- `type`
- `alias`
- `alias_normalized`
- `canonical`
- `canonical_normalized`
- `parent_area`
- `enabled`
- `synced_at`

Unique: `(type, alias_normalized)`.

### `stock_sync_runs`

- id
- started_at
- completed_at
- status
- stock_rows_read
- stock_rows_active
- alias_rows_read
- error

### `match_runs`

One row = one attempt to match one accepted source message.

- id
- source_message_id
- result_status (active service: `MATCH|NO_MATCH|REJECTED|DUPLICATE|PARSER_ERROR|INSUFFICIENT_CRITERIA|ERROR`; the database also accepts historical legacy `STRONG_MATCH` rows)
- parsed_request jsonb
- normalized_request jsonb
- stock_synced_at
- active_stock_count
- candidates_count
- matches_count
- best_score
- no_match_reason
- parser_version
- matcher_version
- created_at

### `match_results`

One row = one Request ↔ Stock business match.

- id
- match_run_id
- source_message_id
- stock_id
- match_score
- match_status
- match_rank
- location_score
- bedrooms_score
- property_type_score
- budget_score
- furnishing_score
- score_breakdown jsonb
- created_at
- updated_at

Unique pilot business key:

```text
(source_message_id, stock_id)
```

## Sync workflow

Workflow: `NIKA PILOT - Stock Sync`

```text
Schedule Trigger (daily)
OR Manual/Webhook Trigger
→ Google Sheets Stock Inventory
→ validate + normalize
→ PostgreSQL UPSERT active stock
→ Google Sheets Aliases
→ validate + normalize
→ PostgreSQL UPSERT aliases
→ stock_sync_runs
```

Sync must make removed/inactive source rows unavailable to matching. Implement safely by status reconciliation/upsert; do not use destructive truncation of unrelated tables.

## Matching workflow

Workflow: `NIKA PILOT - Matching`

```text
accepted lead
→ AI structured parser
→ validate parser JSON
→ exact alias normalization
→ load ACTIVE SALE stock from PostgreSQL
→ deterministic score all viable candidates
→ persist match_run
→ upsert all successful match_results
→ if any successful match:
     build Telegram messages containing ALL successful matches
     send Telegram
     append each successful match to Google Sheets Match Log
→ if NO_MATCH:
     finish after PostgreSQL logging
```

## AI parser schema

Target JSON. Four independent classification labels (ADR-017 — replaced
the single `is_request` boolean, mirroring Devi's AI Leads Filter
category shape: buyingIntent/seekInfo/promotion/spam) plus the extraction
fields, populated only when `buying_intent` is true:

```json
{
  "buying_intent": true,
  "seeking_info": false,
  "promotion": false,
  "spam": false,
  "transaction_type": "SALE",
  "area": "Business Bay",
  "building": "P4",
  "bedrooms": 2,
  "property_type": "Apartment",
  "budget_min": null,
  "budget_max": 2500000,
  "furnishing": "Furnished",
  "cash_buyer": true,
  "confidence": 0.94
}
```

Unknown values should be null rather than invented.

## Alias behavior

Normalize value, then exact lookup in `matching_aliases`.
If alias is missing, retain raw parsed value and mark diagnostic state. Do not fuzzy-map silently.

## Eligibility and ranking

The active Dubai matcher applies every stated criterion as a hard eligibility
filter before ranking. A candidate that fails one active filter is excluded;
score cannot rescue it. Every survivor is a `MATCH`; when no candidate
survives the result is `NO_MATCH`. There is no active score threshold and
the service does not generate `STRONG_MATCH`.

Current ranking weights:

```text
Location       50
Budget         30
Bedrooms       15
Property Type   5
```

Only criteria stated in the request participate in the denominator:

```text
total = round(sum(active weight × component score) / sum(active weight))
```

Component scores:

```text
Location: building 100, project 95, area 80
Budget: at/under maximum 100, 0-5% over 75, 5-10% over 50
Bedrooms/property type: 100 after their hard filter has passed
```

Budget tolerance defaults to 10% (`MATCH_PRICE_TOLERANCE_PCT`). It is a
hard-filter ceiling on `budget_max`; prices beyond the ceiling are excluded
before ranking. `budget_min` remains a strict floor without tolerance.

When the request explicitly states furnishing, stock must have the exact
same furnishing value. Missing stock furnishing is unverifiable and blocks
the candidate. When the request omits furnishing, that filter is inactive.
Furnishing is not part of the ranking score.

Historical `pilot-v1` compatibility only:

```text
The legacy root/n8n matcher used 30/25/15/20/10 weights and 70/85
MATCH/STRONG_MATCH thresholds. Do not use those values when changing the
active Dubai service.
```

## Telegram behavior

Send every successful `MATCH` from the active service. Historical
`STRONG_MATCH` rows from `pilot-v1` remain successful for backward-compatible
reporting/delivery.
Sort by score descending.
Do not cap at Top 3.
If payload exceeds Telegram length, chunk without dropping results.

Notification includes:

- source/request ID;
- original request;
- parsed/normalized key criteria;
- count of successful matches;
- each stock ID;
- building / area;
- bedrooms / property type;
- selling price;
- score and status;
- broker/contact when available;
- stock link when available;
- original message link when available;
- dashboard/open-matches link when available.

## Google Sheets Match Log

Write only successful matches.
One row per Request ↔ Stock result.
Do not write NO_MATCH.

## Dashboard

Pilot can use Metabase over PostgreSQL.

Required views:

### Summary
- Active Stock
- Requests Processed
- Requests with Matches
- NO_MATCH Requests
- Total Matches
- Legacy Strong Matches (historical `pilot-v1` only; the active service does not generate them)
- Unique Stock with Matches
- Average Matches per Request

### Stock view
- Stock ID
- Area
- Building
- Bedrooms
- Type
- Selling Price
- Match Count
- Legacy Strong Match Count
- Latest Match

Click/filter into all matched requests for a stock item.

### Request view
- original request
- parsed request
- normalized request
- number of matches
- all matched stock ordered by score

### Match history
Filter by date, area, building, bedrooms, score/status, stock, provider.

## Pilot exclusions

Do not implement now:

- replacement of existing listeners;
- full raw-message storage before primary filter;
- Stock → historical Requests second contour;
- AI qualifier/outreach;
- fuzzy/vector matching;
- full admin platform;
- stock publication manager;
- conversation state;
- contact CRM layer.
