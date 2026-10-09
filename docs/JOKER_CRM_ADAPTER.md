# Joker CRM Adapter

## Purpose

Joker CRM is a future primary stock and broker source for broker-centric matching.

Business loop:

```text
Broker maintains stock in Joker CRM
↓
Joker stock sync
↓
PostgreSQL stock_inventory
↓
Buyer request matching
↓
Responsible broker resolved
↓
Matched buyer opportunity delivered to that broker
```

This creates a direct incentive for brokers to keep CRM stock complete and current.

---

## Architecture rule

Do not couple the Matching Engine directly to Joker API response structures.

Use an adapter:

```text
Joker API
↓
Joker Adapter
↓
Canonical Stock Model
↓
PostgreSQL
```

Matching reads only canonical PostgreSQL data.

---

## Verification status

Public Joker CRM materials indicate API capabilities around CRM entities such as users/agents, contacts, properties/objects, leads and deals.

The project must not invent production endpoint paths, field names, pagination rules, webhook semantics, status values or rate limits.

Before implementing the live adapter, obtain the API documentation and/or inspect the actual authorized Joker tenant.

---

## Required discovery phase

Determine and document:

```text
API base URL
authentication method
tenant/account identifier
object/listing endpoint
users endpoint
agents endpoint
pagination
incremental filtering
object status values
listing owner field
responsible user field
price field
currency
property type
area/community/building representation
bedrooms
furnishing
publication/active status
updated_at
deleted/archive behavior
rate limits
webhooks availability
```

Save actual findings to:

```text
docs/JOKER_API_DISCOVERY.md
```

Do not guess missing semantics.

---

## Canonical stock mapping

Joker objects must map into `stock_inventory`.

Add/retain:

```text
stock_id
stock_source
external_listing_id
status
transaction_type
city
area
project_community
building
bedrooms
bathrooms
property_type
selling_price
annual_rent
size_sqft
plot_size_sqft
furnishing
view
broker_id
listing_owner_broker_id
responsible_broker_id
source_created_at
source_updated_at
last_synced_at
raw_source_json
```

Recommended:

```text
stock_source = JOKER
```

---

## Broker synchronization

Joker users/agents map to internal brokers through:

```text
brokers
broker_external_identities
```

Do not use Joker IDs as internal primary broker keys.

---

## Broker resolution

Do not assume Joker agent, owner and responsible user are equivalent.

During API discovery, determine their exact meaning.

The canonical layer should support:

```text
listing_owner_broker_id
responsible_broker_id
broker_id
```

Notification routing uses a configurable priority rule.

---

## Synchronization

Current n8n phase:

```text
NIKA - Joker Stock Sync
```

Future full-stack phase:

```text
JokerSyncWorker
```

Initial cadence recommendation:

```text
15–60 minutes
```

depending on API limits, plus manual sync.

---

## Sync algorithm

```text
start sync run
↓
fetch users/agents
↓
UPSERT broker identities
↓
fetch stock/objects
↓
validate
↓
map to canonical model
↓
normalize aliases
↓
resolve broker ownership
↓
UPSERT stock_inventory
↓
mark explicitly inactive/deleted stock safely
↓
finish sync run
```

Avoid blind destructive truncation.

---

## Multiple sources

During migration there may be:

```text
JOKER
GOOGLE_SHEETS
MANUAL
future sources
```

Every stock record must identify its source.

Do not silently merge two different external listings solely because text fields look similar.

---

## joker_sync_runs

Recommended fields:

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

## Raw payload retention

For the first integration phase retain raw Joker payloads or `raw_source_json` for debugging.

Raw Joker JSON must not become the runtime matching model.

---

## Webhooks

If Joker supports reliable object/user webhooks, they can complement polling:

```text
webhook → immediate update
+
scheduled reconciliation → correctness
```

Do not depend exclusively on webhooks without reconciliation.

---

## Tests

Mandatory adapter tests:

```text
auth failure
pagination
empty page
new broker
updated broker
new stock
updated price
status deactivation
responsible broker change
unknown property fields
missing broker
duplicate sync
API timeout
partial API failure
```

Fixtures must come from sanitized real Joker responses once available.
