'use strict';

// Deterministic guard against a real, observed gpt-4o-mini behavior: even
// with an explicit "never infer an area from a project/building name"
// instruction (prompt.js), the model sometimes still fills in a
// district/area name it associates with a named project from its own
// training data, rather than leaving it null when the text never states
// one (e.g. "The Edge by Select Group" -> area hallucinated as "Dubai
// Marina" or "Business Bay", neither of which appears anywhere in the
// source text). Never trust the AI's own claim about what the text says --
// verify it against the actual text, the same "untrusted input" posture
// the rest of this pipeline already takes toward the AI's output.
//
// A location-hierarchy safety net (matching/location.js prefers building >
// project > area) already prevents this from mis-routing candidate
// retrieval when a more specific field is also present, but nulling the
// unverifiable field here keeps the persisted StructuredRequest itself
// honest even when area is the ONLY location field extracted.
function normalize(text) {
  return String(text || '').toLowerCase();
}

function appearsInText(value, originalText) {
  if (!value) return true; // null was never a hallucination candidate
  return normalize(originalText).includes(normalize(value));
}

function stripUnverifiableLocationFields(aiValue, originalText) {
  const result = { ...aiValue };
  for (const field of ['area', 'project', 'building']) {
    if (result[field] && !appearsInText(result[field], originalText)) {
      result[field] = null;
    }
  }
  // Multi-area (spec sections 10-17): each named area is a separate
  // hallucination candidate -- verified independently, same as the
  // singular fields above. A hallucinated SECOND area must not taint a
  // genuinely-stated first one, or vice versa.
  if (Array.isArray(result.areas)) {
    result.areas = result.areas.filter((value) => appearsInText(value, originalText));
  }
  return result;
}

module.exports = { stripUnverifiableLocationFields };
