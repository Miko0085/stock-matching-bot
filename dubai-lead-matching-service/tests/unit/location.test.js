'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveLocationLevel, hasMinimumSpecificity } = require('../../src/matching/location');

test('building takes priority over project and area when all three are stated', () => {
  const request = { building: 'Peninsula Four', project: 'Some Project', area: 'Business Bay' };
  const info = resolveLocationLevel(request, { buildingResolved: true, projectResolved: true, areaResolved: true });
  assert.equal(info.level, 'building');
  assert.equal(info.value, 'Peninsula Four');
});

test('project takes priority over area when building is absent', () => {
  const request = { building: null, project: 'The Edge', area: 'Business Bay' };
  const info = resolveLocationLevel(request, { projectResolved: false, areaResolved: true });
  assert.equal(info.level, 'project');
  assert.equal(info.value, 'The Edge');
});

test('area is used only when building and project are both absent', () => {
  const request = { building: null, project: null, area: 'Business Bay' };
  const info = resolveLocationLevel(request, { areaResolved: true });
  assert.equal(info.level, 'area');
});

test('no location stated at all -> provided=false (TZ: location_unspecified)', () => {
  const info = resolveLocationLevel({ building: null, project: null, area: null }, {});
  assert.equal(info.provided, false);
  assert.equal(info.level, null);
});

test('TZ 49: area-only, no budget/bedrooms/property_type -> insufficient specificity', () => {
  const structuredRequest = { area: 'Business Bay', budget_min: null, budget_max: null, bedrooms_min: null, bedrooms_max: null, property_type: null };
  const info = resolveLocationLevel(structuredRequest, { areaResolved: true });
  assert.equal(hasMinimumSpecificity(structuredRequest, info), false);
});

test('TZ 49: area + bedrooms is sufficient', () => {
  const structuredRequest = { area: 'Business Bay', budget_min: null, budget_max: null, bedrooms_min: 2, bedrooms_max: 2, property_type: null };
  const info = resolveLocationLevel(structuredRequest, { areaResolved: true });
  assert.equal(hasMinimumSpecificity(structuredRequest, info), true);
});

test('TZ 49: area + budget is sufficient', () => {
  const structuredRequest = { area: 'Business Bay', budget_min: null, budget_max: 2500000, bedrooms_min: null, bedrooms_max: null, property_type: null };
  const info = resolveLocationLevel(structuredRequest, { areaResolved: true });
  assert.equal(hasMinimumSpecificity(structuredRequest, info), true);
});

test('TZ 49: project (as location) + property_type is sufficient', () => {
  const structuredRequest = {
    building: null,
    project: 'The Edge',
    area: null,
    budget_min: null,
    budget_max: null,
    bedrooms_min: null,
    bedrooms_max: null,
    property_type: 'Apartment',
  };
  const info = resolveLocationLevel(structuredRequest, { projectResolved: false });
  assert.equal(hasMinimumSpecificity(structuredRequest, info), true);
});

// Multi-area regressions (spec sections 10-17): several acceptable areas
// are OR conditions, resolved independently, never a reason to discard the
// lead (final principle 5).
test('multi-area: all options resolved -> level area, values holds every canonical, not partial', () => {
  const request = { building: null, project: null, area: null };
  const resolution = {
    areaOptions: [
      { raw: 'Dubai Silicon Oasis', canonical: 'Dubai Silicon Oasis', resolved: true, resolution_source: 'canonical' },
      { raw: 'Warsan', canonical: 'Warsan', resolved: true, resolution_source: 'canonical' },
    ],
  };
  const info = resolveLocationLevel(request, resolution);
  assert.equal(info.level, 'area');
  assert.equal(info.resolved, true);
  assert.equal(info.partial, false);
  assert.deepEqual(info.values, ['Dubai Silicon Oasis', 'Warsan']);
  assert.deepEqual(info.unresolvedOptions, []);
});

test('multi-area: partial resolution keeps only resolved values but preserves unresolved raw options', () => {
  const request = { building: null, project: null, area: null };
  const resolution = {
    areaOptions: [
      { raw: 'DSO', canonical: 'Dubai Silicon Oasis', resolved: true, resolution_source: 'alias' },
      { raw: 'Bur Dubai', canonical: null, resolved: false },
    ],
  };
  const info = resolveLocationLevel(request, resolution);
  assert.equal(info.resolved, true);
  assert.equal(info.partial, true);
  assert.deepEqual(info.values, ['Dubai Silicon Oasis']);
  assert.deepEqual(info.unresolvedOptions, ['Bur Dubai']);
});

test('multi-area: all options unresolved -> resolved=false, values carries every raw option for the existence check', () => {
  const request = { building: null, project: null, area: null };
  const resolution = {
    areaOptions: [
      { raw: 'Nowhereville', canonical: null, resolved: false },
      { raw: 'Fakearea', canonical: null, resolved: false },
    ],
  };
  const info = resolveLocationLevel(request, resolution);
  assert.equal(info.provided, true);
  assert.equal(info.resolved, false);
  assert.deepEqual(info.values, ['Nowhereville', 'Fakearea']);
  assert.deepEqual(info.unresolvedOptions, ['Nowhereville', 'Fakearea']);
});

test('multi-area: building still wins over multiple area options', () => {
  const request = { building: 'The Edge', project: null, area: null };
  const resolution = {
    buildingResolved: true,
    areaOptions: [{ raw: 'Business Bay', canonical: 'Business Bay', resolved: true }],
  };
  const info = resolveLocationLevel(request, resolution);
  assert.equal(info.level, 'building');
  assert.equal(info.value, 'The Edge');
});

test('no location at all -> hasMinimumSpecificity is false regardless of other criteria', () => {
  const structuredRequest = { area: null, project: null, building: null, budget_max: 2500000, bedrooms_min: 2, bedrooms_max: 2, property_type: 'Apartment' };
  const info = resolveLocationLevel(structuredRequest, {});
  assert.equal(hasMinimumSpecificity(structuredRequest, info), false);
});
