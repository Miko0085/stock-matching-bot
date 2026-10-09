/**
 * wa_events.js — pure transport: normalize one Baileys WAMessage into the
 * same event shape ai-qualifier's InboundChannelEvent already accepts
 * (mirrors telegram-worker/telegram_events.py's build_message_event()).
 * No business logic, no filtering decisions beyond what the caller asks.
 */

import { downloadMediaMessage } from '@whiskeysockets/baileys'

function destinationKind(jid) {
  const value = String(jid || '').toLowerCase()
  if (value.endsWith('@g.us')) return 'group'
  if (value.endsWith('@s.whatsapp.net') || value.endsWith('@lid')) return 'private'
  if (value.endsWith('@broadcast') || value === 'status@broadcast') return 'broadcast'
  return 'unknown'
}

// WhatsApp addresses the same chat as a LID sometimes and as a
// phone-number JID other times -- which one a given event uses is not
// under this worker's control, and (found live) is not even consistent
// for the SAME contact across the outreach send and their reply: an
// outreach addressed by LID got a reply that Baileys *also* reported
// under that same LID (a direct, correct match against the stored
// conversation) -- but an earlier, separate fix here had this function
// unconditionally rewrite it to the phone-number alt form, destroying
// that match. The primary chat_id/sender_id must stay exactly what
// Baileys reported (key.remoteJid/key.participant, untouched) so a
// same-form round trip always matches; the resolved counterpart (from
// key.remoteJidAlt/participantAlt, when Baileys already knows it) is
// carried separately as *_alt so the receiving side can match against
// either form instead of this worker guessing which one is "canonical".
function altJidOf(altJid) {
  const alt = String(altJid || '')
  return alt || null
}

function extractText(message) {
  if (!message) return ''
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ''
  )
}

/**
 * A voice note (audioMessage with ptt=true, WhatsApp's push-to-talk flag --
 * distinct from a shared music file, which has ptt=false/undefined and is
 * deliberately left untranscribed) downloaded and base64-encoded. Without
 * this, a voice reply carries empty text all the way to ai-qualifier's
 * "inbound text must not be empty" guard and is silently dropped (found
 * live). Only attempted when there's no text already (a captioned message
 * always has real text via extractText above).
 * `downloadFn` defaults to Baileys' real downloadMediaMessage; tests inject
 * a fake here instead of module-mocking the ESM import (wa_events.test.js
 * imports this module statically, before any mock could intercept it).
 * @returns {Promise<{audio: string, mimeType: string} | null>}
 */
async function downloadVoiceNote(waMessage, downloadFn = downloadMediaMessage) {
  const audioMessage = waMessage.message?.audioMessage
  if (!audioMessage || !audioMessage.ptt) return null
  try {
    const buffer = await downloadFn(waMessage, 'buffer', {})
    if (!buffer || !buffer.length) return null
    return {
      audio: buffer.toString('base64'),
      mimeType: audioMessage.mimetype || 'audio/ogg',
    }
  } catch {
    return null
  }
}

/**
 * @param {string} accountId
 * @param {import('@whiskeysockets/baileys').WAMessage} waMessage
 * @param {Function} [downloadFn] test seam, see downloadVoiceNote
 * @returns {Promise<object>} normalized event payload
 */
async function buildMessageEvent(accountId, waMessage, downloadFn = downloadMediaMessage) {
  const key = waMessage.key || {}
  const remoteJid = String(key.remoteJid || '')
  const kind = destinationKind(remoteJid)
  const isGroup = kind === 'group'

  // Inside a group, the actual author is key.participant; in a private
  // chat, the chat itself (remoteJid) IS the sender.
  const senderId = isGroup ? String(key.participant || '') : remoteJid
  const senderIdAlt = isGroup ? altJidOf(key.participantAlt) : altJidOf(key.remoteJidAlt)

  const timestamp = waMessage.messageTimestamp
  let postedAt = ''
  try {
    const seconds =
      typeof timestamp === 'number' ? timestamp : Number(timestamp?.low ?? timestamp ?? 0)
    if (seconds) postedAt = new Date(seconds * 1000).toISOString()
  } catch {
    postedAt = ''
  }

  const text = extractText(waMessage.message)
  const voice = text ? null : await downloadVoiceNote(waMessage, downloadFn)

  return {
    event: 'message.new',
    provider: 'whatsapp',
    account_id: accountId,
    chat_id: remoteJid,
    chat_name: '',
    chat_username: '',
    message_id: String(key.id || ''),
    sender_id: senderId,
    sender_id_alt: senderIdAlt,
    sender_name: String(waMessage.pushName || ''),
    sender_username: '',
    text,
    voice_audio_base64: voice ? voice.audio : null,
    voice_mime_type: voice ? voice.mimeType : null,
    posted_at: postedAt,
    is_group: isGroup,
    is_channel: false,
    is_private: kind === 'private',
  }
}

export { buildMessageEvent, destinationKind, downloadVoiceNote }
