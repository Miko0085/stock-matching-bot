'use strict';

// The only place in this service that calls the Telegram Bot API (TZ 107:
// "Matching core не содержит Telegram Bot API calls" -- kept in its own
// module, called only from services/pipeline.js after persistence
// succeeds, never from matching/*.js). Plain text, no parse_mode -- this
// sidesteps any Markdown/HTML escaping risk entirely, so original_text
// always displays exactly as written (TZ 110).
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendOne({ botToken, chatId, text, timeoutMs = 10000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok && body.ok !== false, status: res.status, body };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Sends every message in order, one bounded retry per message on failure.
// A single message's send failure never blocks the others -- best-effort,
// each part is independent (matches the fan-out-style fault isolation
// used everywhere else in this system, e.g. the workers' multi-target
// webhook queues). Never throws -- a Telegram outage must not take down
// the matching pipeline that already persisted successfully.
async function sendMatchNotification({ botToken, chatId, messages, maxRetries = 2 }) {
  const results = [];
  for (const text of messages) {
    let lastResult = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      lastResult = await sendOne({ botToken, chatId, text });
      if (lastResult.ok) break;
      if (attempt < maxRetries) await sleep(500 * 2 ** attempt);
    }
    results.push(lastResult);
  }
  return { ok: results.every((r) => r.ok), results };
}

module.exports = { sendMatchNotification, sendOne };
