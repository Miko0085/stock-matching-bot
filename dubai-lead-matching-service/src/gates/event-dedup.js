'use strict';

// Event dedup (cost-optimization plan, part A.1.A): prevents processing the
// exact same PHYSICAL webhook event twice (e.g. a retried delivery). This
// is deliberately a different key space from the existing author+text
// content_hash dedup (gates/dedup.js) -- two different physical messages
// with the same content are NOT the same event (they still hash
// differently here); the same physical message delivered twice IS the
// same event even though computeDedupKey() would also happen to agree in
// that case.
//
// Key: provider + chat_id + message_id. Deliberately does NOT include
// account_id -- a chat_id/message_id pair is a property of the message
// itself on the provider's side (Telegram's message IDs are scoped to the
// chat, not to whichever of our accounts is a member of it; the same
// holds for a WhatsApp group JID + Baileys message key), so the same
// physical message stays the same event no matter which of our own
// accounts happened to observe it.
//
// CONFIRMED LIVE INCIDENT (2026-09-25): once a second Telegram account
// (nikaestate_ae) joined groups tg_main already monitored, the exact same
// buyer message arrived as two independent webhook deliveries -- one per
// account, each with a different account_id -- and an earlier version of
// this key (which included account_id) treated them as two different
// events. Each was fully reprocessed: a second real OpenAI call, and a
// second, duplicate MATCH notification sent to brokers for the same
// request. See matching_dubai.processed_events ids 17585/17588
// (telegram:tg_main:-1002021982574:391461 vs
// telegram:nikaestate_ae:-1002021982574:391461, ~10s apart, both
// COMPLETED) for the exact evidence.
function computeEventKey(unifiedRawMessage) {
  const provider = unifiedRawMessage.provider;
  const chatId = unifiedRawMessage.chat_id || '';
  const messageId = unifiedRawMessage.external_message_id || '';
  return `${provider}:${chatId}:${messageId}`;
}

module.exports = { computeEventKey };
