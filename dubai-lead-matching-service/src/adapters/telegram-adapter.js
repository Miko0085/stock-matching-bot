'use strict';

// A t.me permalink to the exact message, derived from fields
// telegram-worker already sends in every event (chat_username, chat_id,
// message_id) -- telegram-worker itself never computes this (transport-only,
// MARKET_CONTOURS_AND_SOURCE_ROUTING.md section 16), so it must be built
// here, not just passed through from raw.source_url (which telegram-worker
// never sets).
//   - public channel/group (has a username): https://t.me/<username>/<id>
//     -- resolvable by anyone, not just members.
//   - private supergroup/channel (chat_id is the standard -100<digits>
//     marked form, no username): https://t.me/c/<digits>/<id> -- resolves
//     for existing members only (this account IS a member, since that's
//     why it's monitored), same limitation telegram_joiner.py documents
//     for t.me/c/ links generally.
//   - a plain (non-super) basic group: chat_id has no -100 prefix and
//     Telegram has no permalink format for these at all -- null, which
//     render.js shows as an explicit "unavailable" line, never a guess.
function deriveTelegramSourceUrl({ chatId, chatUsername, messageId }) {
  if (chatUsername) return `https://t.me/${chatUsername}/${messageId}`;
  const match = /^-100(\d+)$/.exec(String(chatId));
  if (match) return `https://t.me/c/${match[1]}/${messageId}`;
  return null;
}

// Transport-only shape conversion: raw Telegram worker payload ->
// UnifiedRawMessage. No filtering, no classification, no side effects --
// exactly the "provider adapter" boundary from TZ 12.
function toUnifiedRawMessage(raw, { now = () => new Date() } = {}) {
  const chatId = String(raw.chat_id);
  const messageId = String(raw.message_id);
  const senderUsername = raw.sender_username ? String(raw.sender_username).replace(/^@/, '') : null;

  return {
    schema_version: '1.0',
    provider: 'telegram',
    source_message_id: `telegram:${chatId}:${messageId}`,
    external_message_id: messageId,
    account_id: raw.account_id ? String(raw.account_id) : null,
    chat_id: chatId,
    group_name: raw.chat_name || null,
    sender_id: raw.sender_id !== undefined && raw.sender_id !== null ? String(raw.sender_id) : null,
    sender_id_alt: null, // Telegram has no LID-style alt identity concept.
    author_name: raw.sender_name || null,
    author_username: senderUsername,
    author_contact: senderUsername ? `https://t.me/${senderUsername}` : null,
    // Preserved verbatim -- never trimmed/rewritten (TZ 8, 13, 110).
    original_text: raw.text,
    source_url: raw.source_url || deriveTelegramSourceUrl({ chatId, chatUsername: raw.chat_username || null, messageId }),
    posted_at: raw.posted_at || null,
    received_at: now().toISOString(),
  };
}

module.exports = { toUnifiedRawMessage, deriveTelegramSourceUrl };
