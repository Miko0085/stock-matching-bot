'use strict';

// OpenAI exposes no API for a project's remaining $ balance (the old
// /dashboard/billing/credit_grants endpoint is gone) and no API for its own
// per-model pricing either — this rate table mirrors the published pricing
// page by hand and must be updated whenever OpenAI changes a rate for a
// model actually in use. What IS reliable is the `usage` object every
// chat/completions response already returns, so cost here is computed from
// our own real token counts rather than any account-wide figure.
const PRICING_PER_MILLION_TOKENS_USD = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2, output: 8 },
};

// OpenAI's actual response `model` field is often a dated snapshot (e.g.
// "gpt-4o-mini-2024-07-18") even when the request asked for the bare alias
// ("gpt-4o-mini") — match the longest known pricing key that the response
// model starts with, on a "-" boundary, so a snapshot suffix never falls
// through to an unpriced/null result.
function resolvePricingKey(model) {
  if (!model) return null;
  if (PRICING_PER_MILLION_TOKENS_USD[model]) return model;
  const keys = Object.keys(PRICING_PER_MILLION_TOKENS_USD).sort((a, b) => b.length - a.length);
  return keys.find((key) => model === key || model.startsWith(`${key}-`)) || null;
}

function estimateCostUsd({ model, promptTokens, completionTokens }) {
  const pricing = PRICING_PER_MILLION_TOKENS_USD[resolvePricingKey(model)];
  if (!pricing || !Number.isFinite(promptTokens) || !Number.isFinite(completionTokens)) {
    return null;
  }
  return (promptTokens * pricing.input + completionTokens * pricing.output) / 1_000_000;
}

// Pulls usage straight off a raw OpenAI chat/completions response body.
// Never throws: an unexpected/malformed response (a proxy error page, a
// future API shape change) degrades to all-null fields rather than taking
// down the matching pipeline this rides alongside.
function extractUsageFromOpenAiResponse(httpResponse) {
  const usage = (httpResponse && httpResponse.usage) || {};
  const model = (httpResponse && httpResponse.model) || null;
  const promptTokens = Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null;
  const completionTokens = Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null;
  const totalTokens = Number.isFinite(usage.total_tokens) ? usage.total_tokens : null;
  const estimatedCostUsd =
    promptTokens !== null && completionTokens !== null
      ? estimateCostUsd({ model, promptTokens, completionTokens })
      : null;
  return { model, promptTokens, completionTokens, totalTokens, estimatedCostUsd };
}

module.exports = {
  PRICING_PER_MILLION_TOKENS_USD,
  estimateCostUsd,
  extractUsageFromOpenAiResponse,
};
