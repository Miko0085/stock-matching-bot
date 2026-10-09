'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildAliasIndex, resolveAlias } = require('../../src/core/aliases');
const { aliasRows } = require('../../tests/fixtures/aliases');

test('BB resolves to Business Bay', () => {
  const index = buildAliasIndex(aliasRows);
  const result = resolveAlias('area', 'BB', index);
  assert.equal(result.resolved, true);
  assert.equal(result.value, 'Business Bay');
});

test('M.J.L resolves to Madinat Jumeirah Living', () => {
  const index = buildAliasIndex(aliasRows);
  const result = resolveAlias('area', 'M.J.L', index);
  assert.equal(result.resolved, true);
  assert.equal(result.value, 'Madinat Jumeirah Living');
});

test('P4 resolves to Peninsula Four as a building alias', () => {
  const index = buildAliasIndex(aliasRows);
  const result = resolveAlias('building', 'P4', index);
  assert.equal(result.resolved, true);
  assert.equal(result.value, 'Peninsula Four');
});

test('Flat resolves to Apartment as a property type alias', () => {
  const index = buildAliasIndex(aliasRows);
  const result = resolveAlias('property_type', 'Flat', index);
  assert.equal(result.resolved, true);
  assert.equal(result.value, 'Apartment');
});

test('canonical value resolves to itself even without an explicit alias row', () => {
  const index = buildAliasIndex(aliasRows);
  const result = resolveAlias('area', 'Business Bay', index);
  assert.equal(result.resolved, true);
  assert.equal(result.value, 'Business Bay');
});

test('unresolved alias retains the raw value and is diagnosable', () => {
  const index = buildAliasIndex(aliasRows);
  const result = resolveAlias('area', 'Nowhere Land', index);
  assert.equal(result.resolved, false);
  assert.equal(result.value, 'Nowhere Land');
  assert.equal(result.present, true);
});

test('absent input is not marked as an unresolved alias', () => {
  const index = buildAliasIndex(aliasRows);
  const result = resolveAlias('area', null, index);
  assert.equal(result.resolved, false);
  assert.equal(result.present, false);
  assert.equal(result.value, null);
});

test('disabled alias rows are excluded from the index', () => {
  const index = buildAliasIndex([
    { type: 'area', alias: 'BB', canonical: 'Business Bay', enabled: false },
  ]);
  const result = resolveAlias('area', 'BB', index);
  assert.equal(result.resolved, false);
});
