'use strict';

const { buildMessages } = require('./prompt');
const { parseAiOutput } = require('./schema');
const { stripUnverifiableLocationFields } = require('./anti-hallucination');
const { extractUsageFromOpenAiResponse } = require('../../../src/core/ai-usage');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retryable per TZ 104: network failure, timeout, 429, 5xx, or a response
// that isn't valid JSON. NOT retried: 400/401 (a bad request or bad key
// will fail identically every time -- TZ 77's "don't retry 400/401" spirit
// applies here too).
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

async function callOnce({ apiKey, model, originalText, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: buildMessages(originalText),
      }),
      signal: controller.signal,
    });

    const text = await res.text();

    if (!res.ok) {
      return { outcome: 'http_error', status: res.status, retryable: isRetryableStatus(res.status) };
    }

    let httpResponse;
    try {
      httpResponse = JSON.parse(text);
    } catch {
      return { outcome: 'invalid_json', retryable: true };
    }

    const content = httpResponse.choices?.[0]?.message?.content;
    let rawParsed;
    try {
      rawParsed = typeof content === 'string' ? JSON.parse(content) : content || {};
    } catch {
      return { outcome: 'invalid_json', retryable: true };
    }

    return { outcome: 'ok', httpResponse, rawParsed };
  } catch (err) {
    const isAbort = err.name === 'AbortError';
    return { outcome: isAbort ? 'timeout' : 'network_error', retryable: true, message: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// One call does both classification and structured parsing (TZ 24). Never
// throws -- callers get a discriminated result so a single message's
// OpenAI failure can be handled as PARSER_ERROR without crashing the
// service (TZ 103-104). The raw message is never lost even on failure --
// persistence happens regardless of parser outcome (TZ 104-105).
async function classifyAndParse({
  originalText,
  apiKey,
  model,
  timeoutMs = 15000,
  maxRetries = 2,
  retryBaseDelayMs = 400,
}) {
  let lastFailure = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const result = await callOnce({ apiKey, model, originalText, timeoutMs });

    if (result.outcome === 'ok') {
      const { value, warnings } = parseAiOutput(result.rawParsed);
      const verifiedValue = stripUnverifiableLocationFields(value, originalText);
      const usage = extractUsageFromOpenAiResponse(result.httpResponse);
      return { ok: true, value: verifiedValue, warnings, usage };
    }

    lastFailure = result;
    if (!result.retryable || attempt === maxRetries) break;
    await sleep(retryBaseDelayMs * 2 ** attempt);
  }

  return {
    ok: false,
    errorCode: 'PARSER_ERROR',
    reason: lastFailure?.outcome || 'unknown_error',
    status: lastFailure?.status ?? null,
    message: lastFailure?.message || null,
  };
}

module.exports = { classifyAndParse };
