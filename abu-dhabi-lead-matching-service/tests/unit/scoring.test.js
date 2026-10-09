'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeRankingScore, locationScore, budgetScore } = require('../../src/matching/scoring');

test('TZ 60: location score by specificity level', () => {
  assert.equal(locationScore('building'), 100);
  assert.equal(locationScore('project'), 95);
  assert.equal(locationScore('area'), 80);
});

test('TZ 61: budget score bands', () => {
  const stockAt = (price) => ({ selling_price: price });
  assert.equal(budgetScore({ budget_max: 2500000 }, stockAt(2500000)), 100);
  assert.equal(budgetScore({ budget_max: 2500000 }, stockAt(2600000)), 75); // 4% over
  assert.equal(budgetScore({ budget_max: 2500000 }, stockAt(2700000)), 50); // 8% over
});

test('TZ 59: only active criteria count toward the weighted average -- missing ones are excluded, not zeroed', () => {
  // Only location + budget active (bedrooms/propertyType not stated) ->
  // weights 50+30=80, normalized. location(area)=80, budget(exact)=100:
  // round((80*50 + 100*30) / 80) = round(87.5) = 88.
  const filters = {
    location: { active: true, passes: true },
    budget: { active: true, passes: true },
    bedrooms: { active: false, passes: true },
    propertyType: { active: false, passes: true },
  };
  const { total, components } = computeRankingScore({
    request: { budget_max: 2500000 },
    stock: { selling_price: 2500000 },
    filters,
    locationLevel: 'area',
  });
  assert.equal(Object.keys(components).sort().join(','), 'budget,location');
  assert.equal(total, 88);
});

test('a mixed score is the correct weighted average of only the active components', () => {
  // location(area)=80 * 50, budget=75 (5% over-equivalent) * 30, total weight 80.
  const filters = {
    location: { active: true, passes: true },
    budget: { active: true, passes: true },
    bedrooms: { active: false, passes: true },
    propertyType: { active: false, passes: true },
  };
  const { total } = computeRankingScore({
    request: { budget_max: 2500000 },
    stock: { selling_price: 2600000 }, // 4% over -> budgetScore 75
    filters,
    locationLevel: 'area',
  });
  const expected = Math.round((80 * 50 + 75 * 30) / 80);
  assert.equal(total, expected);
});

test('all four criteria active and perfect -> total score 100', () => {
  const filters = {
    location: { active: true, passes: true },
    budget: { active: true, passes: true },
    bedrooms: { active: true, passes: true },
    propertyType: { active: true, passes: true },
  };
  const { total } = computeRankingScore({
    request: { budget_max: 2500000 },
    stock: { selling_price: 2500000 },
    filters,
    locationLevel: 'building',
  });
  assert.equal(total, 100);
});

test('a min-only budget (already passed the hard filter) always scores 100 -- no ceiling to be "close to"', () => {
  assert.equal(budgetScore({ budget_max: null }, { selling_price: 999999999 }), 100);
});
