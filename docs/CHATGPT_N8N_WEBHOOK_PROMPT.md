# Context prompt — paste into ChatGPT to design/adapt the n8n workflows

You are helping configure **n8n workflows** that receive inbound
Telegram/WhatsApp group-monitoring events from an already-built,
already-running messaging platform. You do not have access to that
platform's codebase — everything you need to know about the contract
it sends is in this prompt. Your job is to help design the n8n
workflow(s) that receive and process these events (routing, parsing,
whatever downstream logic the user wants) — not to modify the sender.

## What already exists (do not redesign this part)

Two independent worker services (Python/FastAPI for Telegram, Node/
Express for WhatsApp) each run a persistent connection to one messaging
account, watch for new messages in a specific allowlist of groups, and
POST a normalized JSON event to one or more configured webhook URLs —
with automatic bounded retries (up to a few attempts over ~10-20
seconds, exponential backoff, then the event is dropped and logged —
**it does not retry forever**, so the n8n side should respond quickly
and not rely on the sender re-delivering indefinitely).

**This is only for GROUP monitoring/lead detection.** There is a
completely separate pipeline for private 1:1 conversation replies that
goes to a different internal service (not n8n) — you don't need to
build or think about that part at all.

## Webhook endpoints — already live, both channels, both instances

Two n8n Webhook trigger nodes, one per channel, both **POST**. Both are
**already created and confirmed receiving real production traffic** —
this is no longer a "set this up" task, it's "help build out what
happens after the trigger node."

| Channel | Path | Status |
|---|---|---|
| Telegram | `/webhook/telegram-monitor` | ✅ Live on the local n8n instance AND on `n8n.nikaestate.ae` — confirmed via real message deliveries returning `200 OK` on both. |
| WhatsApp | `/webhook/whatsapp-monitor` | ✅ Live on `n8n.nikaestate.ae`, confirmed via real deliveries returning `200 OK`. 6 WhatsApp groups are currently on the monitored allowlist (more may be added later — that's controlled on the sender side, not in n8n). Not yet delivering to a local n8n instance (only the external one is configured for WhatsApp so far). |

The sender delivers the same event to every configured destination
independently (one failing/missing destination never blocks another) —
this is why the same event can arrive at both the local instance and
`n8n.nikaestate.ae` for Telegram.

**Known one-time gap:** during initial activation there was a ~30s
window where a handful of events hit the not-yet-active webhook, got
`404` for all 3 retries, and were dropped (by design — no infinite
retry). That's already resolved and not an ongoing issue; mentioned
only so you don't go looking for those specific messages.

## Auth

Sender includes header `X-Webhook-Secret: <value>` on every POST if a
secret is configured on its side for that destination — currently
**empty/not set** for these specific webhooks (so no header is sent
right now). If you want the n8n workflow to validate a secret, that's
fine to add — just flag back that a value needs to be configured on the
sender side too (env var, not something you can do from the n8n side
alone).

## Exact payload shape — Telegram (`provider: "telegram"`)

```json
{
  "event": "message.new",
  "provider": "telegram",
  "account_id": "tg_main",
  "chat_id": "-1001932106227",
  "chat_name": "Real Estate in Dubai 🇦🇪",
  "chat_username": "realestate_dxb_uae",
  "message_id": 626342,
  "sender_id": "987654321",
  "sender_name": "John Doe",
  "sender_username": "johndoe",
  "text": "Need 2BR Peninsula 4 for client, budget 1.5M AED",
  "voice_audio_base64": null,
  "voice_mime_type": null,
  "posted_at": "2026-09-02T08:22:03Z",
  "is_group": true,
  "is_channel": false,
  "is_private": false
}
```

- `chat_id`/`sender_id`/`message_id` are the real Telegram identifiers
  (not display strings) — safe to use for dedup/lookups.
- `voice_audio_base64`/`voice_mime_type` are populated (base64 OGG/Opus,
  mime `audio/ogg`) **instead of** `text` when the message is a voice
  note with no caption — `text` is `""` in that case. Decide if/how you
  want to transcribe these; nothing upstream does it for you.
- Since this is the *group-monitor* stream specifically, `is_group` is
  always `true` and `is_private`/`is_channel` are always `false` for
  everything this webhook receives — the allowlist on the sender side
  only contains group chat_ids.

## Exact payload shape — WhatsApp (`provider: "whatsapp"`)

```json
{
  "event": "message.new",
  "provider": "whatsapp",
  "account_id": "wa_main",
  "chat_id": "120363423302382897@g.us",
  "chat_name": "",
  "chat_username": "",
  "message_id": "3EB0C767D...",
  "sender_id": "178692181479472@lid",
  "sender_id_alt": "971585118782@s.whatsapp.net",
  "sender_name": "John Doe",
  "sender_username": "",
  "text": "Need 2BR Peninsula 4 for client",
  "voice_audio_base64": null,
  "voice_mime_type": null,
  "posted_at": "2026-09-02T08:34:58Z",
  "is_group": true,
  "is_channel": false,
  "is_private": false
}
```

Differences from the Telegram shape worth knowing:

- **`chat_name` and `chat_username` are always empty strings for
  WhatsApp** — Baileys doesn't include the group subject in the message
  event itself. If you need the human-readable group name in the
  workflow, you'll have to look it up separately (there's a
  `GET /whatsapp/groups?account_id=wa_main` endpoint on the sender that
  returns `{destination_id, name}` pairs you could cache/join against
  `chat_id` — ask back if you need the exact call shape).
- **`sender_id_alt`** (WhatsApp-only field): WhatsApp identifies the
  same person as either a `@lid` or a `@s.whatsapp.net` (phone-number)
  JID depending on context, inconsistently. `sender_id` is always
  exactly what was received (don't rewrite it); `sender_id_alt` is the
  other form when the sender's own platform library already resolved
  it, `null` otherwise. If you're matching/deduping by sender, check
  both forms.
- `message_id` is a string (Telegram's is a number).

## What's NOT in scope here

- Do not build anything for private 1:1 replies — different pipeline,
  different destination, not n8n.
- Do not invent qualification/lead-scoring logic unless the user
  explicitly asks for it in this conversation — this prompt only
  establishes the technical contract (what arrives, on which path, in
  what shape). What the workflow actually *does* with each event
  (store it, forward it, notify someone, filter by keyword, etc.) is
  for the user to specify next.

## What to help with right now

The Webhook trigger nodes themselves already exist and already respond
(confirmed `200 OK` on real traffic) — don't rebuild those. What's
actually needed next:

1. Ask the user what the workflow should *do* with each event once
   parsed (store it, forward it, notify someone, filter/route by
   keyword or group, feed a lead-detection step, etc.) — this hasn't
   been specified yet, don't assume.
2. Help structure the parsing/routing logic against the exact payload
   shapes above (e.g. a Set/Code node to normalize both channels into
   one internal shape before branching, if that's useful for what they
   want to build).
3. If useful, suggest deduping by `(provider, chat_id, message_id)`
   before any side-effecting step, since a slow/retried delivery could
   in rare cases arrive more than once.
4. If they want one shared sub-workflow reused by both channels (the
   payload shapes are 95% identical, only WhatsApp adds `sender_id_alt`
   and always-empty `chat_name`/`chat_username`), that's a reasonable
   suggestion — offer it, but let them decide.
5. If they now want to *also* add a local n8n destination for the
   WhatsApp webhook (matching how Telegram already delivers to both
   local and external), that's a sender-side config change, not
   something to do in n8n — flag it back rather than trying to solve
   it here.
