# Nika Lead Matching V2 — historical refactor plan

> **STATUS: HISTORICAL PLAN / NOT THE CURRENT PROJECT CONTRACT**
>
> The current contract is the root `AGENTS.md`; the active runtime behavior
> is documented in `dubai-lead-matching-service/README.md`.
>
> Some target phases below were not adopted literally. In particular, the
> active service currently uses hard-filter eligibility (including stated
> bathrooms/size/plot/furnishing), ranking weights 50/30/15/5, and
> `MATCH`/`NO_MATCH` without a `STRONG_MATCH` threshold. Treat phase text
> that proposes removing those filters as historical intent, not current
> behavior or authorization to change it.
>
> This file remains useful for rationale and implementation history, but it
> must not override the root contract or verified code.

---

# 1. Current project objective

The current goal is NOT to expand the system.

The goal is to simplify the Nika Estate UAE lead-to-stock matching product into the smallest reliable, explainable, configurable production pipeline.

The product must:

1. receive Telegram/WhatsApp messages;
2. avoid duplicate processing;
3. reject obvious irrelevant/seller/advertising traffic cheaply;
4. identify buyer candidates using editable deterministic rules;
5. spend LLM tokens only on messages that passed the buyer-candidate gate or an explicit AI-review rule;
6. use one LLM call for classification + structured extraction;
7. normalize the request;
8. deterministically match against ACTIVE UAE stock in PostgreSQL;
9. persist the result;
10. expose a live funnel, rule analytics and AI cost in the dashboard.

---

# 2. Current source of truth

Repository:

```text
Miko0085/ai-broker-agent
```

Current simplification base:

```text
branch:
feature/matching-contours-source-control-fixes

commit:
40acb80fce87b1ae9ea72b2297f1a8ece685c158
```

All simplification work must happen on a dedicated feature branch.

Do not modify `main` unless the user explicitly authorizes it.

---

# 3. Active vs legacy components

## Active UAE matcher

```text
dubai-lead-matching-service/
```

This is the only matcher that should evolve during this refactor.

## Legacy matching

Treat the following as legacy/history/rollback:

```text
root src/core/matcher.js
root n8n matching-pilot workflow/templates
matcher_version = pilot-v1
old weighted scoring semantics
STRONG_MATCH business semantics
```

Do not add new business logic to legacy code.

Do not destructively delete it before V2 production stability is verified.

Historical rows do not need semantic migration. They may remain readable as legacy.

---

# 4. RF contour

The architectural rule that UAE and RF are separate contours remains valid.

However, RF business matching is frozen during this refactor.

The agent MUST NOT implement:

- RF matching business rules;
- RUB-specific matching;
- sqm/ЖК/metro semantics;
- RF parser logic;
- AUTO routing business behavior;
- BOTH routing business behavior.

The current RF skeleton may remain.

Operational V2 work should focus on:

```text
UAE
NONE
```

---

# 5. Simplified target pipeline

```text
Raw Telegram/WhatsApp event
        ↓
Source enabled?
        ↓
Event dedup
        ↓
Content hash / interpretation cache
        ↓
Blacklist
        ↓
Whitelist + Property Signal gate
        ↓
REJECT without AI
or
SEND_TO_AI
        ↓
AI cache
        ↓
ONE LLM classification + parsing call if cache miss
        ↓
Confirmed sender-owned buyer request?
        ↓
Normalization
        ↓
Minimum matching specificity
        ↓
ONE PostgreSQL candidate query
        ↓
0 candidates → NO_MATCH
1+ candidates → MATCH
        ↓
Persistence
        ↓
Notification
```

---

# 6. AI cost rule

This rule is mandatory:

> **Unknown traffic must not automatically go to the LLM.**

Forbidden default logic:

```text
not clearly rejected → AI
unknown → AI
all unmatched deterministic cases → AI
```

The deterministic gate decides whether a message is worth an AI call.

The target is not a specific AI-call percentage hardcoded in code. The target is to reduce unnecessary calls while preserving genuine buyer requests, and to make the rate observable in the dashboard.

---

# 7. Configurable intake rules

Editable rules must live in PostgreSQL, not in hardcoded JS arrays.

Required rule groups:

```text
BLACKLIST
WHITELIST
PROPERTY_SIGNAL
SEND_TO_AI
```

Initial rule types:

```text
PHRASE
REGEX
```

Do not create a complex DSL unless explicitly approved.

## Blacklist

Used for strong negative evidence such as obvious seller listings, advertisements or irrelevant content.

## Whitelist

Used for buyer-demand language such as:

```text
looking for
need
required
seeking
WTB
ищу
нужен
клиент ищет
```

Examples are seed data, not immutable code rules.

## Property signal

Evidence that the message is a real-estate requirement, such as bedroom/property/budget/location patterns.

## Explicit SEND_TO_AI

A configurable exception for cases the operator intentionally wants the model to review.

---

# 8. Buyer candidate algorithm

Default V2 deterministic decision:

```text
IF blacklist hit
    AND conflict policy != SEND_TO_AI
        → REJECT

ELSE IF explicit SEND_TO_AI rule hit
        → SEND_TO_AI

ELSE IF whitelist_hits >= configured minimum
     AND property_signal_hits >= configured minimum
        → SEND_TO_AI

ELSE
        → REJECT
```

Blacklist/whitelist/property-signal lists and thresholds must be editable from the UI.

Do not reintroduce a large hardcoded NLP engine.

---

# 9. Deduplication

Deduplication has two independent purposes.

## 9.1 Event idempotency

Exact transport-event duplicate protection.

Use provider/account/chat/message identity.

The existing lease/retry-safe claim model is valuable and should be preserved.

Dashboard setting:

```text
event_dedup_enabled
```

## 9.2 Content interpretation reuse

Repeated normalized text may reuse a previous AI interpretation for a TTL.

Dashboard settings:

```text
content_dedup_enabled
content_dedup_ttl
ai_cache_enabled
ai_cache_ttl
```

Do not treat content duplication as permanent global suppression.

---

# 10. AI interpretation

The LLM is used for:

1. message classification;
2. demand ownership;
3. structured request extraction.

These happen in ONE model call.

Do not split classification and parsing into two paid calls.

Runtime interpretation sources after simplification:

```text
AI
CACHE
```

The current local structured parser must be removed from the production decision path.

A local parser may remain temporarily only for legacy/regression purposes.

---

# 11. AI observability

Every logical request and physical model attempt must be observable.

Required fields where available:

```text
source_message_id
matcher_version
ruleset_version
model
attempt_number
duration
HTTP/outcome
prompt/input tokens
completion/output tokens
total tokens
estimated cost
```

Dashboard metrics:

```text
raw messages
AI candidate messages
AI logical calls
AI physical attempts
cache hits
input tokens
output tokens
total tokens
estimated cost
AI rate over raw messages
AI rate over non-duplicate messages
cost per 1,000 raw messages
```

Retry costs must not be invisible.

---

# 12. Matching contract

Only five dimensions may affect automatic V2 stock eligibility.

## 12.1 Location

Mandatory.

Cannot be disabled.

Use the most specific named location:

```text
building
else project
else areas[]
```

Multiple areas are OR conditions.

Never silently broaden an unresolved specific building/project to a wider area.

## 12.2 Transaction type

Configurable enabled/disabled criterion.

Semantics:

```text
SALE → stock transaction_type SALE → selling_price
RENT → stock transaction_type RENT_YEARLY → annual_rent
```

Keep transaction mapping in one shared implementation.

## 12.3 Bedrooms

Configurable enabled/disabled criterion.

Use exact/range semantics when stated.

## 12.4 Property type

Configurable enabled/disabled criterion.

Use normalized exact compatibility.

## 12.5 Budget

Configurable enabled/disabled criterion.

Upper bound:

```text
price <= budget_max * (1 + tolerance_pct / 100)
```

Lower bound, when stated:

```text
price >= budget_min
```

Budget tolerance must be configurable from the UI.

---

# 13. Metadata-only request fields

These may still be extracted and displayed to the broker but MUST NOT block an automatic V2 match:

```text
bathrooms
size
plot size
furnishing
view
cash buyer
mortgage
confidence
```

Do not promote one of these fields to a hard filter without explicit product approval.

---

# 14. Minimum specificity

Location is required.

In addition, a request must contain at least one useful matching signal from the enabled criteria set, normally:

```text
bedrooms
property_type
budget
```

The implementation must prevent area-only or budget-only broad matching from exploding across stock.

If insufficient:

```text
status = NO_MATCH
reason = insufficient_criteria
```

---

# 15. No weighted matching score

The V2 business rule is:

```text
candidate survives deterministic compatibility query
→ MATCH
```

Weighted score does NOT decide whether a candidate matches.

Do not generate `STRONG_MATCH` in V2.

If a temporary legacy DB column requires a numeric score, use a documented compatibility value and do not expose it as a meaningful V2 score.

Ranking, if required for display, must be a simple deterministic presentation sort, not an eligibility algorithm.

---

# 16. PostgreSQL filtering source of truth

The final V2 candidate eligibility query lives in PostgreSQL.

Do not maintain two complete parallel compatibility implementations:

```text
SQL filters
AND
the same full JS hard filters again
```

Before removing JS defense-in-depth, add/strengthen integration tests to prove SQL behavior.

The SQL matcher must cover:

```text
ACTIVE
location
transaction when enabled/stated
bedrooms when enabled/stated
property type when enabled/stated
budget when enabled/stated
```

---

# 17. V2 statuses

The active V2 writer produces only:

```text
MATCH
NO_MATCH
REJECTED
DUPLICATE
ERROR
```

Reasons are separate.

Examples:

```text
insufficient_criteria
not_buyer_candidate
not_buyer_request
advertisement
spam
location_not_found
no_stock_in_location
transaction_mismatch
bedrooms_mismatch
property_type_mismatch
over_budget
parser_error
```

Historical statuses remain readable.

Do not destructively narrow old database constraints during the initial rollout.

---

# 18. Dashboard V2

Use the existing dashboard/control plane.

Do not build a new admin application.

Required top-level pages:

```text
Summary
Requests
Stock
Sources
Settings
```

## Summary = pipeline funnel

Show the count at every stage:

```text
Raw
Event duplicates
Content/cache reuse
Blacklist rejected
Buyer candidates
Sent to AI
AI cache hits
AI confirmed buyers
Match eligible
MATCH
NO_MATCH
```

Also show AI tokens and cost.

Every stage must support drill-down.

## Settings

Render in pipeline order:

```text
1 Sources & Intake
2 Deduplication
3 Blacklist
4 Whitelist
5 Property Signals
6 Buyer Candidate Gate
7 AI
8 Matching
9 Configuration History
```

---

# 19. Rules UI requirements

For blacklist/whitelist/property signals:

```text
enabled
pattern/phrase
type
priority
description
hits 24h
hits 7d
hits 30d
```

User can:

- add;
- edit;
- enable/disable;
- delete.

The UI must make it obvious what is allowed and what is blocked.

---

# 20. Matching settings UI

Expose:

```text
Location        REQUIRED / LOCKED

Transaction     ON/OFF
Bedrooms        ON/OFF
Property Type   ON/OFF
Budget          ON/OFF

Budget tolerance %
```

Show metadata-only fields separately.

Do not allow arbitrary metadata fields to become matching criteria through a generic toggle.

---

# 21. Configuration versioning

All active matching/intake configuration must be versioned.

Every Apply creates a durable snapshot.

UI supports:

```text
view version
compare
rollback
```

Runtime decisions should be attributable to the active ruleset/config version.

---

# 22. Rule preview

Before Apply, support deterministic replay against recent stored messages.

It must NOT make new AI calls.

Show:

```text
current deterministic decision
proposed deterministic decision
projected AI candidates
projected rejection count
disagreement count
sample disagreements
```

---

# 23. Test Message simulator

Settings must include a message simulator.

Default execution is pre-AI only:

```text
blacklist hits
whitelist hits
property signals
buyer-gate decision
```

AI only runs if the user explicitly clicks an AI test action.

After explicit AI test, show:

```text
classification
parsed request
normalized request
candidate query/result
```

---

# 24. Legacy data

Historical data is not a release blocker.

Do not rewrite historical rows into V2 semantics.

Default dashboard V2 views must isolate current V2 matcher/version from legacy.

Legacy may have its own view/filter.

---

# 25. Broker/Joker/extra notification infrastructure

Broker routing, Joker CRM adapter, advanced broker notification routing and similar infrastructure are outside this simplification scope unless directly required to preserve current production match delivery.

Do not expand them during V2 matching work.

Matching answers:

```text
request → matching stock
```

Routing/CRM are separate responsibilities.

---

# 26. Required implementation phases

Agents must implement in this order.

## PHASE 0 — Baseline and characterization

Goal:
- establish verified starting point;
- no runtime changes.

Work:
- verify branch/SHA;
- run root and service tests;
- create `docs/MATCHING_V2_REFACTOR_BASELINE.md`;
- inventory active/legacy files;
- create/expand real-message regression corpus;
- record current funnel/AI metrics.

Acceptance:
- tests pass;
- no behavior changes.

STOP for review.

---

## PHASE 1 — Configuration database

Goal:
- store editable V2 settings/rules without changing runtime behavior.

Additive DB structures:
- runtime settings;
- intake rules;
- config versions/snapshots.

Acceptance:
- migrations idempotent;
- old runtime ignores them;
- tests pass.

---

## PHASE 2 — Settings UI

Goal:
- edit configuration through existing dashboard.

Build:
- Settings page;
- Dedup;
- Blacklist;
- Whitelist;
- Property Signals;
- Buyer Gate;
- AI;
- Matching;
- Config History.

Acceptance:
- settings can be CRUDed;
- versions/rollback work;
- production matching decision unchanged.

STOP for review.

---

## PHASE 3 — New intake gate in shadow mode

Goal:
- evaluate proposed deterministic V2 gate without controlling production decisions.

Persist/measure:
- old decision;
- new decision;
- matched rules;
- ruleset version;
- projected AI call decision.

Dashboard:
- current AI count;
- V2 projected AI count;
- disagreement list.

Acceptance:
- sample disagreements manually reviewable;
- no runtime outcome changed.

STOP for human validation.

---

## PHASE 4 — Intake cutover

Goal:
- V2 configurable gate becomes source of truth for AI eligibility.

Requirements:
- rollback switch/path;
- unknown traffic does not automatically go to AI.

Acceptance:
- buyer regression corpus preserved;
- AI rate materially evaluated;
- errors monitored.

---

## PHASE 5 — Remove local structured parser from runtime

Goal:
- only AI and cached AI interpretations remain.

Acceptance:
- no production path uses local structured parsing;
- existing behavior covered by tests.

---

## PHASE 6 — AI cost/attempt telemetry

Goal:
- make physical model usage measurable.

Requirements:
- retries visible;
- token/cost metrics;
- dashboard AI funnel.

Acceptance:
- can compute cost per 1,000 raw messages.

STOP and evaluate economics before matcher simplification.

---

## PHASE 7 — Structured request cleanup

Goal:
- clearly separate match fields from metadata.

No destructive data migration required.

---

## PHASE 8 — Five-rule matcher

Goal:
- remove bathrooms/size/plot/furnishing from admissibility;
- retain only location/transaction/bedrooms/property type/budget.

Acceptance:
- explicit integration fixtures pass.

---

## PHASE 9 — SQL as eligibility source of truth

Goal:
- remove redundant full JS re-filter after SQL.

Before removal:
- SQL integration tests must prove parity for approved semantics.

---

## PHASE 10 — Remove weighted score semantics

Goal:
- survivor = MATCH;
- stop generating STRONG_MATCH.

Do not destructively drop old DB score columns yet.

Acceptance:
- V2 dashboard does not present compatibility score as meaningful.

---

## PHASE 11 — Runtime diagnostic simplification

Goal:
- simple `reason/no_match_reason`;
- full diagnostic CLI may remain separately.

Remove expensive diagnostics from normal request path unless specifically enabled.

---

## PHASE 12 — Active status simplification

Goal:
- V2 writer outputs:
  - MATCH
  - NO_MATCH
  - REJECTED
  - DUPLICATE
  - ERROR

Map parser errors and insufficient criteria to status + reason.

---

## PHASE 13 — Dashboard Funnel V2

Goal:
- full live pipeline visibility;
- legacy excluded by default.

Acceptance:
- every stage drillable.

---

## PHASE 14 — Rule analytics

Goal:
- evaluate quality of each configurable signal.

Metrics:
- hits;
- reject count;
- sent-to-AI count;
- AI-confirmed buyer count/rate.

---

## PHASE 15 — Test Message simulator

Goal:
- tune rules without deployment.

Default:
- no AI cost.

AI:
- explicit user action only.

---

## PHASE 16 — Config preview

Goal:
- estimate deterministic traffic impact before activating a ruleset.

No fresh AI calls.

---

## PHASE 17 — Legacy isolation

Goal:
- after V2 production verification, stop old pilot from creating new business match rows.

Keep rollback/history.

---

## PHASE 18 — Cleanup

Only after stability:
- reorganize legacy code/docs;
- remove dead runtime references;
- separately propose any destructive DB cleanup.

---

# 27. Phase execution format

Before touching a phase, agent must post:

```text
PHASE
OBJECTIVE
CURRENT CODE PATH
FILES TO READ
FILES TO CHANGE
MIGRATIONS
TESTS
RISK
ROLLBACK
ACCEPTANCE
```

Do not silently start the next phase.

After completing a phase, post:

```text
SUMMARY
FILES CHANGED
DB CHANGES
TEST RESULTS
BEFORE/AFTER BEHAVIOR
METRICS
KNOWN LIMITATIONS
ROLLBACK
NEXT PHASE PROPOSAL
```

---

# 28. Testing policy

Tests are a release blocker.

At minimum preserve/add tests for:

```text
event duplicate
event retry after failure
content cache
blacklist
whitelist
blacklist+whitelist conflict
property-signal threshold
unknown message rejected without AI
AI cache
AI buyer classification path
AI non-buyer classification path
SALE
RENT
building
project
single area
multi-area OR
unresolved specific location
bedrooms
property type
budget
budget tolerance
disabled criteria
metadata-only fields not blocking
insufficient criteria
MATCH persistence
NO_MATCH persistence
duplicate rerun
Telegram successful-match rendering
```

No live OpenAI call in default tests.

---

# 29. Migration policy

Migrations must be additive during the refactor.

Forbidden without explicit authorization:

```text
DROP production tables
TRUNCATE
mass DELETE
destructive rewrite of historical rows
narrowing constraints that breaks legacy data
```

Schema cleanup happens later in a separate approved migration.

---

# 30. Stop conditions

Stop and ask/report if:

- repository state differs from expected base materially;
- a phase requires a new matching criterion;
- a phase requires destructive SQL;
- a change would modify `main`;
- buyer regression quality falls materially;
- projected/real AI traffic increases unexpectedly;
- RF business logic becomes required;
- tests fail;
- existing production behavior cannot be preserved or rolled back;
- an assumption is not supported by code/data.

Do not improvise a new architecture.

---

# 31. Final Definition of Done

The simplification is complete when:

- one active UAE matcher exists;
- legacy does not create new business matches;
- intake rules are DB/UI configurable;
- blacklist/whitelist/property signals are editable;
- dedup controls are visible;
- config is versioned and rollbackable;
- unknown traffic does not automatically reach AI;
- local structured parser is absent from runtime;
- one LLM call classifies + extracts;
- AI cache works;
- retries/tokens/cost are measurable;
- only location/transaction/bedrooms/property type/budget affect eligibility;
- location is mandatory;
- metadata does not block matching;
- weighted score does not determine matches;
- V2 generates no STRONG_MATCH;
- PostgreSQL query decides candidate compatibility;
- active statuses are simplified;
- dashboard shows a complete drillable funnel;
- config preview works without new AI calls;
- Test Message works;
- RF remains frozen;
- all mandatory tests pass.
