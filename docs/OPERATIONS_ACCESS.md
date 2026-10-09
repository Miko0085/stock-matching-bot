# Operations Access — Production Server & Database

**Purpose:** a single, durable reference for how an agent (or a human) connects to production infrastructure for this project, so the connection *mechanism* never needs to be re-explained from scratch in every conversation. This file documents **how to connect**, not **when it's okay to write** — see section 1 first.

**This file must never contain actual secrets** (passwords, private key contents, tokens). Every value below is either a command, an environment-variable *name*, or a placeholder. Real values live only in `.env` (already gitignored — see `.gitignore:1`).

## 1. Standing authorization policy (read this first)

| Action class | Standing authorization? |
|---|---|
| **Read-only inspection** (SELECT queries, `\d`, `schema_migrations` checks, log tailing, `systemctl status`, viewing running processes) | **Yes, standing** — an agent may do this whenever relevant to the task at hand, without asking first, using the mechanism below. |
| **Any write to the production database** (migrations, `INSERT`/`UPDATE`/`DELETE` outside normal application traffic, `ALTER`/`DROP`) | **No — always requires explicit, fresh confirmation from Mikhail in that specific conversation**, even though the connection mechanism is documented here. State exactly what will be run and wait for a yes. |
| **Any production application deploy/restart** | **No — always requires explicit, fresh confirmation**, same reasoning. |
| **Destructive operations** (`DROP TABLE`, `TRUNCATE`, mass `DELETE`, force-push, history rewrite) | **Never** without an explicit, unambiguous, one-time instruction naming the exact operation. |

Rationale: knowing *how* to connect and being *allowed to change production* are two different things. This file removes the friction of the first; it deliberately does not remove the friction of the second, because production carries real Telegram/WhatsApp buyer traffic and mistakes there are not easily reversible.

## 2. Database access — SSH tunnel to `devi_db`

Production Postgres is not exposed directly; access goes through an SSH tunnel to the host, forwarding a local port to Postgres's `5432` on the remote side.

**Start the tunnel** (persistent, auto-reconnects on drop):

```sh
npm run tunnel
```

This runs `scripts/tunnel.sh`, which reads its connection metadata from `.env` (never hardcode these):

```
SSH_TUNNEL_HOST=          # production host/IP
SSH_TUNNEL_USER=root      # SSH user (default: root)
SSH_TUNNEL_KEY_PATH=      # path to the private key, e.g. ~/.ssh/some_key — never paste key contents into .env
SSH_TUNNEL_LOCAL_PORT=55432
SSH_TUNNEL_REMOTE_PORT=5432
```

Once running, Postgres is reachable at `127.0.0.1:55432` for as long as the tunnel process stays up. Check whether it's already running before starting a second one:

```sh
netstat -ano | grep 55432   # Windows/Git-Bash — LISTENING on 127.0.0.1:55432 means it's already up
```

**Connect** once the tunnel is up, using the database credentials (also from `.env`, never hardcoded):

```
DATABASE_URL=postgres://matching_pilot:<password>@127.0.0.1:55432/devi_db
```

or the individual fields:

```
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=55432
POSTGRES_DB=devi_db
POSTGRES_USER=matching_pilot
POSTGRES_PASSWORD=
POSTGRES_SSLMODE=prefer
```

Database: `devi_db`. Schema of interest for Matching V2: `matching_dubai` (renamed from `matching`, migration 0027, 2026-09-28). Role: `matching_pilot`.

**Read-only inspection example** (always safe, standing-authorized):

```sh
node -e "
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"SELECT filename FROM matching_dubai.schema_migrations ORDER BY filename\")
  .then(r => { console.log(r.rows); return pool.end(); });
"
```

For anything beyond `SELECT` — applying a migration, touching a row — stop and get explicit confirmation per section 1, even though the connection itself required no new approval.

## 3. Application server access — deploy & restart

*(Partially known from in-repo evidence; still needs Mikhail to confirm the actual production setup.)*

What the repo already tells us:

- **`dubai-lead-matching-service`** has a `Dockerfile` (`dubai-lead-matching-service/Dockerfile`) with a documented build/run example:
  ```sh
  # from the repo root (build context must be the root, not dubai-lead-matching-service/):
  docker build -f dubai-lead-matching-service/Dockerfile -t nika-dubai-lead-matching-service .
  docker run --rm -p 8095:8095 --env-file dubai-lead-matching-service/.env nika-dubai-lead-matching-service
  ```
  That `docker run` example uses `--rm` (no restart policy, no `-d`, no container name) — fine for a local test, but **not** what a real production run command should look like (needs `-d --restart=always --name ...` or an equivalent). It binds to `127.0.0.1:8095` by default (`MATCHER_HOST=127.0.0.1` in `dubai-lead-matching-service/.env.example`) — internal-only, not public-facing — so whatever calls it (workers, n8n, dashboard) must be on the same host or a private network reachable from there.
- **`dashboard`** has no Dockerfile and no `docker-compose` anywhere in the repo — it looks like a plain Node process (`npm run dashboard` → `node dashboard/server.js`, `DASHBOARD_PORT=8094` per the root `.env.example`), not containerized.
- Both `dubai-lead-matching-service/.env` and the root `.env` are separate files (production almost certainly keeps its own copies of each directly on the server — this repo's local `.env`/`.env.example` are just templates, not synced to the server automatically).

Still unknown / needs confirming:

1. Is `dubai-lead-matching-service` actually run via Docker in production today, or as a plain `node src/index.js` process (the Dockerfile could be unused/aspirational)?
2. Is it on the **same host** as `SSH_TUNNEL_HOST` (section 2), or a different one?
3. How is it currently restarted after a deploy — `docker restart <name>`, a systemd unit, PM2, a manual kill+relaunch?
4. Same three questions for `dashboard`.
5. Do production `.env` files (root and `dubai-lead-matching-service/.env`) already exist on the server with real values, or do they need to be created as part of a deploy?

Once confirmed, this section should record:

```
APP_SERVER_SSH_HOST=        # host/IP of the box running dubai-lead-matching-service (may be the same as SSH_TUNNEL_HOST)
APP_SERVER_SSH_USER=
APP_SERVER_SSH_KEY_PATH=
APP_SERVER_DEPLOY_PATH=     # e.g. /opt/dubai-lead-matching-service or similar — where the repo/build lives on that host
APP_SERVER_RESTART_CMD=     # e.g. "systemctl restart dubai-lead-matching-service" or a pm2 command
APP_SERVER_DASHBOARD_RESTART_CMD=
```

And a short deploy recipe, e.g.:

```sh
ssh -i "$APP_SERVER_SSH_KEY_PATH" "$APP_SERVER_SSH_USER@$APP_SERVER_SSH_HOST" \
  "cd $APP_SERVER_DEPLOY_PATH && git pull && npm install --production && $APP_SERVER_RESTART_CMD"
```

Until this section is filled in, any request to "deploy to production" still requires you to either supply these details in the moment or perform the deploy yourself following a runbook prepared for that specific change.

## 4. Checklist — what to fill in `.env` once, so this stops needing to be re-asked

```
SSH_TUNNEL_HOST=
SSH_TUNNEL_USER=root
SSH_TUNNEL_KEY_PATH=
DATABASE_URL=postgres://matching_pilot:<password>@127.0.0.1:55432/devi_db

APP_SERVER_SSH_HOST=
APP_SERVER_SSH_USER=
APP_SERVER_SSH_KEY_PATH=
APP_SERVER_DEPLOY_PATH=
APP_SERVER_RESTART_CMD=
APP_SERVER_DASHBOARD_RESTART_CMD=
```

`.env` is gitignored (`.gitignore:1`) — filling these in never risks a commit. `.env.example` already documents the DB/tunnel keys with empty placeholders (`SSH_TUNNEL_*`, `DATABASE_URL`, `POSTGRES_*`); the `APP_SERVER_*` keys above are new and should be added to `.env.example` (names only, still empty) once their real names are confirmed, for the same reason the others are already there.

## 5. Quick reference

| Need | Command / location |
|---|---|
| Start DB tunnel | `npm run tunnel` |
| Check if tunnel already running | `netstat -ano \| grep 55432` |
| DB connection string shape | `DATABASE_URL` in `.env` (section 2) |
| App server deploy | section 3, once filled in |
| Is a write to prod okay right now? | No — ask, every time (section 1) |
