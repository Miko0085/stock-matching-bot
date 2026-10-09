# Data Model Extension — Brokers, Joker, Telegram, Notifications

## Purpose

This document defines the next database additions on top of the current matching pilot.

Existing tables remain:

```text
devi_messages
stock_inventory
matching_aliases
stock_sync_runs
match_runs
match_results
```

---

## New entities

```text
brokers
broker_external_identities
telegram_bots
broker_telegram_accounts
broker_notification_routes
notification_deliveries
joker_sync_runs
channel_health_checks
```

---

# brokers

Canonical internal broker identity.

```text
id BIGSERIAL PRIMARY KEY
name TEXT NOT NULL
phone TEXT
email TEXT
is_active BOOLEAN NOT NULL DEFAULT TRUE
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

Do not use external CRM IDs as the primary internal broker key.

---

# broker_external_identities

Maps internal brokers to external systems.

```text
id
broker_id
source
external_user_id
external_agent_id
external_login
raw_source_json
created_at
updated_at
```

Examples:

```text
source = JOKER
source = MANUAL
```

---

# telegram_bots

```text
id
name
bot_username
bot_token
status
purpose
is_default
webhook_url
last_healthcheck_at
last_successful_send_at
last_error
created_at
updated_at
```

One bot can serve multiple brokers. Multiple bots are supported.

---

# broker_telegram_accounts

```text
id
broker_id
telegram_user_id
telegram_chat_id
telegram_username
telegram_first_name
telegram_last_name
telegram_bot_id
is_verified
is_active
connected_at
last_message_at
created_at
updated_at
```

---

# broker_notification_routes

```text
id
broker_id
channel
telegram_bot_id
telegram_account_id
destination
enabled
priority
min_score
notify_match
notify_strong_match
created_at
updated_at
```

Routes are business data, not merely n8n connections.

---

# notification_deliveries

```text
id
request_id
broker_id
channel
route_id
telegram_bot_id
destination
matches_count
status
idempotency_key
payload_json
provider_message_id
error_code
error_text
created_at
sent_at
delivered_at
```

Unique:

```text
idempotency_key
```

---

# joker_sync_runs

```text
id
started_at
finished_at
status
users_received
agents_received
objects_received
objects_active
brokers_inserted
brokers_updated
stock_inserted
stock_updated
stock_deactivated
error
metadata_json
```

---

# channel_health_checks

```text
id
channel
worker_key
provider
status
process_status
session_status
last_message_at
last_heartbeat_at
latency_ms
error_code
error_text
metadata_json
checked_at
```

---

# stock_inventory changes

Add:

```text
stock_source
external_listing_id
broker_id
listing_owner_broker_id
responsible_broker_id
source_created_at
source_updated_at
last_synced_at
raw_source_json
```

`broker_id` references internal `brokers.id`.

---

# match_results changes

Add:

```text
broker_id
stock_source
external_listing_id
routing_status
```

Recommended routing statuses:

```text
PENDING
ROUTED
UNASSIGNED
NOTIFICATIONS_CREATED
ERROR
```

Snapshot broker ownership at match creation.

---

# Relationship overview

```text
brokers
├── broker_external_identities
├── broker_telegram_accounts
├── broker_notification_routes
└── stock_inventory
      ↓
   match_results
      ↓
notification_deliveries

telegram_bots
├── broker_telegram_accounts
├── broker_notification_routes
└── notification_deliveries
```

---

# Data-model invariants

1. Stock may exist without a broker.
2. A match must not be discarded when broker resolution fails.
3. Broker routing uses internal `broker_id`.
4. Notification delivery is independent from matching persistence.
5. One request may generate matches for multiple brokers.
6. One broker may receive multiple stock matches grouped into one notification.
7. Multiple bots must be supported.
8. Repeated sync/deployment must be idempotent.
9. External provider payloads must not become primary domain keys.
10. Historical match ownership must survive later CRM ownership changes.
