'use strict';

// Canonical identity key for a broker's phone contact, shared by the
// one-time backfill script, the live broker-notifier, and the phone field
// sent to whatsapp-worker's /whatsapp/send. stock_inventory.broker_contact
// is free text in production (confirmed: "+971 50 687 3050" and
// "+971522245787" differ only in formatting, never in digit content) --
// stripping to bare digits is the natural, lossless canonical form.
function normalizePhoneDigits(raw) {
  if (raw === null || raw === undefined) return null;
  const digits = String(raw).replace(/\D/g, '');
  return digits || null;
}

module.exports = { normalizePhoneDigits };
