'use strict';

// Completes the broker Telegram "/start=<token>" handshake that /brokers'
// "Создать ссылку" button already generates (src/core/telegram-connection.js)
// but that nothing in the codebase ever resolved -- confirmed by grep,
// resolveConnectionToken was only ever called from its own unit test.
//
// Long-polling (Bot API getUpdates), not a webhook: no public HTTPS
// ingress exists anywhere in this repo for a third-party webhook callback
// (telegram-worker is a Telethon USER-session listener, a different
// mechanism entirely; whatsapp-worker is a Baileys socket). getUpdates
// needs no public endpoint, so this runs as a simple interval inside the
// dashboard process, which already owns `pool` and the broker-admin
// lifecycle.
const POLL_INTERVAL_MS = 3000;
const GETUPDATES_TIMEOUT_S = 25;

const { resolveConnectionToken } = require('../src/core/telegram-connection');

async function pollOneBot(pool, bot, fetchImpl) {
  const offset = bot.last_update_id ? Number(bot.last_update_id) + 1 : undefined;
  const url = `https://api.telegram.org/bot${bot.bot_token}/getUpdates?timeout=${GETUPDATES_TIMEOUT_S}${offset !== undefined ? `&offset=${offset}` : ''}`;

  let body;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout((GETUPDATES_TIMEOUT_S + 5) * 1000) });
    body = await res.json();
  } catch (err) {
    console.error(`[telegram-bot-poller] bot ${bot.id} getUpdates failed:`, err.message);
    return;
  }
  if (!body || !body.ok) {
    console.error(`[telegram-bot-poller] bot ${bot.id} getUpdates returned not-ok:`, body && body.description);
    return;
  }

  let maxUpdateId = bot.last_update_id ? Number(bot.last_update_id) : 0;
  for (const update of body.result || []) {
    maxUpdateId = Math.max(maxUpdateId, update.update_id);
    const msg = update.message;
    if (!msg || !msg.text || !msg.text.startsWith('/start')) continue;
    const presentedToken = msg.text.split(' ')[1] || null;
    if (!presentedToken) continue;

    const { rows: pending } = await pool.query(
      `SELECT * FROM matching_dubai.broker_telegram_accounts WHERE telegram_bot_id = $1 AND connection_token IS NOT NULL`,
      [bot.id]
    );
    const resolved = resolveConnectionToken(pending, presentedToken);
    if (!resolved) continue;

    await pool.query(
      `UPDATE matching_dubai.broker_telegram_accounts
       SET telegram_user_id = $1, telegram_chat_id = $2, telegram_username = $3,
           telegram_first_name = $4, telegram_last_name = $5,
           is_verified = TRUE, connected_at = now(), updated_at = now()
       WHERE id = $6`,
      [
        String(msg.from.id),
        String(msg.chat.id),
        msg.from.username || null,
        msg.from.first_name || null,
        msg.from.last_name || null,
        resolved.id,
      ]
    );
  }

  await pool.query(
    `UPDATE matching_dubai.telegram_bots SET last_update_id = $1, last_healthcheck_at = now() WHERE id = $2`,
    [maxUpdateId, bot.id]
  );
}

// start(pool) begins polling every active, token-bearing bot on an
// interval and returns { stop }. `fetchImpl` is injectable for tests --
// defaults to the global fetch (Node 20+, this project's documented
// engine, has it built in).
function start(pool, { fetchImpl = fetch, intervalMs = POLL_INTERVAL_MS } = {}) {
  let stopped = false;
  let inFlight = false;

  async function tick() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const { rows: bots } = await pool.query(
        `SELECT id, bot_token, last_update_id FROM matching_dubai.telegram_bots
         WHERE bot_token IS NOT NULL AND bot_token <> '' AND status <> 'DISABLED'`
      );
      for (const bot of bots) {
        await pollOneBot(pool, bot, fetchImpl);
      }
    } catch (err) {
      console.error('[telegram-bot-poller] tick failed:', err.message);
    } finally {
      inFlight = false;
    }
  }

  const handle = setInterval(tick, intervalMs);
  return { stop: () => { stopped = true; clearInterval(handle); } };
}

module.exports = { start, pollOneBot };
