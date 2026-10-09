'use strict';

const { buildMessages } = require('./prompt');
const { parseAiOutput } = require('./schema');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Same retry discipline as dubai-lead-matching-service's own openai-
// client.js: retry network/timeout/429/5xx/invalid-JSON, never retry
// 400/401 (a bad request or bad key fails identically every time).
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

    return { outcome: 'ok', rawParsed };
  } catch (err) {
    const isAbort = err.name === 'AbortError';
    return { outcome: isAbort ? 'timeout' : 'network_error', retryable: true, message: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Never throws -- a single message's OpenAI failure must never crash the
// webhook handler. The raw message is never lost on failure: the caller
// (routes/webhooks.js) does not write a processed_messages row at all on
// !ok, so a real webhook redelivery gets a genuine retry, not a silently
// dropped message.
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
      return { ok: true, value, warnings };
    }

    lastFailure = result;
    if (!result.retryable || attempt === maxRetries) break;
    await sleep(retryBaseDelayMs * 2 ** attempt);
  }

  return {
    ok: false,
    reason: lastFailure?.outcome || 'unknown_error',
    status: lastFailure?.status ?? null,
    message: lastFailure?.message || null,
  };
}

module.exports = { classifyAndParse };
