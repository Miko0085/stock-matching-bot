'use strict';

// Same audit class as ADR-047's Abu Dhabi prompt bug: a copy-pasted
// prompt from the wrong service/market is a real, previously-confirmed
// failure mode in this codebase. This prompt was written from scratch for
// this service, but the test still exists to catch any future accidental
// copy-paste regression.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SYSTEM_PROMPT, buildMessages } = require('../../src/parser/prompt');

test('SYSTEM_PROMPT describes the supply-side listing-extraction task, not a buyer-request classification', () => {
  assert.match(SYSTEM_PROMPT, /pocket listings/i);
  assert.match(SYSTEM_PROMPT, /is_listing/);
  assert.ok(!SYSTEM_PROMPT.includes('demand_owner'), 'this is not the buyer-request prompt');
  assert.ok(!SYSTEM_PROMPT.includes('broker_solicitation'), 'this is not the buyer-request prompt');
});

test('SYSTEM_PROMPT uses real Dubai area names as examples, never another market\'s', () => {
  assert.match(SYSTEM_PROMPT, /Business Bay|Al Barari|Dubai Creek Harbour/);
  assert.ok(!SYSTEM_PROMPT.includes('Al Reem Island'), 'Al Reem Island is an Abu Dhabi area, not Dubai');
  assert.ok(!SYSTEM_PROMPT.includes('недвижимости в Москве'), 'this is not the Moscow prompt');
});

test('SYSTEM_PROMPT names every field the user asked for', () => {
  for (const field of ['area', 'building', 'property_type', 'bedrooms', 'bathrooms', 'selling_price', 'annual_rent', 'size_sqft', 'plot_size_sqft', 'furnishing', 'view', 'distress']) {
    assert.match(SYSTEM_PROMPT, new RegExp(field), `missing field: ${field}`);
  }
});

test('buildMessages wraps the system prompt and the raw text as separate chat messages', () => {
  const messages = buildMessages('3BR in Business Bay, AED 7.75M');
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
  assert.equal(messages[1].content, '3BR in Business Bay, AED 7.75M');
});
