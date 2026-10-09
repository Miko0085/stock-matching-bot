'use strict';

// Moscow's own copy of lead-matching-service/src/parser/anti-hallucination.js's
// guard (same real observed LLM behavior applies here: a model can fill in
// a district it associates with a named ЖК from its own training data,
// rather than leaving it null when the text never states one) -- adapted
// to Moscow's own location fields (district/complex, not area/building/
// project).
function normalize(text) {
  return String(text || '').toLowerCase();
}

function appearsInText(value, originalText) {
  if (!value) return true; // null was never a hallucination candidate
  return normalize(originalText).includes(normalize(value));
}

function stripUnverifiableLocationFields(aiValue, originalText) {
  const result = { ...aiValue };
  for (const field of ['district', 'complex']) {
    if (result[field] && !appearsInText(result[field], originalText)) {
      result[field] = null;
    }
  }
  return result;
}

module.exports = { stripUnverifiableLocationFields };
