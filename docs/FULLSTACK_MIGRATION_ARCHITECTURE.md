# n8n Prototype to Internal Full-Stack Architecture

## Purpose

The current implementation intentionally uses n8n to move quickly.

n8n is the prototype/integration execution layer, not the long-term owner of all business logic.

The platform must be designed so core functionality can later move into an internal backend without replacing the database model or rewriting business concepts.

---

## Long-term principle

```text
AI understands
Code decides
PostgreSQL remembers
Adapters integrate
Workers execute
Dashboard operates
```

---

## What may remain in n8n during pilot

Good n8n responsibilities:

```text
webhook transport
scheduled triggers
API calls
Google Sheets integration
rapid Joker API experiments
Telegram/WhatsApp provider calls
simple orchestration
temporary glue
```

Avoid allowing n8n to become the only place where core business rules exist.

---

## Portable business logic

Keep deterministic and testable:

```text
request validation
normalization
alias resolution
candidate retrieval rules
matching score
match classification
broker resolution
notification grouping
route selection
idempotency
NO_MATCH diagnosis
```

Even if initially embedded into Code nodes, keep source copies/tests in the repository.

---

## Target service boundaries

```text
API / Backend
├── Requests
├── Stock
├── Brokers
├── Matching
├── Notifications
├── Channels
└── Admin / Dashboard

Workers
├── Joker Sync Worker
├── Matching Worker
├── Notification Worker
├── Telegram Monitoring Adapter
└── WhatsApp Monitoring Adapter

PostgreSQL
└── source of truth
```

---

## Suggested domain modules

```text
domains/
├── requests/
├── stock/
├── aliases/
├── brokers/
├── matching/
├── notifications/
├── telegram/
├── joker/
└── channel-health/
```

---

## TypeScript vs Python

Do not choose the language purely because the prototype used n8n.

### TypeScript is especially relevant if

```text
the dashboard/backend is Node/Next.js
shared runtime types are valuable
Telegram/HTTP integrations dominate
one language across frontend/backend is preferred
real-time/event-driven workflows are central
```

Possible stack:

```text
TypeScript
Fastify or NestJS
PostgreSQL
Drizzle / Prisma / Kysely
BullMQ / Temporal if needed
Next.js dashboard
```

### Python is especially relevant if

```text
AI/data processing grows substantially
matching/recommendation experimentation becomes data-heavy
Python analytics/ML ecosystem becomes important
existing backend conventions favor FastAPI
```

Possible stack:

```text
Python
FastAPI
SQLAlchemy
PostgreSQL
Celery / Dramatiq / Temporal if needed
separate frontend
```

### Current recommendation

Do not lock the project into Python or TypeScript in the database schema.

Define language-independent contracts and canonical SQL models first.

If the existing dashboard is already TypeScript/Node-based, TypeScript is likely the lower-friction first choice for the operational backend.

Python can remain available for specialized AI/data services later.

---

## External adapters

External systems terminate at adapters:

```text
JokerAdapter
TelegramAdapter
WhatsAppAdapter
GoogleSheetsAdapter
```

Domain code must not depend directly on provider payloads.

---

## Repository interfaces

Future conceptual interfaces:

```text
StockRepository
BrokerRepository
RequestRepository
MatchRepository
NotificationRepository
AliasRepository
```

Matching Engine must be runnable in tests without Joker, Telegram, n8n or Google Sheets.

---

## Event model

Future internal events may include:

```text
RequestAccepted
StockUpserted
MatchCreated
MatchUpdated
BrokerResolved
NotificationRequested
NotificationSent
NotificationFailed
ChannelHealthChanged
```

Do not require a message broker for the current pilot.

---

## Migration phases

### Phase 0 — Current pilot

```text
n8n orchestration
PostgreSQL source of truth
Google Sheets stock
AI request parser
deterministic matcher
Telegram alerts
```

### Phase 1 — Broker routing

```text
brokers
Telegram mappings
notification routes
delivery logging
```

### Phase 2 — Joker integration

```text
Joker stock sync
broker ownership sync
personal broker notifications
```

### Phase 3 — Operations dashboard

```text
bot management
broker channel settings
worker health
reconnect controls
match views
```

### Phase 4 — Extract core backend

Move matching, broker resolution, notifications, Joker sync and channel health out of n8n into internal services.

### Phase 5 — Reduce n8n dependency

Move remaining critical flows only when replacement paths are tested.

No big-bang migration.

---

## Shadow migration

When replacing an n8n matching flow:

```text
existing n8n matcher
+
new backend matcher in shadow mode
```

Compare candidate count, matches, scores, broker assignment and notifications requested.

---

## Database ownership

PostgreSQL remains the source of truth during migration.

Avoid creating long-lived business state only inside n8n static data, workflow execution history, Google Sheets, Telegram or Joker.

---

## Testing standard

Critical invariants:

```text
all successful matches persisted
no Top-3 loss
broker routing deterministic
cross-broker stock isolation
idempotent deliveries
NO_MATCH diagnostic retained
inactive stock excluded
Joker sync idempotent
worker controls do not mutate unrelated workers
```
