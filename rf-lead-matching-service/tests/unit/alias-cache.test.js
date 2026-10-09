'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadAliasIndex, resolveAlias } = require('../../src/matching/alias-cache');
const { buildAliasIndex } = require('../../../src/core/aliases');
const { DISTRICT_ALIASES, EXCEL_VERIFIED_COMPLEX_ALIASES } = require('../../scripts/seed-moscow-location-aliases');

function fakePool(rows) {
  return { query: async () => ({ rows }) };
}

test('loadAliasIndex adapts matching_moscow.location_aliases rows into the shared engine\'s expected shape', async () => {
  const pool = fakePool([
    { alias_type: 'district', alias_normalized: 'юзао', canonical_value: 'Юго-Западный административный округ' },
    { alias_type: 'complex', alias_normalized: 'вайнхаус', canonical_value: 'Wine House' },
  ]);
  const index = await loadAliasIndex(pool);
  const districtHit = resolveAlias('district', 'ЮЗАО', index);
  assert.equal(districtHit.resolved, true);
  assert.equal(districtHit.value, 'Юго-Западный административный округ');

  const complexHit = resolveAlias('complex', 'вайн хаус', index);
  assert.equal(complexHit.resolved, true);
  assert.equal(complexHit.value, 'Wine House');
});

test('an unresolved value is returned as-is, never guessed', async () => {
  const pool = fakePool([{ alias_type: 'district', alias_normalized: 'юзао', canonical_value: 'ЮЗАО канонический' }]);
  const index = await loadAliasIndex(pool);
  const miss = resolveAlias('district', 'Совершенно другой район', index);
  assert.equal(miss.resolved, false);
  assert.equal(miss.value, 'Совершенно другой район');
});

test('empty alias table produces an empty index without throwing', async () => {
  const pool = fakePool([]);
  const index = await loadAliasIndex(pool);
  const result = resolveAlias('district', 'ЮЗАО', index);
  assert.equal(result.resolved, false);
});

// ---- Excel cross-reference aliases (2026-09-29) --------------------------
// Regression coverage for scripts/seed-moscow-location-aliases.js's own
// hardcoded data constants -- built straight from the same arrays the seed
// script inserts into production, never a live DB, so this can never drift
// silently out of sync with what actually gets seeded.
function indexFromSeedData() {
  const rows = [
    ...DISTRICT_ALIASES.map((a) => ({ type: 'district', alias: a.alias, canonical: a.canonical })),
    ...EXCEL_VERIFIED_COMPLEX_ALIASES.map((a) => ({ type: 'complex', alias: a.alias, canonical: a.canonical })),
  ];
  return buildAliasIndex(rows);
}

test('Excel-verified complex aliases resolve to the exact real stock complex spelling', () => {
  const index = indexFromSeedData();
  assert.equal(resolveAlias('complex', 'Династия', index).value, 'Династия');
  assert.equal(resolveAlias('complex', 'Царская площадь', index).value, 'Царская площадь');
  // Case-normalized real stock spelling differs from the Excel's own casing.
  assert.equal(resolveAlias('complex', 'Символ', index).value, 'СИМВОЛ');
  assert.equal(resolveAlias('complex', 'зиларт', index).value, 'ЗИЛАРТ');
});

test('ТиНАО/Новая Москва district aliases resolve to real stock district values, per okrug not per raion', () => {
  const index = indexFromSeedData();
  assert.equal(resolveAlias('district', 'ТиНАО', index).value, 'Новомосковский');
  assert.equal(resolveAlias('district', 'Новая Москва', index).value, 'Новомосковский');
  assert.equal(resolveAlias('district', 'Коммунарка', index).value, 'Новомосковский');
  assert.equal(resolveAlias('district', 'Троицк', index).value, 'Троицкий');
});

test('known ambiguous/unsafe Excel matches were deliberately excluded, never guessed', () => {
  // Headliner and RED7 each have two conflicting real stock `complex`
  // spellings (with/without a parenthetical transliteration) for what
  // looks like the same building -- resolving that ambiguity isn't this
  // script's job, so neither was added as a new alias here (Headliner's
  // alt spelling is already covered by an existing, earlier-seeded alias;
  // adding a second one pointing elsewhere would be a silent guess).
  // Rotterdam's real stock value contains an invisible LRM character that
  // couldn't be hand-transcribed reliably byte-for-byte.
  const aliasTexts = EXCEL_VERIFIED_COMPLEX_ALIASES.map((a) => a.alias.toLowerCase());
  assert.ok(!aliasTexts.includes('headliner'));
  assert.ok(!aliasTexts.includes('red7'));
  assert.ok(!aliasTexts.includes('rotterdam'));
});
