'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateRouteModes } = require('../../src/sources/source-repository');

// Multi-route selection (2026-10-06, migration 0041): this is the
// application-layer copy of the DB's own `source_routes_route_modes_valid`
// CHECK constraint -- two independent layers agreeing is the point (same
// discipline as config-validation.js's isLocationKey for `location_*`
// settings), not redundancy to trim.

test('validateRouteModes: a single real market is accepted as-is', () => {
  const result = validateRouteModes(['DUBAI']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.routeModes, ['DUBAI']);
});

test('validateRouteModes: any combination of real markets is accepted (the whole point of this feature)', () => {
  const result = validateRouteModes(['DUBAI', 'RF', 'SAUDI', 'ABU_DHABI']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.routeModes.sort(), ['ABU_DHABI', 'DUBAI', 'RF', 'SAUDI']);
});

test('validateRouteModes: duplicate labels are deduped', () => {
  const result = validateRouteModes(['DUBAI', 'DUBAI', 'RF']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.routeModes.sort(), ['DUBAI', 'RF']);
});

test('validateRouteModes: an empty array defaults to NONE, never an empty route_modes row', () => {
  const result = validateRouteModes([]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.routeModes, ['NONE']);
});

test('validateRouteModes: AUTO alone is accepted', () => {
  assert.deepEqual(validateRouteModes(['AUTO']), { ok: true, routeModes: ['AUTO'] });
});

test('validateRouteModes: NONE alone is accepted', () => {
  assert.deepEqual(validateRouteModes(['NONE']), { ok: true, routeModes: ['NONE'] });
});

test('validateRouteModes: AUTO combined with a real market is rejected', () => {
  const result = validateRouteModes(['AUTO', 'DUBAI']);
  assert.equal(result.ok, false);
  assert.match(result.error, /AUTO\/NONE/);
});

test('validateRouteModes: NONE combined with a real market is rejected', () => {
  const result = validateRouteModes(['NONE', 'RF']);
  assert.equal(result.ok, false);
});

test('validateRouteModes: AUTO and NONE together is rejected (both are sentinels, never coexist)', () => {
  const result = validateRouteModes(['AUTO', 'NONE']);
  assert.equal(result.ok, false);
});

test('validateRouteModes: an unknown label is rejected, never silently dropped or passed through', () => {
  const result = validateRouteModes(['DUBAI', 'MARS']);
  assert.equal(result.ok, false);
  assert.match(result.error, /MARS/);
});

test('validateRouteModes: BOTH is retired -- no longer a recognized label', () => {
  const result = validateRouteModes(['BOTH']);
  assert.equal(result.ok, false);
});

test('validateRouteModes: a bare string (not an array) is still handled defensively', () => {
  const result = validateRouteModes('DUBAI');
  assert.equal(result.ok, true);
  assert.deepEqual(result.routeModes, ['DUBAI']);
});

test('validateRouteModes: falsy/empty entries inside the array are filtered out before validation', () => {
  const result = validateRouteModes(['', 'DUBAI', null]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.routeModes, ['DUBAI']);
});
