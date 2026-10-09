'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeContentHash } = require('../../src/core/content-dedup');

test('the exact same text and author always hash the same', () => {
  const a = computeContentHash({ text: 'Ищу квартиру в JVC', authorName: 'Ivan' });
  const b = computeContentHash({ text: 'Ищу квартиру в JVC', authorName: 'Ivan' });
  assert.equal(a, b);
});

test('a repost with different casing/whitespace still hashes the same (same-author cross-posting)', () => {
  const original = computeContentHash({ text: 'Ищу квартиру в JVC', authorName: 'Ivan' });
  const repost = computeContentHash({ text: '  ищу   квартиру   в   jvc  ', authorName: 'ivan' });
  assert.equal(original, repost);
});

test('a different author writing similar text is never deduped against the original', () => {
  const a = computeContentHash({ text: 'Ищу квартиру в JVC', authorName: 'Ivan' });
  const b = computeContentHash({ text: 'Ищу квартиру в JVC', authorName: 'Petr' });
  assert.notEqual(a, b);
});

test('genuinely different text from the same author is never deduped', () => {
  const a = computeContentHash({ text: 'Ищу квартиру в JVC', authorName: 'Ivan' });
  const b = computeContentHash({ text: 'Ищу виллу в Dubailand', authorName: 'Ivan' });
  assert.notEqual(a, b);
});

test('a missing author name never throws and still produces a stable hash', () => {
  assert.doesNotThrow(() => computeContentHash({ text: 'Ищу квартиру', authorName: null }));
  const a = computeContentHash({ text: 'Ищу квартиру', authorName: null });
  const b = computeContentHash({ text: 'Ищу квартиру', authorName: undefined });
  assert.equal(a, b);
});

test('empty/missing text never throws', () => {
  assert.doesNotThrow(() => computeContentHash({ text: null, authorName: 'Ivan' }));
  assert.doesNotThrow(() => computeContentHash({}));
});
