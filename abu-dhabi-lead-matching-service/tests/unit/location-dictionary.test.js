'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildCanonicalRegistry, buildLocationDictionary } = require('../../src/matching/location-dictionary');
const { buildAliasIndex } = require('../../../src/core/aliases');

const ALIAS_ROWS = [
  { type: 'area', alias: 'BB', canonical: 'Business Bay', enabled: true },
];

test('buildCanonicalRegistry: distinct area/project/building values become known canonical entries', () => {
  const registry = buildCanonicalRegistry([
    { area: 'Dubai Marina', project_community: 'Emaar Beachfront', building: 'Address JBR' },
    { area: 'Dubai Marina', project_community: 'Emaar Beachfront', building: null },
  ]);
  assert.equal(registry.area.get('dubaimarina').canonical, 'Dubai Marina');
  assert.equal(registry.project.get('emaarbeachfront').canonical, 'Emaar Beachfront');
  assert.equal(registry.building.get('addressjbr').canonical, 'Address JBR');
});

test('buildCanonicalRegistry: never writes a fake alias -- unrelated raw text stays unresolved', () => {
  const registry = buildCanonicalRegistry([{ area: 'Dubai Marina', project_community: null, building: null }]);
  assert.equal(registry.project.size, 0);
  assert.equal(registry.area.has('somewhereelse'), false);
});

test('resolve(): prefers the alias layer over the canonical layer when both would match', () => {
  const aliasIndex = buildAliasIndex(ALIAS_ROWS);
  const canonicalRegistry = buildCanonicalRegistry([{ area: 'Business Bay', project_community: null, building: null }]);
  const dictionary = buildLocationDictionary({ aliasIndex, canonicalRegistry });

  const result = dictionary.resolve('area', 'BB');
  assert.equal(result.resolved, true);
  assert.equal(result.canonical, 'Business Bay');
  assert.equal(result.resolution_source, 'alias');
});

test('resolve(): falls back to the canonical layer when no alias row exists (spec section 8 project-alias gap)', () => {
  const aliasIndex = buildAliasIndex([]); // zero type='project' rows, matches live reality
  const canonicalRegistry = buildCanonicalRegistry([{ area: 'Dubai Marina', project_community: 'Emaar Beachfront', building: null }]);
  const dictionary = buildLocationDictionary({ aliasIndex, canonicalRegistry });

  const result = dictionary.resolve('project', 'Emaar Beachfront');
  assert.equal(result.resolved, true);
  assert.equal(result.canonical, 'Emaar Beachfront');
  assert.equal(result.resolution_source, 'canonical');
  assert.equal(result.parent_area, 'Dubai Marina');
});

test('resolve(): a name unknown to both layers is genuinely unresolved, never disguised as canonical', () => {
  const dictionary = buildLocationDictionary({ aliasIndex: buildAliasIndex([]), canonicalRegistry: buildCanonicalRegistry([]) });
  const result = dictionary.resolve('project', 'Nonexistent Tower');
  assert.equal(result.resolved, false);
  assert.equal(result.canonical, null);
  assert.equal(result.resolution_source, null);
  assert.equal(result.value, 'Nonexistent Tower'); // raw text still carried for an existence check
});

test('resolve(): null/empty raw input is inactive, not "unresolved"', () => {
  const dictionary = buildLocationDictionary({});
  assert.deepEqual(dictionary.resolve('area', null), { raw: null, type: 'area', canonical: null, value: null, resolved: false, resolution_source: null, parent_area: null });
});
