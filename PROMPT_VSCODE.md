# Prompt for VS Code Coding Agent

> **Status:** historical bootstrap prompt for the legacy n8n pilot. For the
> active Dubai runtime contract, follow `AGENTS.md` and
> `dubai-lead-matching-service/README.md`. In particular, the active service uses
> hard filters followed by ranking weights 50/30/15/5, has no score
> eligibility threshold, and does not generate `STRONG_MATCH`.

You are implementing **Nika Estate Mini Matching Pilot** in this repository.

## First action — mandatory

Before writing any code, read these files in order:

1. `AGENTS.md` — highest-priority project instructions.
2. `docs/MINI_PILOT_SPEC.md` — business/technical scope.
3. `docs/TESTING.md` — tests are release blockers.
4. `docs/N8N_DEPLOYMENT.md` — n8n safety/deployment rules.
5. `.env.example` — required configuration.

Do not begin implementation until you understand the rules above.

## Context

There is already a working production n8n monitoring workflow receiving Telegram and WhatsApp group messages. It already performs filtering, PostgreSQL save/dedupe, and sends existing notifications. It must not be broken or refactored as part of this task.

The integration point is after the existing `Keep Only Accepted New Leads` node. Prefer a separate matching workflow invoked through an isolated webhook branch rather than inserting the whole matching engine inside the production workflow.

Stock and aliases are edited in Google Sheets but realtime matching must query PostgreSQL only.

## Goal

Implement and deploy two pilot workflows:

1. `NIKA PILOT - Stock Sync`
2. `NIKA PILOT - Matching`

Also create the SQL migrations, matching/normalization source, workflow generation/deployment scripts, tests, and documentation necessary to make the system reproducible from the repository.

## Required behavior

### Stock Sync

- Read `Stock Inventory` Google Sheet.
- Read `Aliases` Google Sheet.
- Validate records.
- Synchronize ACTIVE stock to PostgreSQL.
- Default matching scope is ACTIVE + SALE.
- Synchronize aliases to PostgreSQL.
- Record sync run/status/timestamp.
- Run daily.
- Provide a manual sync trigger.
- Never require Google Sheets reads in realtime matching.

### Matching

Input is an already accepted lead from existing monitoring.

Pipeline:

```text
accepted lead
→ AI structured parser
→ validate parser result
→ exact alias normalization
→ PostgreSQL ACTIVE SALE stock
→ deterministic matching score
→ persist match_run
→ persist all successful match_results
→ send EVERY current MATCH to Telegram (legacy STRONG_MATCH remains compatible)
→ append successful match rows to Google Sheets Match Log
```

NO_MATCH:

- store in PostgreSQL with diagnostic reason;
- do not send to Telegram;
- do not append to Google Sheets Match Log.

### Telegram — critical requirement

If one request produces 1, 5, or 20 successful matches, **all successful matches must be sent**.
Do not implement Top-3-only output.
If Telegram message length is exceeded, split into ordered chunks and preserve all matches.

### Dashboard

Prepare PostgreSQL views/queries suitable for Metabase:

- summary KPIs;
- stock table with unique matched-request count and strong-match count;
- ability to filter/open all requests matched to one stock item;
- request view with all matched stock;
- match history.

Do not build a large custom frontend for this pilot unless necessary.

## Environment / secrets

Project rule: secrets MAY be embedded directly in n8n workflow JSON.
You may copy/use the required API keys, bot tokens, webhook secrets, and integration credentials inside generated pilot workflow JSON when this is the simplest deployment path.
`.env` and n8n Credentials remain available alternatives but are not mandatory for runtime workflow secrets.
Do not add tests that fail only because workflow JSON contains embedded secrets.

The n8n deployment client must use:

```text
N8N_API_URL
N8N_API_KEY
```

Do not write to n8n unless:

```text
N8N_ALLOW_WRITE=true
```

Do not mutate the existing production workflow unless:

```text
ALLOW_PRODUCTION_WORKFLOW_MUTATION=true
```

Default both to false.

## Implementation preference

Keep deterministic matching/normalization as pure testable JavaScript modules under `src/core/`.
Do not maintain an untested second implementation in n8n Code nodes. Either generate/inject Code-node JS from the tested sources or provide a deterministic build step that makes workflow code traceable to tested source.

Recommended modules:

```text
src/core/normalize.js
src/core/aliases.js
src/core/request-schema.js
src/core/scoring.js
src/core/matcher.js
src/core/telegram.js
src/core/no-match-reason.js
```

Recommended scripts:

```text
scripts/build-workflows.js
scripts/n8n-plan.js
scripts/n8n-deploy.js
```

## SQL

Create idempotent migrations for:

```text
stock_inventory
matching_aliases
stock_sync_runs
match_runs
match_results
```

Do not modify/drop `devi_messages`.
Use the existing message record ID as `source_message_id`.

## Tests — mandatory

Implement the tests defined in `docs/TESTING.md`.
At minimum make these commands work:

```bash
npm test
npm run test:unit
npm run test:integration
npm run test:contracts
npm run lint
npm run build:workflows
npm run n8n:plan
```

Use a disposable PostgreSQL instance for integration tests.
Do not make mandatory tests depend on live OpenAI, Telegram, Google Sheets, or n8n.
Mock those boundaries.

Critical regression test:

> A fixture with five successful matches must result in five persisted business matches and Telegram output that includes all five stock IDs.

## Deployment sequence

1. Inspect repository and available reference artifacts.
2. Run baseline tests if present.
3. Implement SQL/schema first.
4. Implement/test normalization + matcher.
5. Implement/test Telegram builder/chunking.
6. Implement Stock Sync workflow generation.
7. Implement Matching workflow generation.
8. Run unit/integration/contract tests.
9. Generate workflow JSON locally.
10. Run `n8n:plan` read-only against the target n8n instance.
11. Do not deploy if tests fail.
12. If `N8N_ALLOW_WRITE=true`, create/update only pilot workflows.
13. If production integration mutation is not explicitly enabled, output the single additive node/connection required for manual insertion after `Keep Only Accepted New Leads` rather than editing production automatically.
14. Report exact workflow IDs, created DB objects, test results, and any manual steps.

## Completion response

Do not say “done” unless tests pass.
Return:

- files created/changed;
- migrations applied;
- workflows created/updated with IDs;
- whether workflows are active/inactive;
- production workflow mutation status (should normally be `not modified`);
- unit/integration/contract test counts;
- any skipped live tests;
- exact remaining manual credential/configuration steps.
