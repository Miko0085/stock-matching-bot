'use strict';

const DIVIDER = '━━━━━━━━━━━━━━━━━━━━━';

function formatPrice(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  return Number(value).toLocaleString('en-US');
}

function formatBedrooms(bedrooms) {
  if (bedrooms === null || bedrooms === undefined) return null;
  return bedrooms === 0 ? 'Studio' : `${bedrooms}BED`;
}

// "Apartment - 2BED", "Villa - Studio", "Apartment" (bedrooms unknown), or
// null if neither is known.
function formatTypeAndBeds(propertyType, bedrooms) {
  const beds = formatBedrooms(bedrooms);
  if (propertyType && beds) return `${propertyType} - ${beds}`;
  return propertyType || beds || null;
}

function formatBudget(budgetMin, budgetMax) {
  const min = formatPrice(budgetMin);
  const max = formatPrice(budgetMax);
  if (min && max) return `Budget: ${min} - ${max} AED`;
  if (max) return `Budget: up to ${max} AED`;
  if (min) return `Budget: from ${min} AED`;
  return 'Budget: not specified';
}

function section(title, lines) {
  const body = lines.filter(Boolean).join('\n');
  return `${title}\n${body}`;
}

// One self-contained, scannable message per successful match — side by side
// comparison of the matched stock ("YOUR LISTING") against the accepted
// request ("THEIR REQUIREMENT"), plus score/status and traceability info.
// Never batches multiple matches into one message, so length limits are a
// non-issue in practice; "(index of total)" still lets every match carry its
// place in the full result set even though each ships as its own message —
// AGENTS.md's "never omit a successful match" holds either way.
function buildMatchMessage({
  sourceMessageId,
  sourceUrl = null,
  groupName = null,
  authorName = null,
  authorContact = null,
  normalizedRequest = {},
  entry,
  index,
  total,
  dashboardUrl = null,
}) {
  const { stock, score, status } = entry;
  const statusLabel = status.replace('_', ' ');

  const lines = [
    `🔍 MATCH FOUND (${index} of ${total}) — ${statusLabel} ${score.total}/100`,
    `Request: ${sourceMessageId}`,
    DIVIDER,
    '',
    section('📤 STOCK:', [
      `🆔 ${stock.stock_id}`,
      stock.building ? `🏢 ${stock.building}` : null,
      `📍 ${stock.area || 'Unknown area'}`,
      formatTypeAndBeds(stock.property_type, stock.bedrooms) ? `🏠 ${formatTypeAndBeds(stock.property_type, stock.bedrooms)}` : null,
      formatPrice(stock.selling_price) ? `💰 ${formatPrice(stock.selling_price)} AED` : null,
      (stock.broker || stock.broker_contact) ? `👤 ${[stock.broker, stock.broker_contact].filter(Boolean).join(' — ')}` : null,
    ]),
    '',
    '↕️ matched with ↕️',
    '',
    section('🎯 REQUEST:', [
      `📍 ${normalizedRequest.area || 'Not specified'}`,
      formatTypeAndBeds(normalizedRequest.propertyType, normalizedRequest.bedrooms) ? `🏠 ${formatTypeAndBeds(normalizedRequest.propertyType, normalizedRequest.bedrooms)}` : null,
      `💰 ${formatBudget(normalizedRequest.budgetMin, normalizedRequest.budgetMax)}`,
      groupName ? `👥 ${groupName}` : null,
      // Captured once at message-arrival time upstream (ADR-022) — never
      // re-resolved later, since the source message/sender is not
      // guaranteed to stay resolvable. `authorName` is always shown when
      // known, even without a clickable contact — a genuine fallback for
      // Telegram users with no public @username and WhatsApp senders
      // whose phone is hidden behind an unresolved LID (a real WhatsApp
      // privacy limitation, not something we can look up around): a name
      // at least lets a human search the source group manually.
      authorName ? `🙋 ${authorName}` : null,
      authorContact ? `📞 ${authorContact}` : null,
    ]),
    DIVIDER,
  ];

  if (sourceUrl) lines.push(`Original request: ${sourceUrl}`);
  if (dashboardUrl) lines.push(`Dashboard: ${dashboardUrl}`);

  return lines.filter((l) => l !== null).join('\n');
}

// Never truncates: one message per successful match, all of them, ordered
// best-score-first (successfulMatches is assumed pre-sorted by matcher.js).
function buildTelegramMessages({
  sourceMessageId,
  sourceUrl = null,
  groupName = null,
  authorName = null,
  authorContact = null,
  normalizedRequest = {},
  successfulMatches = [],
  dashboardUrl = null,
}) {
  const total = successfulMatches.length;
  return successfulMatches.map((entry, i) =>
    buildMatchMessage({
      sourceMessageId,
      sourceUrl,
      groupName,
      authorName,
      authorContact,
      normalizedRequest,
      entry,
      index: i + 1,
      total,
      dashboardUrl,
    })
  );
}

module.exports = { buildTelegramMessages, buildMatchMessage, formatPrice, formatBedrooms, formatBudget };
