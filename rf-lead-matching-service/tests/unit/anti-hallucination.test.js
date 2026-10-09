'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stripUnverifiableLocationFields } = require('../../src/parser/anti-hallucination');

test('a district that appears verbatim in the source text is kept', () => {
  const result = stripUnverifiableLocationFields({ district: 'ЮЗАО', complex: null }, 'Ищу квартиру в ЮЗАО');
  assert.equal(result.district, 'ЮЗАО');
});

test('a district the AI invented (never appears in the source text) is nulled out', () => {
  const result = stripUnverifiableLocationFields({ district: 'Хамовники', complex: 'Событие' }, 'Ищу квартиру в ЖК Событие');
  assert.equal(result.district, null, 'district was hallucinated from the complex name, not stated');
  assert.equal(result.complex, 'Событие', 'complex genuinely appears in the text');
});

test('a null field is never treated as a hallucination candidate', () => {
  const result = stripUnverifiableLocationFields({ district: null, complex: null }, 'просто текст');
  assert.equal(result.district, null);
  assert.equal(result.complex, null);
});

test('matching is case-insensitive', () => {
  const result = stripUnverifiableLocationFields({ district: 'юзао', complex: null }, 'Ищу квартиру в ЮЗАО');
  assert.equal(result.district, 'юзао');
});
