'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAiOutput } = require('../../src/parser/schema');

test('a well-formed buyer_request is parsed with all Moscow fields intact', () => {
  const { value, warnings } = parseAiOutput({
    message_class: 'buyer_request',
    demand_owner: 'sender',
    promotion: false,
    spam: false,
    transaction_type: 'SALE',
    district: 'ЮЗАО',
    complex: 'Событие',
    property_type: 'квартира',
    rooms: 3,
    budget_max: 30000000,
    confidence: 0.9,
  });
  assert.deepEqual(warnings, []);
  assert.equal(value.district, 'ЮЗАО');
  assert.equal(value.complex, 'Событие');
  assert.equal(value.rooms, 3);
  assert.equal(value.budget_max, 30000000);
});

test('transaction_type: RENT round-trips through validation same as SALE; an invalid value falls back to null', () => {
  const rent = parseAiOutput({ transaction_type: 'RENT' });
  assert.equal(rent.value.transaction_type, 'RENT');
  const bad = parseAiOutput({ transaction_type: 'GARBAGE' });
  assert.equal(bad.value.transaction_type, null);
});

test('rooms="студия" coerces to 0, "свободная планировка" coerces to null -- both distinct explicit values, never silently dropped', () => {
  const studio = parseAiOutput({ rooms: 'студия' });
  assert.equal(studio.value.rooms, 0);
  const freePlan = parseAiOutput({ rooms: 'свободная планировка' });
  assert.equal(freePlan.value.rooms, null);
});

test('rooms_sentinel is validated against the closed enum, an invalid value falls back to null with a warning', () => {
  const ok = parseAiOutput({ rooms_sentinel: 'STUDIO' });
  assert.equal(ok.value.rooms_sentinel, 'STUDIO');
  const bad = parseAiOutput({ rooms_sentinel: 'GARBAGE' });
  assert.equal(bad.value.rooms_sentinel, null);
  assert.ok(bad.warnings.includes('invalid_enum:rooms_sentinel'));
});

test('budget_min > budget_max is swapped, not silently accepted as-is', () => {
  const { value, warnings } = parseAiOutput({ budget_min: 30000000, budget_max: 15000000 });
  assert.equal(value.budget_min, 15000000);
  assert.equal(value.budget_max, 30000000);
  assert.ok(warnings.includes('budget_min_greater_than_budget_max'));
});

test('area_sqm_min/max and floor_min/max are swapped when reversed', () => {
  const area = parseAiOutput({ area_sqm_min: 100, area_sqm_max: 50 });
  assert.equal(area.value.area_sqm_min, 50);
  assert.equal(area.value.area_sqm_max, 100);
  const floor = parseAiOutput({ floor_min: 10, floor_max: 2 });
  assert.equal(floor.value.floor_min, 2);
  assert.equal(floor.value.floor_max, 10);
});

test('an unknown message_class/demand_owner falls back to "unknown", never throws', () => {
  const { value, warnings } = parseAiOutput({ message_class: 'garbage', demand_owner: 'garbage' });
  assert.equal(value.message_class, 'unknown');
  assert.equal(value.demand_owner, 'unknown');
  assert.equal(warnings.length, 2);
});

test('a completely empty/non-object input never throws, every field defaults safely', () => {
  assert.doesNotThrow(() => parseAiOutput(null));
  assert.doesNotThrow(() => parseAiOutput(undefined));
  assert.doesNotThrow(() => parseAiOutput('not an object'));
  const { value } = parseAiOutput({});
  assert.equal(value.district, null);
  assert.equal(value.rooms, null);
  assert.equal(value.cash_buyer, null);
});

test('confidence is clamped to [0,1]', () => {
  assert.equal(parseAiOutput({ confidence: 1.5 }).value.confidence, 1);
  assert.equal(parseAiOutput({ confidence: -0.5 }).value.confidence, 0);
  assert.equal(parseAiOutput({ confidence: 0.7 }).value.confidence, 0.7);
});

test('cash_buyer accepts Russian да/нет as well as true/false', () => {
  assert.equal(parseAiOutput({ cash_buyer: 'да' }).value.cash_buyer, true);
  assert.equal(parseAiOutput({ cash_buyer: 'нет' }).value.cash_buyer, false);
});
