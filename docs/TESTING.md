# Testing Requirements

Testing is mandatory and blocks deployment.

## Strategy

Keep matching logic as pure deterministic functions whenever possible so it can be unit-tested outside n8n.
The n8n Code nodes should be generated from or stay mechanically consistent with tested source code.

## Required test groups

### 1. Normalization

Test:

- lowercase / trim / repeated whitespace;
- dots, dashes, underscores where applicable;
- `BB` → `Business Bay`;
- `M.J.L` → `Madinat Jumeirah Living`;
- `P4` → `Peninsula Four`;
- property type `Flat` → `Apartment`;
- unresolved alias remains unresolved and diagnosable.

### 2. Request parser validation

Mock AI output. Do not depend on a live OpenAI call in mandatory unit tests.

Test:

- valid structured request;
- missing optional fields;
- malformed number;
- hallucinated unsupported enum rejected by validator;
- nulls accepted where appropriate.

Optional live OpenAI contract tests may exist behind `RUN_LIVE_AI_TESTS=true`.

### 3. Hard-filter eligibility and ranking

Test the active Dubai matcher (`dubai-lead-matching-service`) in two distinct stages:

- hard filters decide whether a candidate is admissible;
- ranking score orders only candidates that already survived;
- every survivor is `MATCH`, regardless of its numeric ranking score;
- zero survivors is `NO_MATCH`;
- the active matcher never generates `STRONG_MATCH`.

Test exact ranking totals using the current weights:

```text
Location 50 / Budget 30 / Bedrooms 15 / Property Type 5
```

Only active (request-stated) criteria belong in the weighted-average
denominator. Cover location component values (building 100, project 95,
area 80), budget bands (100/75/50), deterministic tie ordering, and a
regression proving that score never rescues a hard-filter failure.

### 4. Budget tolerance

For a 2,500,000 budget test:

- 2,500,000 → full budget score;
- 2,625,000 (+5%) → configured partial score;
- 2,750,000 (+10%) → configured tolerance edge behavior;
- >2,750,000 → zero budget score.

### 5. Furnishing hard filter

- exact stated furnishing → candidate remains eligible;
- explicit mismatch → candidate is excluded;
- stated request furnishing + missing stock furnishing → candidate is excluded as unverifiable;
- missing request furnishing → filter is inactive and does not block;
- furnishing never appears as a ranking component;
- missing stock furnishing must not crash matcher.

### 6. Multiple matches / Telegram

Fixture with 5 successful stock matches.
Assert:

- all 5 are returned by matcher;
- all 5 are persisted;
- Telegram builder contains all 5;
- no Top-3 truncation;
- chunking preserves all stock IDs and ranking if max message size is exceeded.

This test is critical.

### 7. NO_MATCH diagnostics

Test at least:

- unresolved building;
- no stock in location;
- bedrooms mismatch;
- all candidates > tolerance;
- furnishing mismatch or unverifiable furnishing when explicitly requested;
- stock stale/missing.

Assert `match_runs` has result and reason and Google Match Log builder emits zero rows.

### 8. Database integration

Against disposable PostgreSQL:

- migrations apply;
- stock upsert works;
- alias upsert works;
- only ACTIVE SALE stock enters default candidate set;
- `match_results` unique constraint prevents duplicates;
- rerun updates existing result;
- NO_MATCH creates no match_result;
- successful match links back to existing source message ID.

### 9. Stock synchronization

Fixtures must cover:

- live → ACTIVE;
- pocket → ACTIVE;
- takendown excluded from active runtime matching;
- malformed/no stock_id rejected;
- duplicate stock_id handled deterministically;
- aliases with duplicate normalized alias handled deterministically.

### 10. Workflow contract tests

Parse generated workflow JSON and fail if:

- expected workflow names are missing;
- PostgreSQL is not used for realtime stock;
- Google Sheets is queried in the realtime matching path;
- successful matches are capped at 3;
- NO_MATCH is sent to Telegram;
- matching path lacks match_run persistence;
- stock sync lacks manual trigger capability;
- deployment code contains workflow delete behavior.

Embedded API keys, bot tokens, passwords, or webhook secrets in workflow JSON are explicitly allowed by project policy and must not cause a contract-test failure.

## Recommended test commands

```bash
npm test
npm run test:unit
npm run test:integration
npm run test:contracts
```

Optional live tests:

```bash
RUN_LIVE_AI_TESTS=true npm run test:live-ai
RUN_N8N_INTEGRATION_TESTS=true npm run test:n8n
```

Never require live external APIs for the default local test suite.
