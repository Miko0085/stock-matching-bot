'use strict';

// WhatsApp's LID (Linked ID) privacy system frequently hides the real phone
// number behind an opaque `<id>@lid` sender_id -- whatsapp-worker resolves
// it when it can via Baileys' local lidMapping cache and forwards the
// result as `sender_id_alt` (a `<phone>@s.whatsapp.net`-shaped value, or a
// bare phone number). There is no way to force a resolution that the
// worker doesn't already have; this adapter just prefers whichever side of
// the pair actually looks like a phone number, exactly the same "capture
// once, never re-resolve" contract as the old pipeline's ADR-022.
function extractPhoneDigits(value) {
  if (!value) return null;
  const digits = String(value).split('@')[0].replace(/[^0-9]/g, '');
  return digits.length >= 8 ? digits : null;
}

function isLid(id) {
  return Boolean(id) && String(id).endsWith('@lid');
}

// A LID's numeric-looking payload is an opaque internal identifier, never a
// phone number, no matter how many digits it has -- only ever extract a
// phone from an identifier that is NOT itself a LID (prefer the resolved
// alt identity when the primary is a LID, per whatsapp-worker's own
// lidMapping convention).
function resolveAuthorContact(senderId, senderIdAlt) {
  const candidates = [senderIdAlt, senderId].filter((id) => id && !isLid(id));
  for (const candidate of candidates) {
    const phone = extractPhoneDigits(candidate);
    if (phone) return `https://wa.me/${phone}`;
  }
  return null;
}

// Transport-only shape conversion: raw WhatsApp worker payload ->
// UnifiedRawMessage (TZ 11-13).
function toUnifiedRawMessage(raw, { now = () => new Date() } = {}) {
  const chatId = String(raw.chat_id);
  const messageId = String(raw.message_id);
  const senderId = raw.sender_id !== undefined && raw.sender_id !== null ? String(raw.sender_id) : null;
  const senderIdAlt =
    raw.sender_id_alt !== undefined && raw.sender_id_alt !== null ? String(raw.sender_id_alt) : null;

  return {
    schema_version: '1.0',
    provider: 'whatsapp',
    source_message_id: `whatsapp:${chatId}:${messageId}`,
    external_message_id: messageId,
    account_id: raw.account_id ? String(raw.account_id) : null,
    chat_id: chatId,
    group_name: raw.chat_name || null,
    sender_id: senderId,
    sender_id_alt: senderIdAlt,
    author_name: raw.sender_name || null,
    author_username: null, // WhatsApp has no public username concept.
    author_contact: resolveAuthorContact(senderId, senderIdAlt),
    // Preserved verbatim -- never trimmed/rewritten (TZ 8, 13, 110).
    original_text: raw.text,
    // WhatsApp permalinks generally don't exist (TZ 112) -- pass through
    // only if the worker ever supplies one explicitly.
    source_url: raw.source_url || null,
    posted_at: raw.posted_at || null,
    received_at: now().toISOString(),
  };
}

module.exports = { toUnifiedRawMessage, resolveAuthorContact, extractPhoneDigits };
