# Pocket Listing Ingest Service

Independent background service (ADR-050, 2026-10-07): ingests new WhatsApp
messages from the "Secondary Nika Estate" pocket-listing group
(`120363410119594257@g.us`, account `wa_anna`), classifies+extracts
supply-side property data via an LLM, and writes `NEEDS_REVIEW` rows
straight into `matching_dubai.stock_inventory`.

**Not a lead-matching contour.** This service does stock *supply*
extraction (a property being offered), the opposite direction from
`dubai-lead-matching-service`/`rf-lead-matching-service`/
`abu-dhabi-lead-matching-service`'s buyer-*demand* matching. It never
imports from, and is never imported by, any of those services
(AGENTS.md section 0's isolation discipline applies here too, even though
this isn't itself a market contour).

## Why a separate service

whatsapp-worker has no message-history API — the only way to observe new
group messages is its existing live webhook forward
(`WA_MONITOR_WEBHOOK_URL`/`WA_MONITOR_GROUP_IDS`), the same mechanism the
three lead-matching services already use. This service is simply one more
additive webhook target, filtered to one chat_id — it never touches the
existing listener webhooks for Dubai/RF/Abu Dhabi (AGENTS.md section 2).

## What happens to a message

1. `chat_id` not in `POCKET_LISTING_SOURCE_CHAT_IDS` → ignored entirely,
   nothing persisted. This service must never log chat content from a
   group it has no business reading.
2. Already-processed `source_message_id` → `DUPLICATE`, no re-processing,
   no second OpenAI call.
3. One OpenAI call classifies whether the message is a genuine property
   listing (at least one concrete, verifiable detail — area, building,
   property type, price, size, or bedroom count) and extracts the fields
   if so. A parser failure writes **no** log row, so a genuine webhook
   redelivery can retry.
4. Not a listing (personal chat, scheduling, a vague pitch with no real
   property) → one `pocket_listing_ingest.processed_messages` row logged
   (`classified_as_listing: false`), **no stock row**. The full text of a
   skipped personal message is never stored beyond this processing step.
5. A genuine listing outside Dubai (this group has historically also
   carried Abu Dhabi/Sharjah objects) → logged with
   `skip_reason: 'non_dubai_city'`, never written to any stock table —
   this service is Dubai-only by design.
6. A genuine Dubai listing → a `matching_dubai.stock_inventory` row is
   created with `status = 'NEEDS_REVIEW'` (never `ACTIVE` — this pipeline
   is fully automated with no human curation step, unlike the one-time
   `.xlsx` import `scripts/dubai-pocket-stock-import-run.js` performed) and
   `stock_source = 'POCKET_LISTING_WHATSAPP_LIVE'` (distinct from that
   import's `'POCKET_LISTING'` tag, so an operator can tell which
   pipeline produced a row). `stock_id` follows the exact same
   `PKT-WA-<YYMMDD>-<NN>` scheme the `.xlsx` import's historical rows
   already use.

An operator reviews and flips `NEEDS_REVIEW` → `ACTIVE` via the status
dropdown already shipped on `/stock?market=uae`, or corrects any field via
that page's pencil-icon edit form — both already built, no new dashboard
work needed for this service.

## Endpoints

- `GET /health`
- `POST /v1/webhooks/whatsapp` — same raw envelope whatsapp-worker already
  sends to every monitored target. Requires `X-API-Key` or
  `X-Webhook-Secret`, same convention as the lead-matching services.

## Not yet wired into live worker traffic

`whatsapp-worker/.env`'s `WA_MONITOR_WEBHOOK_URL`/`WA_MONITOR_GROUP_IDS`
do not yet include this service — wiring that in, and rebuilding
whatsapp-worker, is a separate, explicit step (a live production worker
change) requiring the user's confirmation.

## Config

See `.env.example`. `POCKET_LISTING_SOURCE_CHAT_IDS` is comma-separated
(defaults to the one group this was built for) so a second pocket-listing
source group can be added later without a code change.

## Tests

```bash
npm install
npm run test:unit         # pure prompt/schema/normalization logic, no DB
npm run test:integration  # real Postgres (disposable container or TEST_DATABASE_URL)
```
