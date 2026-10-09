# Nika Estate — Mini Matching Pilot

A safe pilot for matching already-filtered Telegram/WhatsApp buyer requests with Nika Estate stock.

## Read first

Any coding agent must read `AGENTS.md` before doing anything else.

Then read:

1. `docs/MARKET_CONTOURS_AND_SOURCE_ROUTING.md` — **mandatory current architecture; overrides older single-matcher assumptions**
2. `docs/MINI_PILOT_SPEC.md`
3. `docs/TESTING.md`
4. `docs/N8N_DEPLOYMENT.md`

## Mandatory market architecture

Dubai and RF are independent matching contours. Shared Telegram/WhatsApp workers and ingress may feed either contour through DB-backed source routing, but stock, parsers, criteria, aliases, filters, scoring, caches, and match persistence are market-specific.

See `docs/MARKET_CONTOURS_AND_SOURCE_ROUTING.md`.

The long-term monitoring control plane is PostgreSQL + the existing dashboard UI: Telegram/WhatsApp groups are synchronized from active sessions, then an operator configures monitoring and route `DUBAI | RF | SAUDI | BOTH | AUTO | NONE`. Environment allowlists are bootstrap/fallback only.

## Pilot architecture

```text
Google Sheets (Stock Inventory + Aliases)
              ↓ daily/manual sync
PostgreSQL (runtime stock + aliases)
              ↑
Existing accepted Telegram/WhatsApp lead
              ↓
AI structured parser
              ↓
Alias normalization
              ↓
Deterministic matching/scoring
              ↓
PostgreSQL match_runs + match_results
              ↓
EVERY current MATCH → Telegram
              ↓
Successful matches → Google Sheets Match Log
              ↓
Metabase / mini dashboard
```

## AI scope

AI is used only for converting free-text accepted requests to validated structured JSON.
AI does not choose stock, calculate scores, determine availability, or decide which successful matches are suppressed.

## Current Dubai matching semantics

The active runtime is `dubai-lead-matching-service`, not the legacy root/n8n
`pilot-v1` matcher. It applies hard filters first, then uses a ranking-only
score for survivors:

```text
Location 50 / Budget 30 / Bedrooms 15 / Property Type 5
```

Every surviving candidate is `MATCH`; zero survivors is `NO_MATCH` (or
`INSUFFICIENT_CRITERIA` when minimum specificity is missing). There are no
70/85 eligibility thresholds and the active service does not generate
`STRONG_MATCH`. Explicit furnishing is an exact hard filter, not a score
component; if the request omits furnishing, that filter is inactive.

Historical `pilot-v1` data may still contain `STRONG_MATCH` and remains
readable/deliverable for compatibility.

## Data scope

Runtime stock comes from PostgreSQL only.
Google Sheets is the editing surface and is synchronized daily or manually.

Pilot matching defaults to ACTIVE SALE stock.

## Telegram rule

Every current `MATCH` must be sent to Telegram. Historical legacy
`STRONG_MATCH` results remain successful for compatibility.
If there are too many matches for one message, split messages; never omit successful matches.

## Environment

1. Copy/fill `.env` locally.
2. Never commit `.env`.
3. Secrets may be embedded directly in n8n workflow JSON; n8n Credentials remain optional.

## n8n API

Deployment scripts use:

- `N8N_API_URL`
- `N8N_API_KEY`

Keep `N8N_ALLOW_WRITE=false` until a dry-run plan has been reviewed.

## Current source artifacts

The implementation agent should be given separately:

- the current production workflow export;
- the prepared `Stock Inventory` / `Aliases` workbook;
- access to the existing PostgreSQL instance;
- IDs of n8n credentials for PostgreSQL / Google Sheets / OpenAI / Telegram.

The project allows embedded credentials/tokens in workflow JSON. Handle the repository according to the chosen access model.
