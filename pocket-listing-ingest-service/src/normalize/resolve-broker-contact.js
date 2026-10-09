'use strict';

// WhatsApp's LID (Linked ID) privacy system frequently hides the real
// phone number behind an opaque `<id>@lid` sender_id -- whatsapp-worker
// resolves it when it can via Baileys' local lidMapping cache and
// forwards the result as sender_id_alt (a `<phone>@s.whatsapp.net`-shaped
// value, or a bare phone number). There is no way to force a resolution
// the worker doesn't already have.
//
// Deliberately a small, standalone copy, not imported from
// dubai-lead-matching-service/src/adapters/whatsapp-adapter.js (which has
// the identical logic) -- this service's own isolation rule (see
// src/services/pipeline.js's own comment) is that it never imports from
// any lead-matching contour, the same direction AGENTS.md section 0
// already enforces between the contours themselves.
//
// 2026-10-08 audit finding: stock rows created by this service had
// broker/broker_contact both null -- the WhatsApp message's own sender
// (the person who posted the listing in the group) was never mapped onto
// those columns at all.
function isLid(id) {
  return Boolean(id) && String(id).endsWith('@lid');
}

function extractPhoneDigits(value) {
  if (!value) return null;
  const digits = String(value).split('@')[0].replace(/[^0-9]/g, '');
  return digits.length >= 8 ? digits : null;
}

// A LID's numeric-looking payload is an opaque internal identifier, never
// a phone number, no matter how many digits it has -- only ever extract a
// phone from an identifier that is NOT itself a LID.
function resolveBrokerContact(senderId, senderIdAlt) {
  const candidates = [senderIdAlt, senderId].filter((id) => id && !isLid(id));
  for (const candidate of candidates) {
    const phone = extractPhoneDigits(candidate);
    if (phone) return `https://wa.me/${phone}`;
  }
  return null;
}

module.exports = { resolveBrokerContact };
