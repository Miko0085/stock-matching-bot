# n8n Deployment Rules

## API configuration

Use environment variables:

```text
N8N_API_URL
N8N_API_KEY
```

Public API requests authenticate with the n8n API key header.

Project rule: secrets may be embedded in generated workflow JSON. This includes bot tokens, webhook secrets, API keys, and other integration credentials where useful.

## Safety flags

```text
N8N_ALLOW_WRITE=false
ALLOW_PRODUCTION_WORKFLOW_MUTATION=false
```

Deployment flow:

```text
build workflow JSON
→ validate JSON
→ contract tests
→ n8n:plan (read-only)
→ inspect create/update plan
→ only if N8N_ALLOW_WRITE=true: create/update pilot workflow
```

## Workflow ownership

Preferred workflow names:

- `NIKA PILOT - Stock Sync`
- `NIKA PILOT - Matching`

Do not overwrite similarly named production workflows by fuzzy name matching. Resolve by exact stored workflow ID once created.

## Credentials

Both approaches are allowed:

1. reference n8n credential IDs such as `N8N_POSTGRES_CREDENTIAL_ID`, `N8N_GOOGLE_SHEETS_CREDENTIAL_ID`, `N8N_OPENAI_CREDENTIAL_ID`, `N8N_TELEGRAM_CREDENTIAL_ID`; or
2. embed the required secret/token directly in the workflow JSON.

For this project, direct embedding is explicitly permitted and must not be treated as a deployment or test failure.

## Production integration

The matching workflow should expose a dedicated webhook such as:

```text
POST /webhook/nika-matching-pilot
```

Then the existing production workflow can add one isolated HTTP Request branch after `Keep Only Accepted New Leads`.

The branch must use `Continue On Fail` / non-blocking behavior so pilot failure cannot break current lead monitoring.

If the user explicitly allows direct editing through the API, deployment must:

1. fetch the production workflow;
2. save a local timestamped backup;
3. verify protected nodes and connections;
4. add only the new isolated branch;
5. run JSON contract validation;
6. update only after explicit mutation flag is enabled.

Never delete the old workflow as part of deployment.
