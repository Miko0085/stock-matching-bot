# Broker-Centric Matching and Notification Routing

## Status

Target architecture extension for Nika Estate Matching Platform.

This document extends the current Mini Matching Pilot. It does not replace the existing n8n pilot.

## Goal

The platform must not treat all company stock and all matched requests as one common notification pool.

Every stock item must be attributable to an internal broker when that ownership/responsibility is known.

Every successful match must be:

1. persisted;
2. linked to the matched stock;
3. linked to the responsible broker;
4. routed to that broker's configured notification destinations;
5. logged as a delivery attempt.

The system must support multiple matches for one broker and multiple brokers for one request.

---

## Core business flow

```text
Buyer Request
    ↓
Request Parser
    ↓
Matching Engine
    ↓
Request ↔ Stock Match
    ↓
Resolve responsible broker
    ↓
Group matches by request_id + broker_id
    ↓
Notification Router
    ↓
Broker-specific channels
    ├── Telegram
    ├── WhatsApp
    └── Email
```

A broker must only receive the matches assigned to that broker's stock unless an explicit administrative/global route exists.

---

## Stock ownership

`stock_inventory` must contain an internal `broker_id`.

Recommended fields:

```text
broker_id
listing_owner_broker_id
responsible_broker_id
stock_source
external_listing_id
```

Routing priority should be configurable.

Initial recommended rule:

```text
if responsible_broker_id exists:
    route to responsible_broker_id
else if listing_owner_broker_id exists:
    route to listing_owner_broker_id
else if broker_id exists:
    route to broker_id
else:
    routing_status = UNASSIGNED
```

Do not use a broker name, phone number, Telegram username, or email as the primary relationship key.

The stable internal relationship key is always `broker_id`.

---

## Match ownership

`match_results` must snapshot broker ownership at match creation time.

Add:

```text
broker_id
stock_source
external_listing_id
routing_status
```

If the responsible broker changes later in Joker CRM, historical matches still retain the broker to whom the opportunity was assigned at that time.

---

## Multiple matches for one broker

Example:

```text
Request #123
├── Stock A → Broker 7
├── Stock B → Broker 7
├── Stock C → Broker 7
└── Stock D → Broker 12
```

Notification grouping:

```text
request_id + broker_id
```

Output:

```text
Broker 7 → one notification containing Stock A, B, C
Broker 12 → one notification containing Stock D
```

Do not send three duplicated request notifications to Broker 7.

---

## One request matched to several brokers

Each broker receives only their own matching stock.

Administrative/global notifications are a separate explicit route and must not be mixed with broker routing.

---

## Unassigned matches

Never discard a match because a broker cannot be resolved.

Persist:

```text
match_results.routing_status = UNASSIGNED
```

Expose in the dashboard as `Unassigned Matches` and allow later manual assignment.

---

## Notification routes

Use a generic route model.

Recommended table:

```text
broker_notification_routes
```

Fields:

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

Channels:

```text
TELEGRAM
WHATSAPP
EMAIL
```

The Matching Engine produces persisted matches. The Notification Router consumes persisted matches and routes them.

---

## Delivery logging

Use `notification_deliveries`.

Recommended fields:

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
payload_json
provider_message_id
error_code
error_text
created_at
sent_at
delivered_at
```

Statuses:

```text
PENDING
SENDING
SENT
DELIVERED
FAILED
SKIPPED
```

Delivery logging must make it possible to answer whether the match was created, who owned it, which channel was selected, which bot/account was used, and what error occurred.

---

## Channel fallback

The model must allow ordered fallback:

```text
priority 1 → Telegram
priority 2 → WhatsApp
priority 3 → Email
```

Fallback execution is optional for the first version, but the schema must support it.

---

## Telegram rule for the active Dubai matcher

Every successful `MATCH` must be persisted and eligible for notification.
The active `dubai-lead-matching-service` does not generate `STRONG_MATCH`;
historical `pilot-v1` rows with that status remain successful for backward
compatibility.

Do not apply an arbitrary Top-3 cutoff.

If a broker has 12 matching stock items for one request, all 12 must be represented in the broker's notification payload, using message chunking if required.

---

## Idempotency

Notification generation must be idempotent.

Recommended delivery idempotency key:

```text
request_id + broker_id + channel + notification_version
```

Provider retries must not create uncontrolled duplicate messages.
