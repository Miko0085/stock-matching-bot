'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { estimateCostUsd, extractUsageFromOpenAiResponse } = require('../../src/core/ai-usage');

test('estimateCostUsd computes the correct $ for a known model', () => {
  const cost = estimateCostUsd({ model: 'gpt-4o-mini', promptTokens: 1_000_000, completionTokens: 1_000_000 });
  assert.equal(cost, 0.15 + 0.6);
});

test('estimateCostUsd returns null for an unpriced/unknown model rather than guessing', () => {
  const cost = estimateCostUsd({ model: 'some-future-model', promptTokens: 100, completionTokens: 50 });
  assert.equal(cost, null);
});

test('estimateCostUsd returns null when token counts are missing', () => {
  assert.equal(estimateCostUsd({ model: 'gpt-4o-mini', promptTokens: null, completionTokens: 50 }), null);
});

test('a dated snapshot model name (what the live API actually returns) still prices correctly', () => {
  const cost = estimateCostUsd({ model: 'gpt-4o-mini-2024-07-18', promptTokens: 1_000_000, completionTokens: 1_000_000 });
  assert.equal(cost, 0.15 + 0.6);
});

test('extractUsageFromOpenAiResponse reads a realistic chat/completions response', () => {
  const httpResponse = {
    model: 'gpt-4o-mini',
    usage: { prompt_tokens: 420, completion_tokens: 65, total_tokens: 485 },
    choices: [{ message: { content: '{}' } }],
  };
  const usage = extractUsageFromOpenAiResponse(httpResponse);
  assert.equal(usage.model, 'gpt-4o-mini');
  assert.equal(usage.promptTokens, 420);
  assert.equal(usage.completionTokens, 65);
  assert.equal(usage.totalTokens, 485);
  assert.ok(usage.estimatedCostUsd > 0);
});

test('extractUsageFromOpenAiResponse degrades to all-nulls instead of throwing on a malformed response', () => {
  for (const bad of [null, undefined, {}, { usage: null }, 'unexpected string body']) {
    const usage = extractUsageFromOpenAiResponse(bad);
    assert.deepEqual(usage, {
      model: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      estimatedCostUsd: null,
    });
  }
});
