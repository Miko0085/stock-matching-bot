'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeRankingScore, locationScore, priceScore } = require('../../src/matching/scoring');

test('locationScore: complex scores higher than district', () => {
  assert.equal(locationScore('complex'), 100);
  assert.equal(locationScore('district'), 85);
  assert.equal(locationScore(null), null);
});

test('priceScore: at/under budget = 100, 0-5% over = 75, 5-10% over = 50', () => {
  assert.equal(priceScore({ budget_max: 20000000 }, { price: 19000000 }), 100);
  assert.equal(priceScore({ budget_max: 20000000 }, { price: 20800000 }), 75);
  assert.equal(priceScore({ budget_max: 20000000 }, { price: 21500000 }), 50);
  assert.equal(priceScore({ budget_max: null }, { price: 99999999 }), 100, 'floor-only already passed the hard filter');
});

test('computeRankingScore: only ACTIVE criteria (per hard-filters output) count toward the weighted average', () => {
  const request = { budget_max: 20000000 };
  const stock = { price: 20000000 };
  const filters = {
    location: { active: true, passes: true },
    price: { active: true, passes: true },
    rooms: { active: false, passes: true },
    propertyType: { active: false, passes: true },
  };
  const result = computeRankingScore({ request, stock, filters, locationLevel: 'complex' });
  // Only location(50, score 100) + price(30, score 100) active -> total 100.
  assert.equal(result.total, 100);
  assert.ok(!result.components.rooms);
  assert.ok(!result.components.propertyType);
});

test('computeRankingScore: a district-level match with all 4 criteria active weights correctly', () => {
  const request = { budget_max: 20000000 };
  const stock = { price: 20000000 };
  const filters = {
    location: { active: true, passes: true },
    price: { active: true, passes: true },
    rooms: { active: true, passes: true },
    propertyType: { active: true, passes: true },
  };
  const result = computeRankingScore({ request, stock, filters, locationLevel: 'district' });
  // location: 50*85, price: 30*100, rooms: 15*100, propertyType: 5*100 -> weightedSum / 100
  const expected = Math.round((50 * 85 + 30 * 100 + 15 * 100 + 5 * 100) / 100);
  assert.equal(result.total, expected);
});

test('computeRankingScore: zero active criteria never divides by zero', () => {
  const filters = {
    location: { active: false }, price: { active: false }, rooms: { active: false }, propertyType: { active: false },
  };
  const result = computeRankingScore({ request: {}, stock: {}, filters, locationLevel: null });
  assert.equal(result.total, 0);
});
