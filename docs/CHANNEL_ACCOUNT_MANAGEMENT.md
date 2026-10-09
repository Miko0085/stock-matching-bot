# Channel Account Management

Covers Telegram/WhatsApp account login, logout, and status on the
dashboard's `/channels` page. Channel/group discovery and UAE/RF/BOTH/
AUTO/NONE routing assignment already live on `/sources` (see
`MARKET_CONTOURS_AND_SOURCE_ROUTING.md` section 10) — `/channels` does not
duplicate that surface, it only covers the accounts underneath it.

## Architecture

The dashboard is UI + orchestration only. It never opens a second Telethon
or Baileys session, never reads/writes provider session files directly
(other than the one pre-existing, unavoidable exception noted below), and
never stores a login code, 2FA password, or session content in its own
database. All of that stays inside the two provider workers, which are the
sole session/auth authorities:

```
dashboard  --HTTP (X-API-Key)-->  telegram-worker (port 8091)
dashboard  --HTTP (X-API-Key)-->  whatsapp-worker (port 8092)
```

Account identity is always `provider + account_id` (e.g. `telegram:tg_main`,
`whatsapp:wa_main`) — never phone number, display name, or username alone,
since those can change or repeat across accounts.

Pre-existing exception, not introduced by this change: `dashboard/workers.js`'s
`clearWhatsappSession()` deletes `whatsapp-worker/sessions/<account_id>`
directly on disk rather than through a worker HTTP endpoint. This predates
this change and is only ever called after the dashboard has confirmed (via
a fresh status check) that WhatsApp itself already reports `requires_auth`
for that account — i.e. after a real logout already invalidated the
session, so no live session data is destroyed by the deletion. Left as-is
because whatsapp-worker exposes no "delete this dead session" endpoint;
adding one is a reasonable future follow-up but out of scope here.

## What was already there vs. what this change adds

Phase 0 audit findings (recorded here since they materially shaped the
design):

| Capability | WhatsApp (before) | Telegram (before) | This change |
|---|---|---|---|
| List accounts + live status | `GET /whatsapp/accounts` | `GET /telegram/accounts` | unchanged |
| Connect a new or existing account | `POST /whatsapp/accounts` (Baileys pairing QR) | **none — offline-only CLI script, no HTTP** | added `POST /telegram/accounts` + `GET /telegram/qr` |
| 2FA / password step | n/a (WhatsApp has none) | **none** | added `POST /telegram/accounts/password` |
| Logout (unlink device / invalidate session, keep other data) | `POST /whatsapp/accounts/logout` | **none** | added `POST /telegram/accounts/logout` |
| Dashboard UI: add/connect + logout | reconnect/clear-session only, no logout button, no "add new account" input | read-only card, no actions at all | both cards now have an "Add / connect account" field and provider-appropriate logout/login actions |

The task's original spec assumed a phone-number → SMS/app code → 2FA
password Telegram login flow. That flow does not exist anywhere in this
codebase. The real, previously-working Telegram login is QR-based
(Telethon's `client.qr_login()`), used today only via an interactive CLI
script (`telegram_qr_login_account.py`, run by hand on the host/container).
Per an explicit decision during this task, the new HTTP flow **wraps that
same QR mechanism** instead of building an untested phone-code path from
scratch — this mirrors WhatsApp's existing QR pattern exactly, so both
providers now behave the same way from the dashboard's point of view, and
the well-tested underlying Telethon call (`qr_login()` /
`SessionPasswordNeededError`) is unchanged.

A second Phase 0 finding: this repository checkout had no worker source
code on disk at all (only `.env`, `sessions/`, `state/`, `logs/` — the
`.py`/`.js` files and `docker-compose.yml`/`Dockerfile`s had been deleted
from the working tree, though the running containers still had them
baked into their images from the last build). The real source was
recovered via `docker cp` from the live `telegram-worker`/`whatsapp-worker`
containers, and `docker-compose.yml` plus both `Dockerfile`s were recovered
from earlier git history (deleted in commit `40acb80`) — content
unchanged, just restored to disk so the workers are buildable/deployable
again. See `telegram-worker/`, `whatsapp-worker/`, and `docker-compose.yml`
at the repo root.

## New telegram-worker endpoints

All require `X-API-Key`, same as every other `/telegram/*` route.

- `POST /telegram/accounts` `{account_id}` — starts a QR login for a new
  (or previously logged-out) `account_id`. Idempotent while a login is
  already in progress for that `account_id`. Rejects with 409 if the
  account is already authorized (log it out first to re-login).
- `GET /telegram/qr?account_id=...` — polls the pending login:
  `waiting_for_scan` (with `qr_data_url`, a base64 PNG), `needs_password`,
  `connected`, `expired` (after 90s — start a new login), or `error`. The
  instant this observes `connected`, the freshly-authorized client is
  handed off to the persistent client manager (`adopt_authorized_client`)
  so the account starts receiving events immediately — no worker restart.
- `POST /telegram/accounts/password` `{account_id, password}` — submits a
  2FA password for a login currently `needs_password`. A wrong password
  keeps the login in `needs_password` with `error` set so the operator can
  retry without starting over.
- `POST /telegram/accounts/logout` `{account_id}` — Telethon's official
  `log_out()`: invalidates the auth key server-side and deletes the local
  session file, the same as removing the session from Telegram's own
  "Devices" settings. Cancels that account's reconnect-watch task and
  marks it `unauthorized`. Never touches any other account.

Implementation: `telegram-worker/telegram_login.py` (new — the pending-login
state machine, isolated from the persistent `TelegramClientManager` until a
login succeeds) plus two new methods on `TelegramClientManager` in
`telegram_adapter.py`: `adopt_authorized_client()` and `logout_account()`.
Wired into `worker_api.py`.

## WhatsApp endpoints

No server-side changes — `whatsapp-worker/server.js` already had
everything needed: `POST /whatsapp/accounts` (connect new or existing,
already used by the dashboard's "Nudge reconnect" button), `GET
/whatsapp/qr`, and `POST /whatsapp/accounts/logout` (already correctly
unlinks the device without deleting session files). Only the dashboard UI
changed, to add a logout button and a "connect a new account" input.

## Distinct semantics (per account, per provider)

- **Disable monitoring** — a routing/monitoring decision on `/sources`
  (`ingest.source_routes`). Does not touch the account's login/session at
  all.
- **Logout** — invalidates the session on the provider's side
  (`POST .../accounts/logout` for both providers now). Local session data
  is gone (deleted for Telegram; explicitly *not* deleted for WhatsApp,
  which keeps its files and just marks `requires_auth` until a fresh QR
  pairing). Never touches `ingest.sources`, `ingest.source_routes`, or any
  match history — neither worker has DB access at all, so this is
  structurally guaranteed, not just a convention.
- **Remove account** — explicitly out of scope for this change. There is
  no "delete this account and its channels" action anywhere yet.

## Dashboard changes

`/channels` (`dashboard/server.js`, `dashboard/workers.js`):

- Telegram card: existing read-only account list gained a "Log out" button
  per connected account, an "Add / connect account" input (starts a QR
  login for a new `account_id`), and inline QR / 2FA-password / "QR
  expired, start new login" states for any account mid-login — the same
  visual pattern the WhatsApp card already used for its own QR flow.
- WhatsApp card: gained a "Log out" button per connected account (distinct
  from the pre-existing "Clear session & get new QR", which stays reserved
  for post-logout cleanup) and an "Add / connect account" input, reusing
  the existing `POST /whatsapp/accounts` reconnect call.
- New routes: `POST /channels/telegram/start-login`,
  `POST /channels/telegram/submit-password`,
  `POST /channels/telegram/logout`, `POST /channels/whatsapp/logout`.
- New `dashboard/workers.js` exports: `startTelegramLogin`,
  `getTelegramLoginStatus`, `submitTelegramLoginPassword`, `logoutTelegram`,
  `connectWhatsapp` (alias for the existing `reconnectWhatsapp` — same
  worker call, new name for the "connect a new account" UI path),
  `logoutWhatsapp`.
- Existing `WORKER_API_KEY` / `TELEGRAM_WORKER_URL` / `WHATSAPP_WORKER_URL`
  env vars are reused; no new env vars were introduced.

Deliberately unchanged: `/sources` (channel/group discovery and routing),
Matching V2 gate logic and runtime settings, Phase 4 cutover state, n8n
matching workflows.

## Tests

- `telegram-worker/test_telegram_login.py` (11 tests) — the QR login state
  machine in isolation: waiting → connected, waiting → needs_password →
  connected, wrong password stays `needs_password`, idempotent
  double-start, timeout → `expired`, already-authorized rejection,
  `pop_connected` is single-use. A fake `TelegramClient`/`qr_login`
  throughout — no real network call, no real Telegram account.
- `telegram-worker/test_telegram_adapter_login.py` (5 tests) —
  `adopt_authorized_client()` / `logout_account()` on
  `TelegramClientManager`: adoption marks the account connected and
  visible via `list_accounts()`; logout invalidates the session, clears
  the watch task, and never touches a different account's state.
- `telegram-worker/test_worker_api_login_routes.py` (11 tests) — the five
  new/changed route handlers called directly (not through
  `TestClient`/lifespan, which would try to reconnect whatever real
  session files happen to be on disk): status propagation, 409 on
  already-authorized / no-pending-login, QR data URL shape, adoption
  handoff on both the QR-poll and password-submit paths.
- `tests/unit/dashboard-workers-login.test.js` (7 tests) — the new
  `dashboard/workers.js` functions, with `global.fetch` mocked: correct
  URL/method/body/`X-API-Key` header for each call, 404 surfaced as
  `ok:false`.

Total new: 34 tests, all passing. No test performs a real Telegram login
or a real WhatsApp QR login, per the project rule.

## Deployment

Code deployed by rebuilding the `telegram-worker` Docker image (the new
`telegram_login.py` module and the `worker_api.py`/`telegram_adapter.py`
changes require a rebuild — `docker compose build telegram-worker &&
docker compose up -d telegram-worker`) and restarting the dashboard
process. `whatsapp-worker` needed no rebuild (no source changes there).

Existing connected sessions (`tg_main`, `wa_main`) are untouched by this
deployment — restarting `telegram-worker` reloads the same on-disk
`.session` file the same way it always has on any restart; nothing here
logs out a real account automatically.
