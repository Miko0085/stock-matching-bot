'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildTelegramMessages, formatBudget, formatBedrooms } = require('../../src/core/telegram');
const { matchRequest } = require('../../src/core/matcher');
const { buildAliasIndex } = require('../../src/core/aliases');
const { DEFAULT_CONFIG } = require('../../src/core/config');
const { aliasRows } = require('../../tests/fixtures/aliases');
const { fiveMatchingStock, makeStock } = require('../../tests/fixtures/stock');
const { makeParsedRequest } = require('../../tests/fixtures/requests');

const aliasIndex = buildAliasIndex(aliasRows);

function matchFiveStock() {
  return matchRequest({
    parsedRequest: makeParsedRequest(),
    aliasIndex,
    stockCandidates: fiveMatchingStock,
    config: DEFAULT_CONFIG,
    stockSyncedAt: new Date().toISOString(),
  });
}

test('CRITICAL: Telegram output includes all 5 stock IDs, never Top-3', () => {
  const result = matchFiveStock();
  const messages = buildTelegramMessages({
    sourceMessageId: 'MSG-1',
    normalizedRequest: result.normalizedRequest,
    successfulMatches: result.successfulMatches,
  });
  const combined = messages.join('\n');
  for (const id of ['STK-1001', 'STK-1002', 'STK-1003', 'STK-1004', 'STK-1005']) {
    assert.ok(combined.includes(id), `expected ${id} in Telegram output`);
  }
});

test('one self-contained message per successful match — never batched', () => {
  const result = matchFiveStock();
  const messages = buildTelegramMessages({
    sourceMessageId: 'MSG-1',
    normalizedRequest: result.normalizedRequest,
    successfulMatches: result.successfulMatches,
  });
  assert.equal(messages.length, 5);
});

test('each message carries its (index of total) position', () => {
  const result = matchFiveStock();
  const messages = buildTelegramMessages({
    sourceMessageId: 'MSG-1',
    normalizedRequest: result.normalizedRequest,
    successfulMatches: result.successfulMatches,
  });
  for (let i = 0; i < messages.length; i += 1) {
    assert.ok(messages[i].includes(`(${i + 1} of 5)`), messages[i]);
  }
});

test('every message carries the source message ID', () => {
  const result = matchFiveStock();
  const messages = buildTelegramMessages({
    sourceMessageId: 'MSG-77',
    normalizedRequest: result.normalizedRequest,
    successfulMatches: result.successfulMatches,
  });
  for (const message of messages) {
    assert.ok(message.includes('MSG-77'));
  }
});

test('every message includes the original request link when available', () => {
  const result = matchFiveStock();
  const messages = buildTelegramMessages({
    sourceMessageId: 'MSG-1',
    sourceUrl: 'https://t.me/somegroup/123',
    normalizedRequest: result.normalizedRequest,
    successfulMatches: result.successfulMatches,
  });
  for (const message of messages) {
    assert.ok(message.includes('https://t.me/somegroup/123'));
  }
});

test('a message shows both the matched stock and the request side by side', () => {
  const result = matchFiveStock();
  const messages = buildTelegramMessages({
    sourceMessageId: 'MSG-1',
    groupName: 'Dubai Real Estate Group',
    normalizedRequest: result.normalizedRequest,
    successfulMatches: result.successfulMatches,
  });
  const message = messages[0];
  assert.ok(message.includes('📤 STOCK:'));
  assert.ok(message.includes('🎯 REQUEST:'));
  assert.ok(message.includes('Peninsula Four')); // stock building
  assert.ok(message.includes('Business Bay')); // shared area, appears on both sides
  assert.ok(message.includes('Dubai Real Estate Group'));
  assert.ok(message.includes('matched with'));
});

test('ADR-022: a resolved requester contact is rendered in the REQUEST section', () => {
  const result = matchFiveStock();
  const messages = buildTelegramMessages({
    sourceMessageId: 'MSG-1',
    authorContact: 'https://t.me/some_buyer',
    normalizedRequest: result.normalizedRequest,
    successfulMatches: result.successfulMatches,
  });
  for (const message of messages) {
    assert.ok(message.includes('https://t.me/some_buyer'));
  }
});

test('ADR-022: the requester name is shown even without a clickable contact (Telegram no-username / WhatsApp unresolved LID)', () => {
  const result = matchFiveStock();
  const messages = buildTelegramMessages({
    sourceMessageId: 'MSG-1',
    authorName: 'Иван',
    authorContact: null,
    normalizedRequest: result.normalizedRequest,
    successfulMatches: result.successfulMatches,
  });
  for (const message of messages) {
    assert.ok(message.includes('🙋 Иван'));
    assert.ok(!message.includes('📞'));
  }
});

test('ADR-022: no contact captured upstream is omitted entirely, not shown as a placeholder', () => {
  const result = matchFiveStock();
  const messages = buildTelegramMessages({
    sourceMessageId: 'MSG-1',
    authorContact: null,
    normalizedRequest: result.normalizedRequest,
    successfulMatches: result.successfulMatches,
  });
  for (const message of messages) {
    assert.ok(!message.includes('📞'));
  }
});

test('formatBudget renders min/max/neither correctly', () => {
  assert.equal(formatBudget(null, 2500000), 'Budget: up to 2,500,000 AED');
  assert.equal(formatBudget(2000000, null), 'Budget: from 2,000,000 AED');
  assert.equal(formatBudget(2000000, 2500000), 'Budget: 2,000,000 - 2,500,000 AED');
  assert.equal(formatBudget(null, null), 'Budget: not specified');
});

test('formatBedrooms renders Studio and NBED', () => {
  assert.equal(formatBedrooms(0), 'Studio');
  assert.equal(formatBedrooms(2), '2BED');
  assert.equal(formatBedrooms(null), null);
});

test('NO_MATCH results never appear because matcher never passes them here', () => {
  // guard against accidental misuse: a single strong match still renders correctly
  const single = [makeStock({ stock_id: 'ONLY-1' })];
  const result = matchRequest({
    parsedRequest: makeParsedRequest(),
    aliasIndex,
    stockCandidates: single,
    config: DEFAULT_CONFIG,
    stockSyncedAt: new Date().toISOString(),
  });
  const messages = buildTelegramMessages({
    sourceMessageId: 'MSG-2',
    normalizedRequest: result.normalizedRequest,
    successfulMatches: result.successfulMatches,
  });
  assert.equal(messages.length, 1);
  assert.ok(messages[0].includes('ONLY-1'));
  assert.ok(messages[0].includes('(1 of 1)'));
});
