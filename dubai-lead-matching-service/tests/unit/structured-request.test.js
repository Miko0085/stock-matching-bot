'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildStructuredRequest } = require('../../src/normalization/structured-request');
const { buildAliasIndex } = require('../../../src/core/aliases');
const { buildCanonicalRegistry, buildLocationDictionary } = require('../../src/matching/location-dictionary');
const { aliasRows } = require('../../../tests/fixtures/aliases');

const aliasIndex = buildAliasIndex(aliasRows);

function makeUnifiedMessage(overrides = {}) {
  return {
    schema_version: '1.0',
    provider: 'telegram',
    source_message_id: 'telegram:1:1',
    external_message_id: '1',
    chat_id: '1',
    group_name: 'Dubai Brokers',
    sender_id: '1',
    sender_id_alt: null,
    author_name: 'John',
    author_username: 'john',
    author_contact: 'https://t.me/john',
    original_text: 'Need 2BR in Business Bay',
    source_url: 'https://t.me/x/1',
    posted_at: '2026-09-17T12:00:00Z',
    received_at: '2026-09-17T12:00:03Z',
    ...overrides,
  };
}

function makeAiValue(overrides = {}) {
  return {
    message_class: 'buyer_request',
    demand_owner: 'sender',
    promotion: false,
    spam: false,
    transaction_type: 'SALE',
    area: 'BB',
    project: null,
    building: null,
    property_type: 'Apartment',
    bedrooms_min: 2,
    bedrooms_max: 2,
    budget_min: null,
    budget_max: 2500000,
    furnishing: null,
    cash_buyer: null,
    confidence: 0.9,
    ...overrides,
  };
}

test('TZ 30: produces the documented StructuredRequest shape', () => {
  const { structuredRequest } = buildStructuredRequest({
    unifiedMessage: makeUnifiedMessage(),
    aiValue: makeAiValue(),
    aliasIndex,
  });
  assert.equal(structuredRequest.schema_version, '1.0');
  assert.equal(structuredRequest.request_id, 'telegram:1:1');
  assert.equal(structuredRequest.source.provider, 'telegram');
  assert.equal(structuredRequest.source.original_text, 'Need 2BR in Business Bay');
  assert.equal(structuredRequest.transaction_type, 'SALE');
  assert.equal(structuredRequest.bedrooms_min, 2);
  assert.equal(structuredRequest.bedrooms_max, 2);
  assert.equal(structuredRequest.budget_max, 2500000);
});

test('area alias "BB" resolves to canonical "Business Bay"', () => {
  const { structuredRequest, resolution } = buildStructuredRequest({
    unifiedMessage: makeUnifiedMessage(),
    aiValue: makeAiValue({ area: 'BB' }),
    aliasIndex,
  });
  assert.equal(structuredRequest.area, 'Business Bay');
  assert.equal(resolution.areaResolved, true);
});

test('an unresolved area passes through raw, with resolution.areaResolved=false', () => {
  const { structuredRequest, resolution } = buildStructuredRequest({
    unifiedMessage: makeUnifiedMessage(),
    aiValue: makeAiValue({ area: 'Some Totally Unknown Place' }),
    aliasIndex,
  });
  assert.equal(structuredRequest.area, 'Some Totally Unknown Place');
  assert.equal(resolution.areaResolved, false);
  assert.equal(resolution.areaProvided, true);
});

test('project resolution falls through to raw value when no project aliases exist (TZ 41 limitation)', () => {
  const { structuredRequest, resolution } = buildStructuredRequest({
    unifiedMessage: makeUnifiedMessage(),
    aiValue: makeAiValue({ area: null, project: 'The Edge' }),
    aliasIndex,
  });
  assert.equal(structuredRequest.project, 'The Edge');
  assert.equal(resolution.projectResolved, false); // no alias table coverage yet
  assert.equal(resolution.projectProvided, true);
});

test('property_type alias "Flat" resolves to canonical "Apartment"', () => {
  const { structuredRequest } = buildStructuredRequest({
    unifiedMessage: makeUnifiedMessage(),
    aiValue: makeAiValue({ property_type: 'Flat' }),
    aliasIndex,
  });
  assert.equal(structuredRequest.property_type, 'Apartment');
});

// Multi-area (spec sections 10-17): every named area resolved
// independently, none silently dropped.
test('multiple named areas resolve independently -- resolved and unresolved both preserved', () => {
  const { structuredRequest, resolution } = buildStructuredRequest({
    unifiedMessage: makeUnifiedMessage(),
    aiValue: makeAiValue({ area: null, areas: ['BB', 'Some Totally Unknown Place'] }),
    aliasIndex,
  });
  assert.deepEqual(structuredRequest.areas, ['Business Bay', 'Some Totally Unknown Place']);
  assert.equal(resolution.areaOptions.length, 2);
  assert.equal(resolution.areaOptions[0].resolved, true);
  assert.equal(resolution.areaOptions[0].resolution_source, 'alias');
  assert.equal(resolution.areaOptions[1].resolved, false);
  assert.equal(resolution.areaResolved, true); // at least one resolved
});

// Canonical registry layer (spec sections 5-9): the confirmed gap where
// matching_aliases has zero type='project' rows despite real stock having
// project_community values -- a raw term matching a known STOCK value
// directly must resolve via resolution_source='canonical', never treated
// as unrecognized.
test('canonical registry: a project name with NO alias row but a real stock match resolves via resolution_source=canonical', () => {
  const canonicalRegistry = buildCanonicalRegistry([
    { area: 'Dubai Marina', project_community: 'Emaar Beachfront', building: null },
  ]);
  const locationDictionary = buildLocationDictionary({ aliasIndex, canonicalRegistry });

  const { structuredRequest, resolution } = buildStructuredRequest({
    unifiedMessage: makeUnifiedMessage(),
    aiValue: makeAiValue({ area: null, project: 'Emaar Beachfront' }),
    locationDictionary,
  });
  assert.equal(structuredRequest.project, 'Emaar Beachfront');
  assert.equal(resolution.projectResolved, true);
});

test('canonical registry: a name matching NEITHER an alias NOR any real stock value stays unresolved', () => {
  const canonicalRegistry = buildCanonicalRegistry([
    { area: 'Dubai Marina', project_community: 'Emaar Beachfront', building: null },
  ]);
  const locationDictionary = buildLocationDictionary({ aliasIndex, canonicalRegistry });

  const { resolution } = buildStructuredRequest({
    unifiedMessage: makeUnifiedMessage(),
    aiValue: makeAiValue({ area: null, project: 'A Made-Up Project Nobody Has Ever Heard Of' }),
    locationDictionary,
  });
  assert.equal(resolution.projectResolved, false);
});
