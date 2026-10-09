'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildNotificationMessages, buildHeaderText, formatMatchEntry, chunkMatchedStock, buildQualifiedNoMatchMessage, buildNeedsCriteriaMessage } = require('../../src/notifications/render');

function makeMatch(overrides = {}) {
  return { building: 'Peninsula Five', project_community: null, area: 'Business Bay', bedrooms: 2, selling_price: 2400000, score: 100, ...overrides };
}

test('TZ 108/110: original_text is preserved verbatim in the header, including line breaks/punctuation/emoji', () => {
  const originalText = 'Looking for my client:\n2BR in Business Bay 🔥\nBudget up to AED 2.5M!!\n"Cash buyer"';
  const header = buildHeaderText({ requestId: 'r1', originalText, provider: 'telegram', groupName: 'G', sourceUrl: 'https://t.me/x/1' });
  assert.ok(header.includes(originalText));
});

test('TZ 111: a clickable link is included when source_url exists', () => {
  const header = buildHeaderText({ requestId: 'r1', originalText: 'hi', provider: 'telegram', groupName: 'G', sourceUrl: 'https://t.me/example/308394' });
  assert.ok(header.includes('https://t.me/example/308394'));
});

test('TZ 111/112: no source_url -> explicit "unavailable" line, never a silently missing field', () => {
  const header = buildHeaderText({ requestId: 'r1', originalText: 'hi', provider: 'whatsapp', groupName: null, sourceUrl: null });
  assert.ok(header.includes('Original message link: unavailable'));
});

test('requester name and contact are rendered in a REQUESTER section when both are known', () => {
  const header = buildHeaderText({
    requestId: 'r1', originalText: 'hi', provider: 'telegram', groupName: 'G', sourceUrl: 'https://t.me/x/1',
    requesterName: 'Anna', requesterContactUrl: 'https://t.me/anna_ivanova',
  });
  assert.ok(header.includes('REQUESTER'));
  assert.ok(header.includes('Anna'));
  assert.ok(header.includes('https://t.me/anna_ivanova'));
});

test('requester name is shown even without a resolvable contact (no public @username)', () => {
  const header = buildHeaderText({
    requestId: 'r1', originalText: 'hi', provider: 'telegram', groupName: 'G', sourceUrl: null,
    requesterName: 'Anna', requesterContactUrl: null,
  });
  assert.ok(header.includes('REQUESTER'));
  assert.ok(header.includes('Anna'));
});

test('no requester name and no contact -> REQUESTER section omitted entirely, never a placeholder', () => {
  const header = buildHeaderText({ requestId: 'r1', originalText: 'hi', provider: 'telegram', groupName: 'G', sourceUrl: null });
  assert.ok(!header.includes('REQUESTER'));
});

test('no public @username but a Telegram sender id is known -> tg://user?id= used as a direct-message fallback', () => {
  const header = buildHeaderText({
    requestId: 'r1', originalText: 'hi', provider: 'telegram', groupName: 'G', sourceUrl: null,
    requesterName: 'Art', requesterContactUrl: null, requesterSenderId: '123456789',
  });
  assert.ok(header.includes('REQUESTER'));
  assert.ok(header.includes('Art'));
  assert.ok(header.includes('tg://user?id=123456789'));
});

test('a real @username contact always wins over the tg://user?id= fallback', () => {
  const header = buildHeaderText({
    requestId: 'r1', originalText: 'hi', provider: 'telegram', groupName: 'G', sourceUrl: null,
    requesterName: 'Anna', requesterContactUrl: 'https://t.me/anna_ivanova', requesterSenderId: '999',
  });
  assert.ok(header.includes('https://t.me/anna_ivanova'));
  assert.ok(!header.includes('tg://user?id='));
});

test('the tg://user?id= fallback is never used for WhatsApp -- its sender id is not a Telegram user id', () => {
  const header = buildHeaderText({
    requestId: 'r1', originalText: 'hi', provider: 'whatsapp', groupName: 'G', sourceUrl: null,
    requesterName: 'Anna', requesterContactUrl: null, requesterSenderId: '971501234567',
  });
  assert.ok(header.includes('Anna'));
  assert.ok(!header.includes('tg://'));
});

test('TZ 74/107: source label reflects the real provider (Telegram/WhatsApp)', () => {
  assert.ok(buildHeaderText({ requestId: 'r1', originalText: 'x', provider: 'telegram', sourceUrl: null }).includes('Telegram'));
  assert.ok(buildHeaderText({ requestId: 'r1', originalText: 'x', provider: 'whatsapp', sourceUrl: null }).includes('WhatsApp'));
});

test('every message carries the request_id (TZ 113)', () => {
  const messages = buildNotificationMessages({
    requestId: 'req-123',
    originalText: 'hi',
    provider: 'telegram',
    groupName: 'G',
    sourceUrl: 'https://t.me/x/1',
    matches: [makeMatch(), makeMatch({ building: 'Executive Towers' })],
    maxMessageLength: 3800,
  });
  for (const m of messages) assert.ok(m.includes('req-123'));
});

test('TZ 114: all matches are present, never truncated to Top-N', () => {
  const matches = Array.from({ length: 9 }, (_, i) => makeMatch({ building: `Tower ${i}` }));
  const messages = buildNotificationMessages({ requestId: 'r', originalText: 'hi', provider: 'telegram', sourceUrl: null, matches, maxMessageLength: 3800 });
  const combined = messages.join('\n');
  for (let i = 0; i < 9; i += 1) assert.ok(combined.includes(`Tower ${i}`));
});

test('TZ 113: long stock lists are chunked across multiple messages without losing any entry', () => {
  const matches = Array.from({ length: 40 }, (_, i) => makeMatch({ building: `Tower Number ${i} With A Fairly Long Name` }));
  const entries = matches.map((m, i) => formatMatchEntry(m, i + 1));
  const messages = chunkMatchedStock(entries, { maxLength: 500, requestId: 'r', startingPartNumber: 2 });
  assert.ok(messages.length > 1, 'expected more than one chunk for 40 verbose entries at a 500-char limit');
  const combined = messages.join('\n');
  for (let i = 0; i < 40; i += 1) assert.ok(combined.includes(`Tower Number ${i} With A Fairly Long Name`));
  for (const m of messages) assert.ok(m.length <= 500 + 200); // generous slack for the trailing request-id line
});

test('a message with no matches yields only the header (no empty "MATCHED STOCK" block)', () => {
  const messages = buildNotificationMessages({ requestId: 'r', originalText: 'hi', provider: 'telegram', sourceUrl: null, matches: [], maxMessageLength: 3800 });
  assert.equal(messages.length, 1);
  assert.doesNotMatch(messages[0], /MATCHED STOCK/);
});

test('formatMatchEntry includes location, bedrooms, price, and score', () => {
  const entry = formatMatchEntry(makeMatch({ bedrooms: 0 }), 1);
  assert.match(entry, /Peninsula Five/);
  assert.match(entry, /Studio/);
  assert.match(entry, /2,400,000/);
  assert.match(entry, /Match score: 100/);
});

test('formatMatchEntry falls back through building -> project_community -> area', () => {
  assert.match(formatMatchEntry(makeMatch({ building: null, project_community: 'The Edge' }), 1), /The Edge/);
  assert.match(formatMatchEntry(makeMatch({ building: null, project_community: null, area: 'Business Bay' }), 1), /Business Bay/);
});

test('CONFIRMED LIVE INCIDENT (2026-09-25): a RENT_YEARLY match shows annual_rent, not the always-null selling_price, labeled as RENT', () => {
  const entry = formatMatchEntry(
    makeMatch({ selling_price: null, annual_rent: 84000, transaction_type: 'RENT_YEARLY' }),
    1
  );
  assert.match(entry, /AED 84,000\/year \(RENT\)/);
  assert.doesNotMatch(entry, /Match score: 100\n$/); // sanity: not silently missing the price line entirely
});

test('a SALE match (or one with no transaction_type at all) still reads selling_price exactly as before', () => {
  const withType = formatMatchEntry(makeMatch({ selling_price: 2400000, transaction_type: 'SALE' }), 1);
  assert.match(withType, /AED 2,400,000/);
  assert.doesNotMatch(withType, /RENT/);

  const noType = formatMatchEntry(makeMatch({ selling_price: 2400000 }), 1);
  assert.match(noType, /AED 2,400,000/);
});

test('a RENT_YEARLY row with no annual_rent on record shows no price line at all, never a placeholder or the wrong field', () => {
  const entry = formatMatchEntry(makeMatch({ selling_price: null, annual_rent: null, transaction_type: 'RENT_YEARLY' }), 1);
  assert.doesNotMatch(entry, /AED/);
});

test('an unusually long original_text still gets through completely, split rather than truncated', () => {
  const longText = 'Looking for a villa.\n'.repeat(400); // forces the header well past any realistic maxMessageLength
  const messages = buildNotificationMessages({ requestId: 'r', originalText: longText, provider: 'telegram', sourceUrl: null, matches: [], maxMessageLength: 500 });
  const combinedLength = messages.map((m) => m.replace(/\n\nRequest: r \(part \d+\/\d+\)$/, '')).join('').length;
  assert.ok(combinedLength >= longText.length - 5); // allow trivial whitespace-join differences, never a real content loss
});

// Qualified-buyer visibility (spec sections 34-39): human-readable, never
// fakes a match -- these are for a real NO_MATCH/INSUFFICIENT_CRITERIA
// outcome only.
function makeStructuredRequest(overrides = {}) {
  return {
    transaction_type: 'SALE',
    areas: ['Dubai Silicon Oasis', 'Bur Dubai'],
    project: null,
    building: null,
    property_type: 'Apartment',
    bedrooms_min: 3,
    bedrooms_max: 4,
    budget_min: null,
    budget_max: 6000000,
    furnishing: null,
    ...overrides,
  };
}

test('buildQualifiedNoMatchMessage: uses the QUALIFIED BUYER header, includes criteria and per-location resolution status', () => {
  const message = buildQualifiedNoMatchMessage({
    requestId: 'r1',
    originalText: 'Looking for 3-4BR in DSO or Bur Dubai, up to 6M',
    provider: 'telegram',
    groupName: 'Dubai Buyers',
    sourceUrl: 'https://t.me/x/1',
    structuredRequest: makeStructuredRequest(),
    noMatchReason: 'no_stock_in_area',
    locationDiagnostics: { requested: ['Dubai Silicon Oasis', 'Bur Dubai'], resolved: ['Dubai Silicon Oasis'], unresolved: ['Bur Dubai'] },
  });
  assert.match(message, /🟡 QUALIFIED BUYER — NO CURRENT STOCK/);
  assert.match(message, /Looking for 3-4BR in DSO or Bur Dubai, up to 6M/);
  assert.match(message, /Bedrooms: 3-4BR/);
  assert.match(message, /Budget: up to AED 6,000,000/);
  assert.match(message, /✓ Dubai Silicon Oasis \(resolved\)/);
  assert.match(message, /✗ Bur Dubai \(not recognized\)/);
  assert.match(message, /Reason: no_stock_in_area/);
  assert.match(message, /Request: r1/);
});

test('buildQualifiedNoMatchMessage: includes the requester when known', () => {
  const message = buildQualifiedNoMatchMessage({
    requestId: 'r1',
    originalText: 'x',
    provider: 'telegram',
    sourceUrl: null,
    structuredRequest: makeStructuredRequest(),
    noMatchReason: 'over_budget',
    locationDiagnostics: { requested: [], resolved: [], unresolved: [] },
    requesterName: 'Anna',
    requesterContactUrl: 'https://t.me/anna_ivanova',
  });
  assert.match(message, /REQUESTER/);
  assert.match(message, /Anna/);
  assert.match(message, /https:\/\/t\.me\/anna_ivanova/);
});

test('buildQualifiedNoMatchMessage: never claims a match -- MATCHED STOCK section never appears', () => {
  const message = buildQualifiedNoMatchMessage({
    requestId: 'r1',
    originalText: 'x',
    provider: 'telegram',
    sourceUrl: null,
    structuredRequest: makeStructuredRequest(),
    noMatchReason: 'over_budget',
    locationDiagnostics: { requested: ['Dubai Silicon Oasis'], resolved: ['Dubai Silicon Oasis'], unresolved: [] },
  });
  assert.doesNotMatch(message, /MATCHED STOCK/);
  assert.doesNotMatch(message, /NEW BUYER MATCH/);
});

test('buildNeedsCriteriaMessage: uses the NEEDS MORE CRITERIA header and lists what is missing', () => {
  const message = buildNeedsCriteriaMessage({
    requestId: 'r2',
    originalText: 'Looking for a villa, budget up to 5M, distress only',
    provider: 'whatsapp',
    sourceUrl: null,
    structuredRequest: makeStructuredRequest({ areas: [], property_type: 'Villa', bedrooms_min: null, bedrooms_max: null, budget_max: 5000000 }),
    noMatchReason: 'location_unspecified',
    missingRequiredFields: [],
  });
  assert.match(message, /🟠 BUYER LEAD — NEEDS MORE CRITERIA/);
  assert.match(message, /Reason: location_unspecified/);
  assert.match(message, /Request: r2/);
});

test('buildNeedsCriteriaMessage: includes the requester when known', () => {
  const message = buildNeedsCriteriaMessage({
    requestId: 'r2',
    originalText: 'x',
    provider: 'whatsapp',
    sourceUrl: null,
    structuredRequest: makeStructuredRequest(),
    noMatchReason: 'location_unspecified',
    missingRequiredFields: [],
    requesterName: 'Anna',
    requesterContactUrl: null,
  });
  assert.match(message, /REQUESTER/);
  assert.match(message, /Anna/);
});

test('buildNeedsCriteriaMessage: falls back to "location" when missingRequiredFields is empty/absent', () => {
  const message = buildNeedsCriteriaMessage({
    requestId: 'r3',
    originalText: 'x',
    provider: 'telegram',
    sourceUrl: null,
    structuredRequest: makeStructuredRequest({ areas: [] }),
    noMatchReason: 'location_unspecified',
    missingRequiredFields: [],
  });
  assert.match(message, /Missing for automatic matching: location/);
});
