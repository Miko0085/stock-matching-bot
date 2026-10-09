'use strict';

const { buildLocationDictionary } = require('../matching/location-dictionary');

// Builds the StructuredRequest (TZ 30) from a validated UnifiedRawMessage +
// the AI parser's coerced output. area/project/building/property_type are
// substituted with their canonical spelling when resolvable, exactly like
// the old pipeline's normalizeRequestForMatching -- but resolution success/
// failure is also returned alongside (not part of the public
// StructuredRequest shape) so the matcher can tell "this name isn't
// recognized at all" (location_not_found) apart from "recognized, but no
// stock currently matches it" (no_stock_in_area/project/building).
//
// Resolution runs through the location DICTIONARY (matching/
// location-dictionary.js), not the raw alias engine directly -- it layers
// an explicit alias-row match with a fallback "this raw value already
// equals a real, distinct value seen in stock_inventory" canonical match
// (spec sections 5-9). This is what closes the confirmed project-alias gap
// (TZ 41: matching_aliases has zero type='project' rows despite 41/94
// ACTIVE stock rows having a project_community) without ever writing a
// fake alias row -- a project name already present in stock resolves via
// `resolution_source: 'canonical'` instead of failing outright.
function buildStructuredRequest({ unifiedMessage, aiValue, aliasIndex, locationDictionary }) {
  const dictionary = locationDictionary || buildLocationDictionary({ aliasIndex });

  // Multi-area (spec sections 10-17): every named area is resolved
  // INDEPENDENTLY, keeping both the resolved and unresolved lists -- never
  // silently dropping an option nor silently broadening to "any area".
  // `aiValue.areas` (schema.js) is always populated, even for a legacy
  // single-area value (falls back to `[area]`).
  // Falls back to `[area]` when the caller passes a raw aiValue object that
  // never went through schema.js's parseAiOutput() (e.g. a test, or a
  // future direct caller) and therefore never got the `areas` fallback
  // schema.js already applies -- keeps this function correct standalone.
  const rawAreas = Array.isArray(aiValue.areas) && aiValue.areas.length > 0 ? aiValue.areas : (aiValue.area ? [aiValue.area] : []);
  const areaOptions = rawAreas.map((raw) => dictionary.resolve('area', raw));
  // Back-compat single value (spec section 10: "keep area (single,
  // back-compat)") -- the first resolved option's canonical spelling, or
  // the first raw option if none resolved, or null if no area was named at
  // all. Only informational: the matcher reads `resolution.areaOptions`
  // directly (see matching/location.js) and never this field once any
  // areaOptions exist.
  const firstResolvedArea = areaOptions.find((option) => option.resolved);
  const legacyAreaValue = firstResolvedArea ? firstResolvedArea.canonical : (areaOptions[0] ? areaOptions[0].raw : null);

  const project = dictionary.resolve('project', aiValue.project);
  const building = dictionary.resolve('building', aiValue.building);
  const propertyType = dictionary.resolve('property_type', aiValue.property_type);

  const structuredRequest = {
    schema_version: '1.0',
    request_id: unifiedMessage.source_message_id,
    source: {
      provider: unifiedMessage.provider,
      source_url: unifiedMessage.source_url,
      group_name: unifiedMessage.group_name,
      author_name: unifiedMessage.author_name,
      author_contact: unifiedMessage.author_contact,
      original_text: unifiedMessage.original_text,
    },
    transaction_type: aiValue.transaction_type,
    area: legacyAreaValue,
    // Canonical internal representation (spec section 10) -- every named
    // area's resolved-or-raw value, in the order given. `area` above stays
    // for back-compat only; this is what a future consumer (diagnostics,
    // dashboard) should read for "every area this buyer would accept."
    areas: areaOptions.map((option) => option.value),
    project: project.value,
    building: building.value,
    property_type: propertyType.value,
    bedrooms_min: aiValue.bedrooms_min,
    bedrooms_max: aiValue.bedrooms_max,
    budget_min: aiValue.budget_min,
    budget_max: aiValue.budget_max,
    furnishing: aiValue.furnishing,
    cash_buyer: aiValue.cash_buyer,
    bathrooms_min: aiValue.bathrooms_min ?? null,
    bathrooms_max: aiValue.bathrooms_max ?? null,
    size_sqft_min: aiValue.size_sqft_min ?? null,
    size_sqft_max: aiValue.size_sqft_max ?? null,
    plot_size_sqft_min: aiValue.plot_size_sqft_min ?? null,
    plot_size_sqft_max: aiValue.plot_size_sqft_max ?? null,
    view: aiValue.view ?? null,
    ai_confidence: aiValue.confidence,
  };

  const resolution = {
    areaProvided: areaOptions.length > 0,
    areaResolved: areaOptions.some((option) => option.resolved),
    areaOptions,
    projectProvided: Boolean(aiValue.project),
    projectResolved: project.resolved,
    buildingProvided: Boolean(aiValue.building),
    buildingResolved: building.resolved,
    propertyTypeResolved: propertyType.resolved,
  };

  return { structuredRequest, resolution };
}

module.exports = { buildStructuredRequest };
