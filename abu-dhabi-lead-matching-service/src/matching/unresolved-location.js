'use strict';

// P0.2 release blocker: a specific project/building mentioned in the raw
// text must never silently disappear into a broader area match just
// because it wasn't resolved by alias lookup. Real incident shape:
// "Need 1BR The Edge Business Bay max 1.3M" -- if "The Edge" isn't a
// known building alias, `building` stays null and location resolution
// falls back to `area = Business Bay`, which would otherwise match the
// ENTIRE area's stock as if the buyer never named a specific building.
//
// This is a deliberately conservative, precision-first heuristic: after
// the resolved area's own words are excluded, any leftover run of
// capitalized, non-common-word tokens in the original text is treated as
// a "this might be a specific project/building name we don't recognize"
// signal -- strong enough to refuse a broad area match, even though it
// is not by itself a reliable POSITIVE extraction. False negatives here
// (blocking a legitimate area-only request that merely contains a
// capitalized word) are explicitly preferred over the false positive this
// fixes (silently matching the wrong building's entire area).

const KNOWN_NON_LOCATION_WORDS = new Set([
  'need', 'needs', 'needed', 'looking', 'for', 'to', 'buy', 'rent', 'renting', 'rental', 'lease',
  'sale', 'purchase', 'my', 'client', 'is', 'are', 'a', 'an', 'in', 'on', 'of', 'and', 'or', 'with',
  'max', 'maximum', 'min', 'minimum', 'up', 'not', 'above', 'more', 'than', 'under', 'at', 'least',
  'from', 'starting', 'budget', 'cash', 'mortgage', 'wtb', 'required', 'seeking', 'required.',
  'studio', 'apartment', 'apartments', 'flat', 'flats', 'villa', 'villas', 'townhouse', 'townhouses',
  'penthouse', 'penthouses', 'duplex', 'duplexes', 'office', 'offices', 'retail', 'land',
  'furnished', 'unfurnished', 'semi-furnished', 'semi', 'br', 'bed', 'beds', 'bedroom', 'bedrooms',
  'aed', 'sqft', 'sqm', 'bathrooms', 'bathroom', 'bath', 'plot', 'sq', 'ft',
]);

const CONNECTOR_WORDS = new Set(['the', 'by', 'at', 'of', 'and']);

function isCapitalizedWord(token) {
  return /^[A-Z][A-Za-z'-]*$/.test(token);
}

function tokenize(text) {
  return String(text || '')
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, ''))
    .filter(Boolean);
}

// `resolvedAreaValue` is the canonical area value the request matched at
// (e.g. "Business Bay") -- its own words are excluded from the scan so a
// normal, fully-resolved area name never trips this heuristic.
function detectUnresolvedSpecificLocationHint(originalText, resolvedAreaValue) {
  if (!originalText) return false;

  const resolvedWords = new Set(
    String(resolvedAreaValue || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
  );

  const tokens = tokenize(originalText);
  const runs = [];
  let current = [];

  for (const token of tokens) {
    const lower = token.toLowerCase();
    const isNumeric = /^\d+(\.\d+)?$/.test(token);
    const isExcluded = KNOWN_NON_LOCATION_WORDS.has(lower) || resolvedWords.has(lower) || isNumeric;

    if (isCapitalizedWord(token) && !isExcluded) {
      current.push(token);
    } else if (current.length && CONNECTOR_WORDS.has(lower)) {
      // allow a connector inside a run, e.g. "The Edge by Select Group"
      current.push(token);
    } else {
      if (current.length) runs.push(current);
      current = [];
    }
  }
  if (current.length) runs.push(current);

  return runs.some((run) => run.some((t) => !CONNECTOR_WORDS.has(t.toLowerCase())));
}

module.exports = { detectUnresolvedSpecificLocationHint };
