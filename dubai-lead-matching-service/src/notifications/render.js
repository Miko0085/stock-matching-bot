'use strict';

const { priceFieldForStock } = require('../matching/transaction-semantics');

// Pure rendering only -- no HTTP, no side effects (TZ 107: "Matching core
// не содержит Telegram Bot API calls" -- this module still doesn't; the
// actual send lives in telegram-sender.js). Builds the exact contract TZ
// 108-116 requires:
//   1. original_text 1:1 -- never replaced by an AI summary/rewrite/
//      translation/paraphrase (TZ 108, 110, 129).
//   2. source (provider + group name)
//   3. a clickable link to the original message when source_url exists,
//      otherwise an explicit "unavailable" line (TZ 111-112) -- never a
//      silently missing field.
//   4. ALL matched stock, never Top-N (TZ 114).
//   5. score/explanation per match.
// Chunked without losing text or matches when the combined length exceeds
// `maxMessageLength` (TZ 113) -- every part carries the same request_id
// (TZ 113) so a human reading Telegram can tell which parts belong
// together.

function formatPrice(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  return Number(value).toLocaleString('en-US');
}

function formatBedrooms(bedrooms) {
  if (bedrooms === null || bedrooms === undefined) return null;
  return bedrooms === 0 ? 'Studio' : `${bedrooms}BED`;
}

function providerLabel(provider) {
  if (provider === 'telegram') return 'Telegram';
  if (provider === 'whatsapp') return 'WhatsApp';
  return provider || 'Unknown';
}

// TZ 110: original_text displayed as close to 1:1 as possible (line
// breaks, punctuation, case, emoji, content all preserved) -- the only
// transformation allowed is safe Markdown escaping so Telegram's parse
// mode doesn't choke on stray `_`/`*`/`` ` ``/`[` characters, and even that
// must never change what's actually DISPLAYED to the reader. Using plain
// text (no parse_mode) sidesteps this entirely and is what
// telegram-sender.js does -- this function exists in case a future caller
// ever turns Markdown on.
function escapeForTelegramMarkdown(text) {
  return String(text).replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

// Captured once at message-arrival time (same posture as the older pilot's
// ADR-022) -- never re-resolved later, since the source message/sender is
// not guaranteed to stay resolvable. The name is shown whenever known, even
// without a clickable contact (a genuine fallback for Telegram users with
// no public @username and WhatsApp senders behind an unresolved LID); the
// section is omitted entirely when neither is known -- never a placeholder.
//
// When there's no public @username (author_contact is null) but the raw
// numeric Telegram user id is known, tg://user?id=<id> is used as a
// best-effort direct-message link. This is NOT a universal link -- Telegram
// only resolves it for a client that already has this user as a known peer
// (in practice: the same account monitoring the source group, since it has
// already seen this sender there), same real limitation the ORIGINAL
// MESSAGE t.me/c/ link carries. Never attempted for WhatsApp: its
// author_contact is already the best resolvable contact when one exists
// (see whatsapp-adapter.js's own phone/LID resolution), and a raw
// WhatsApp sender id is not a Telegram user id.
function buildRequesterLines(requesterName, requesterContactUrl, { provider = null, requesterSenderId = null } = {}) {
  const contactLine = requesterContactUrl || (provider === 'telegram' && requesterSenderId ? `tg://user?id=${requesterSenderId}` : null);
  if (!requesterName && !contactLine) return [];
  const lines = ['', 'REQUESTER'];
  if (requesterName) lines.push(requesterName);
  if (contactLine) lines.push(contactLine);
  return lines;
}

function buildHeaderText({ requestId, originalText, provider, groupName, sourceUrl, requesterName = null, requesterContactUrl = null, requesterSenderId = null }) {
  const lines = [
    '🔥 NEW BUYER MATCH',
    '',
    'REQUEST — ORIGINAL MESSAGE',
    '',
    originalText, // 1:1, untouched (TZ 108, 110)
    '',
    'SOURCE',
    providerLabel(provider),
  ];
  if (groupName) lines.push(groupName);
  lines.push(...buildRequesterLines(requesterName, requesterContactUrl, { provider, requesterSenderId }));
  lines.push('');
  lines.push('ORIGINAL MESSAGE');
  // TZ 111: a clickable link when source_url exists; an explicit
  // "unavailable" line when it doesn't -- never silently omitted (this
  // matters most for WhatsApp, TZ 112, where a permalink usually doesn't
  // exist at all).
  lines.push(sourceUrl || 'Original message link: unavailable');
  lines.push('');
  lines.push(`Request: ${requestId}`);
  return lines.join('\n');
}

// CONFIRMED LIVE INCIDENT (2026-09-25): a request whose transaction_type
// wasn't resolved by the AI parser deliberately lets both SALE and
// RENT_YEARLY stock through as candidates (hard-filters.js) -- so a
// single MATCHED STOCK list can contain both kinds of row. Previously
// this always read match.selling_price, which is NULL on every
// RENT_YEARLY row (its real price lives in annual_rent), so a genuine
// rental match was shown with no price at all. Falls back to
// selling_price whenever transaction_type isn't 'RENT_YEARLY' -- existing
// callers that never set transaction_type/annual_rent are unaffected.
function formatMatchEntry(match, index) {
  const location = match.building || match.project_community || match.area || 'Unknown location';
  const beds = formatBedrooms(match.bedrooms);
  const isRent = match.transaction_type === 'RENT_YEARLY';
  const price = formatPrice(match[priceFieldForStock(match.transaction_type)]);
  const priceLine = price ? `AED ${price}${isRent ? '/year (RENT)' : ''}` : null;
  const lines = [
    `${index}. ${location}`,
    beds ? beds : null,
    priceLine,
    `Match score: ${match.score}`,
  ].filter(Boolean);
  return lines.join('\n');
}

// Packs whole match entries into as few messages as fit under
// `maxLength`, never splitting a single entry across two messages (an
// individual entry is always short enough to fit whole in practice) and
// never dropping one to make room (TZ 114) -- if one genuinely didn't
// fit alone, it still gets its own message rather than being cut.
function chunkMatchedStock(matchEntries, { maxLength, requestId, startingPartNumber }) {
  const messages = [];
  let current = [];
  let currentLength = 0;
  const header = 'MATCHED STOCK';

  function flush() {
    if (!current.length) return;
    const partNumber = startingPartNumber + messages.length;
    messages.push([header, '', ...current, '', `Request: ${requestId} (part ${partNumber})`].join('\n'));
    current = [];
    currentLength = 0;
  }

  for (const entry of matchEntries) {
    const entryBlockLength = entry.length + 2; // + separator
    const wouldOverflow = currentLength + entryBlockLength + header.length + requestId.length + 30 > maxLength;
    if (wouldOverflow && current.length) flush();
    current.push(entry);
    currentLength += entryBlockLength;
  }
  flush();

  return messages;
}

function buildNotificationMessages({
  requestId,
  originalText,
  provider,
  groupName,
  sourceUrl,
  matches,
  maxMessageLength = 3800,
  requesterName = null,
  requesterContactUrl = null,
  requesterSenderId = null,
}) {
  const headerText = buildHeaderText({ requestId, originalText, provider, groupName, sourceUrl, requesterName, requesterContactUrl, requesterSenderId });
  const matchEntries = matches.map((m, i) => formatMatchEntry(m, i + 1));

  // The header (with the FULL, unmodified original_text) is never
  // truncated even if it alone exceeds maxMessageLength -- TZ 110/129
  // treat 1:1 preservation as non-negotiable, ahead of length limits.
  // Telegram's own hard cap is 4096 chars; this only ever gets close for
  // an unusually long original message, an edge case worth surfacing
  // rather than silently cutting.
  const headerMessages = headerText.length <= maxMessageLength ? [headerText] : splitLongText(headerText, maxMessageLength, requestId);

  const stockMessages = matchEntries.length
    ? chunkMatchedStock(matchEntries, { maxLength: maxMessageLength, requestId, startingPartNumber: headerMessages.length + 1 })
    : [];

  return [...headerMessages, ...stockMessages];
}

// Last-resort splitter for the rare case where original_text itself is so
// long the header alone exceeds the limit -- splits on line boundaries
// where possible, never mid-word if avoidable, and never drops content.
function splitLongText(text, maxLength, requestId) {
  const lines = text.split('\n');
  const parts = [];
  let current = '';
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxLength - 40 && current) {
      parts.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);
  return parts.map((part, i) => `${part}\n\nRequest: ${requestId} (part ${i + 1}/${parts.length})`);
}

// --- Qualified-buyer visibility (spec sections 34-39) ---------------------
// Two new, feature-flagged (default OFF) notification shapes for a genuine,
// confidently-classified buyer whose outcome was NO_MATCH or
// INSUFFICIENT_CRITERIA -- never REJECTED/DUPLICATE/PARSER_ERROR (the
// eligibility check in services/pipeline.js already guarantees that only a
// confident buyer_request/sender/non-promotion/non-spam classification ever
// reaches this far, so no extra confidence check is needed here). These are
// human-readable summaries for an operator, NOT the full match_diagnostics
// JSON (that stays in the database only, per spec's "keep DB diagnostics
// fully detailed separately"). Final principle 10's anti-goal applies here
// exactly as everywhere else: these messages report a truthful outcome,
// they never claim a match that didn't happen.

function formatBedroomsRange(min, max) {
  if (min === null && max === null) return null;
  if (min === 0 && max === 0) return 'Studio';
  if (min !== null && max !== null && min === max) return `${min}BR`;
  if (min !== null && max !== null) return `${min}-${max}BR`;
  if (min !== null) return `${min}BR+`;
  return `up to ${max}BR`;
}

function formatBudgetRange(min, max) {
  const minFmt = formatPrice(min);
  const maxFmt = formatPrice(max);
  if (minFmt && maxFmt) return `AED ${minFmt} - ${maxFmt}`;
  if (maxFmt) return `up to AED ${maxFmt}`;
  if (minFmt) return `from AED ${minFmt}`;
  return null;
}

function formatCriteriaLines(structuredRequest) {
  const lines = [];
  if (structuredRequest.transaction_type) lines.push(`Transaction: ${structuredRequest.transaction_type}`);
  if (Array.isArray(structuredRequest.areas) && structuredRequest.areas.length) lines.push(`Area(s): ${structuredRequest.areas.join(', ')}`);
  if (structuredRequest.project) lines.push(`Project: ${structuredRequest.project}`);
  if (structuredRequest.building) lines.push(`Building: ${structuredRequest.building}`);
  if (structuredRequest.property_type) lines.push(`Property type: ${structuredRequest.property_type}`);
  const beds = formatBedroomsRange(structuredRequest.bedrooms_min, structuredRequest.bedrooms_max);
  if (beds) lines.push(`Bedrooms: ${beds}`);
  const budget = formatBudgetRange(structuredRequest.budget_min, structuredRequest.budget_max);
  if (budget) lines.push(`Budget: ${budget}`);
  if (structuredRequest.furnishing) lines.push(`Furnishing: ${structuredRequest.furnishing}`);
  return lines.length ? lines : ['(no specific criteria stated)'];
}

// Per-location resolution status (spec section 10-17's multi-area
// diagnostics, made human-readable) -- an unresolved option is shown, never
// silently dropped, same invariant as the underlying diagnostics.
function formatLocationLines(locationDiagnostics) {
  const requested = locationDiagnostics?.requested || [];
  if (!requested.length) return ['(no location stated)'];
  const resolvedSet = new Set(locationDiagnostics.resolved || []);
  const lines = [];
  for (const value of requested) {
    lines.push(resolvedSet.has(value) ? `✓ ${value} (resolved)` : `✗ ${value} (not recognized)`);
  }
  return lines;
}

function buildQualifiedBuyerFooter({ requestId, provider, groupName, sourceUrl, originalText, requesterName = null, requesterContactUrl = null, requesterSenderId = null }) {
  const lines = [
    'REQUEST — ORIGINAL MESSAGE',
    '',
    originalText,
    '',
    'SOURCE',
    providerLabel(provider),
  ];
  if (groupName) lines.push(groupName);
  lines.push(...buildRequesterLines(requesterName, requesterContactUrl, { provider, requesterSenderId }));
  lines.push('');
  lines.push('ORIGINAL MESSAGE');
  lines.push(sourceUrl || 'Original message link: unavailable');
  return lines;
}

// "QUALIFIED BUYER — NO CURRENT STOCK": a genuine buyer whose criteria are
// clear enough to have run the full matcher, but no ACTIVE stock survived
// (NO_MATCH). Never sent for a fake/inflated match -- this fires only
// alongside the real, persisted NO_MATCH outcome.
function buildQualifiedNoMatchMessage({ requestId, originalText, provider, groupName, sourceUrl, structuredRequest, noMatchReason, locationDiagnostics, requesterName = null, requesterContactUrl = null, requesterSenderId = null }) {
  const lines = [
    '🟡 QUALIFIED BUYER — NO CURRENT STOCK',
    '',
    ...buildQualifiedBuyerFooter({ requestId, provider, groupName, sourceUrl, originalText, requesterName, requesterContactUrl, requesterSenderId }),
    '',
    'CRITERIA',
    ...formatCriteriaLines(structuredRequest),
    '',
    'LOCATIONS',
    ...formatLocationLines(locationDiagnostics),
    '',
    `Reason: ${noMatchReason || 'no_candidates'}`,
    '',
    `Request: ${requestId}`,
  ];
  return lines.join('\n');
}

// "BUYER LEAD — NEEDS MORE CRITERIA": a genuine buyer (confidently
// classified) whose message didn't carry enough for automatic matching
// (INSUFFICIENT_CRITERIA -- e.g. no location at all, or location with none
// of budget/bedrooms/property_type). Distinct from the NO_MATCH message
// above: this buyer was never run against stock at all.
function buildNeedsCriteriaMessage({ requestId, originalText, provider, groupName, sourceUrl, structuredRequest, noMatchReason, missingRequiredFields, requesterName = null, requesterContactUrl = null, requesterSenderId = null }) {
  const lines = [
    '🟠 BUYER LEAD — NEEDS MORE CRITERIA',
    '',
    ...buildQualifiedBuyerFooter({ requestId, provider, groupName, sourceUrl, originalText, requesterName, requesterContactUrl, requesterSenderId }),
    '',
    'CRITERIA PROVIDED',
    ...formatCriteriaLines(structuredRequest),
    '',
    `Missing for automatic matching: ${missingRequiredFields && missingRequiredFields.length ? missingRequiredFields.join(', ') : 'location'}`,
    '',
    `Reason: ${noMatchReason || 'insufficient_criteria'}`,
    '',
    `Request: ${requestId}`,
  ];
  return lines.join('\n');
}

module.exports = {
  buildNotificationMessages,
  buildHeaderText,
  formatMatchEntry,
  chunkMatchedStock,
  escapeForTelegramMarkdown,
  formatPrice,
  formatBedrooms,
  buildQualifiedNoMatchMessage,
  buildNeedsCriteriaMessage,
};
