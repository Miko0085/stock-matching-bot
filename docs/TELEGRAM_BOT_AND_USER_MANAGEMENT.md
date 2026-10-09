# Telegram Bot and Broker User Management

## Goal

Telegram is not a single hardcoded destination.

The platform must manage:

1. Telegram bots;
2. broker Telegram identities;
3. broker-to-bot mappings;
4. notification routing;
5. bot health;
6. delivery history.

One bot can serve many brokers. Multiple bots must also be supported.

---

## Telegram bots

Create `telegram_bots`.

Recommended fields:

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

Statuses:

```text
ACTIVE
DISABLED
ERROR
UNKNOWN
```

For the current pilot it is acceptable to store `bot_token` directly in the database or workflow configuration.

Do not hardcode business routing around a single bot ID.

---

## Broker Telegram accounts

Use `broker_telegram_accounts`.

Recommended fields:

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

A broker may have more than one Telegram mapping over time.

Do not use only `brokers.telegram_chat_id` as the final model.

---

## Broker onboarding

Preferred future onboarding flow:

```text
Admin creates/has Broker
    ↓
Platform creates broker connection token
    ↓
Broker opens https://t.me/<bot>?start=<connection_token>
    ↓
Bot receives /start payload
    ↓
Backend resolves token
    ↓
Telegram user/chat is linked to broker_id
    ↓
is_verified = true
```

The token must be short-lived or single-use in the full-stack implementation.

For the rapid n8n prototype a simpler implementation is acceptable, but the stored result must still be broker-centric.

---

## Bot-to-broker mapping

Effective relationship:

```text
broker_id
↕
broker_telegram_accounts
↕
telegram_bot_id
↕
telegram_bots
```

Notification Router must resolve Telegram delivery using database mappings, never broker names.

---

## Dashboard: Telegram Bots

Add:

```text
Channels
└── Telegram Bots
```

Show:

```text
Bot name
Bot username
Status
Purpose
Connected brokers count
Last health check
Last successful send
Last error
```

Actions:

```text
Add Bot
Edit Bot
Enable
Disable
Health Check
Send Test
View Connected Users
```

---

## Dashboard: Telegram Users

Columns:

```text
Broker
Telegram Username
Telegram User ID
Telegram Chat ID
Bot
Verified
Active
Connected At
Last Message
Last Notification
```

---

## Broker page

Show:

```text
Telegram: CONNECTED / NOT CONNECTED
Bot
Username
Verified
Notifications enabled
Minimum score
Last notification
```

Actions:

```text
Generate connection link
Disconnect
Reconnect
Send test notification
Disable notifications
```

---

## Message grouping

Group by:

```text
request_id + broker_id
```

Do not send one separate buyer-request message for every stock match.

---

## Telegram limits

The renderer must support provider message-length limits.

If required:

```text
Part 1/3
Part 2/3
Part 3/3
```

All successful stock matches must survive chunking.

Testing must prove no match omitted, no duplicate and order preserved.

---

## Security

A Telegram user must never gain access to another broker's matches merely by knowing another broker ID.

Full-stack implementation must validate authenticated/verified broker-to-Telegram mapping server-side.

The `/start` payload is not itself authorization.

---

## Monitoring vs notification

Keep separate concepts:

1. Telegram Monitoring Worker — reads source chats.
2. Telegram Notification Bot — delivers broker matches.

They must have separate health/status in the dashboard.
