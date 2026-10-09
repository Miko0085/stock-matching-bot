'use strict';

// Reuses the exact same pure hashing function as the old n8n pipeline
// (src/core/content-dedup.js, ADR-021) so both systems can still recognize
// each other's rows in the shared matching_dubai.match_runs.content_hash column.
// This file only computes the key; the actual "have we seen this
// recently" check is a repository call (a real side effect), kept
// separate so the hash itself stays a pure, unit-testable function.
//
// P1.5 release-blocker fix: the OLD n8n pipeline's identity component is
// the sender's DISPLAY NAME (author_name) -- not stable identity. Two
// different people can share a display name (or one person can vary
// theirs -- capitalization, an added emoji, a name change), producing
// false-duplicate collisions or false NON-duplicates purely from string
// drift, unrelated to whether it's genuinely the same requester. This
// service instead prefers the most stable identity actually available on
// the UnifiedRawMessage, in priority order: provider-issued sender_id,
// then sender_id_alt (WhatsApp LID resolution), then a resolved contact
// URL, and only falls back to the display name when none of those exist.
// Trade-off, disclosed rather than silent: a message thread that existed
// before this service's cutover, previously deduped by n8n purely via
// display name, will not hash identically here going forward for a
// sender whose stable ID we now have -- an intentional, one-time
// consistency cost in exchange for correct identity going forward.
//
// Deliberately does NOT include account_id (which of OUR OWN accounts
// observed the message): a provider-issued sender_id is already globally
// unique on that provider (the same Telegram user_id is the same real
// person no matter which of our accounts is in a group with them), so
// mixing in account_id only fractures one real buyer's identity into
// several depending on which of our accounts happened to see them post --
// exactly backwards from this gate's stated job of catching the same
// buyer's request cross-posted to several groups. CONFIRMED LIVE
// INCIDENT (2026-09-25, see event-dedup.js's computeEventKey comment for
// the paired event-level symptom): this is the reason this content-hash
// gate also failed to catch a cross-account duplicate of the same
// physical message, not just a cross-posted one.
const { computeContentHash } = require('../../../src/core/content-dedup');

function computeDedupKey(unifiedRawMessage) {
  const stableIdentity =
    unifiedRawMessage.sender_id ||
    unifiedRawMessage.sender_id_alt ||
    unifiedRawMessage.author_contact ||
    unifiedRawMessage.author_name ||
    '';

  const identity = [unifiedRawMessage.provider, stableIdentity].filter(Boolean).join(':');

  return computeContentHash({
    text: unifiedRawMessage.original_text,
    authorName: identity,
  });
}

module.exports = { computeDedupKey };
