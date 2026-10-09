'use strict';

// Read/write queries for broker administration (brokers, Telegram bot
// mapping, Joker external identity mapping). Kept separate from
// queries.js, which is documented as strictly read-only reporting against
// matching.v_* views — these are admin actions against base tables.

async function listBrokers(pool) {
  const { rows } = await pool.query(`
    SELECT
      b.id, b.name, b.phone, b.email, b.is_active, b.created_at,
      (SELECT count(*) FROM matching_dubai.stock_inventory s WHERE s.broker_id = b.id) AS stock_count,
      (SELECT count(*) FROM matching_dubai.match_results mr WHERE mr.broker_id = b.id) AS match_count,
      (SELECT count(*) FROM matching_dubai.match_results mr WHERE mr.broker_id = b.id AND mr.match_status = 'STRONG_MATCH') AS strong_match_count,
      ei.source AS joker_source, ei.external_agent_id AS joker_agent_id,
      ta.id AS telegram_account_id, ta.is_verified AS telegram_verified, ta.is_active AS telegram_active,
      ta.telegram_username, ta.telegram_chat_id, ta.connected_at AS telegram_connected_at,
      ta.connection_token, ta.connection_token_expires_at, tb.bot_username AS telegram_bot_username
    FROM matching_dubai.brokers b
    LEFT JOIN matching_dubai.broker_external_identities ei ON ei.broker_id = b.id AND ei.source = 'JOKER'
    LEFT JOIN matching_dubai.broker_telegram_accounts ta ON ta.id = (
      SELECT id FROM matching_dubai.broker_telegram_accounts
      WHERE broker_id = b.id AND is_active
      ORDER BY created_at DESC LIMIT 1
    )
    LEFT JOIN matching_dubai.telegram_bots tb ON tb.id = ta.telegram_bot_id
    ORDER BY b.name ASC
  `);
  return rows;
}

async function getBroker(pool, id) {
  const { rows } = await pool.query('SELECT * FROM matching_dubai.brokers WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createBroker(pool, { name, phone = null, email = null }) {
  const { rows } = await pool.query(
    'INSERT INTO matching_dubai.brokers (name, phone, email) VALUES ($1, $2, $3) RETURNING *',
    [name, phone, email]
  );
  return rows[0];
}

async function listTelegramBots(pool) {
  const { rows } = await pool.query('SELECT * FROM matching_dubai.telegram_bots ORDER BY created_at ASC');
  return rows;
}

// The platform runs one notification bot for every broker (the schema
// still supports several — see docs/TELEGRAM_BOT_AND_USER_MANAGEMENT.md —
// but the common case is a single bot, so the UI shouldn't force a picker
// for it). is_default wins if set; otherwise the oldest bot is the
// implicit default.
async function getDefaultTelegramBot(pool) {
  const { rows } = await pool.query(
    'SELECT * FROM matching_dubai.telegram_bots ORDER BY is_default DESC, created_at ASC LIMIT 1'
  );
  return rows[0] || null;
}

async function createTelegramBot(pool, { name, botUsername = null, botToken = null }) {
  const { rows } = await pool.query(
    `INSERT INTO matching_dubai.telegram_bots (name, bot_username, bot_token, status)
     VALUES ($1, $2, $3, 'UNKNOWN') RETURNING *`,
    [name, botUsername, botToken]
  );
  return rows[0];
}

async function listBrokerTelegramAccounts(pool, brokerId) {
  const { rows } = await pool.query(
    `SELECT ta.*, tb.name AS bot_name, tb.bot_username
     FROM matching_dubai.broker_telegram_accounts ta
     LEFT JOIN matching_dubai.telegram_bots tb ON tb.id = ta.telegram_bot_id
     WHERE ta.broker_id = $1
     ORDER BY ta.created_at DESC`,
    [brokerId]
  );
  return rows;
}

// Creates the PENDING row for a /start=<token> handshake: no Telegram
// identity yet (filled in once the bot's /start webhook resolves the
// token via src/core/telegram-connection.js's resolveConnectionToken).
async function createPendingTelegramConnection(pool, { brokerId, telegramBotId, token, expiresAt }) {
  const { rows } = await pool.query(
    `INSERT INTO matching_dubai.broker_telegram_accounts
       (broker_id, telegram_bot_id, is_verified, is_active, connection_token, connection_token_expires_at)
     VALUES ($1, $2, FALSE, TRUE, $3, $4)
     RETURNING *`,
    [brokerId, telegramBotId, token, expiresAt]
  );
  return rows[0];
}

async function deactivateTelegramAccount(pool, id) {
  await pool.query(
    `UPDATE matching_dubai.broker_telegram_accounts SET is_active = FALSE, updated_at = now() WHERE id = $1`,
    [id]
  );
}

async function listBrokerExternalIdentities(pool, brokerId) {
  const { rows } = await pool.query(
    'SELECT * FROM matching_dubai.broker_external_identities WHERE broker_id = $1 ORDER BY created_at DESC',
    [brokerId]
  );
  return rows;
}

async function findBrokerExternalIdentity(pool, source, externalAgentId) {
  const { rows } = await pool.query(
    'SELECT * FROM matching_dubai.broker_external_identities WHERE source = $1 AND external_agent_id = $2',
    [source, String(externalAgentId)]
  );
  return rows[0] || null;
}

async function upsertBrokerExternalIdentity(pool, { brokerId, source, externalUserId = null, externalAgentId = null, externalLogin = null, rawSourceJson = null }) {
  const { rows } = await pool.query(
    `INSERT INTO matching_dubai.broker_external_identities
       (broker_id, source, external_user_id, external_agent_id, external_login, raw_source_json)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [brokerId, source, externalUserId, externalAgentId, externalLogin, rawSourceJson]
  );
  return rows[0];
}

// One row per (broker, channel actually configured) -- a broker with
// neither a TELEGRAM nor a WHATSAPP row yet still appears once (LEFT JOIN),
// so the /notifications page can always render a toggle row for every
// active broker, not only ones already configured.
async function listBrokerNotificationRoutes(pool) {
  const { rows } = await pool.query(`
    SELECT
      b.id AS broker_id, b.name AS broker_name, b.phone, b.normalized_phone,
      (SELECT count(*) FROM matching_dubai.stock_inventory s WHERE s.broker_id = b.id AND s.status = 'ACTIVE') AS active_stock_count,
      r.channel, r.enabled, r.destination, r.whatsapp_account_id, r.telegram_bot_id, r.telegram_account_id
    FROM matching_dubai.brokers b
    LEFT JOIN matching_dubai.broker_notification_routes r ON r.broker_id = b.id
    WHERE b.is_active
    ORDER BY b.name ASC, r.channel ASC
  `);
  return rows;
}

// One route per (broker, channel) -- migration 0045's
// uq_broker_notification_routes_broker_channel makes this a true upsert,
// matching the simple per-channel toggle UI (flip a checkbox, pick a
// WhatsApp account, submit).
async function upsertBrokerNotificationRoute(pool, { brokerId, channel, enabled, destination = null, whatsappAccountId = null, telegramBotId = null }) {
  const { rows } = await pool.query(
    `INSERT INTO matching_dubai.broker_notification_routes
       (broker_id, channel, enabled, destination, whatsapp_account_id, telegram_bot_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (broker_id, channel) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       destination = EXCLUDED.destination,
       whatsapp_account_id = EXCLUDED.whatsapp_account_id,
       telegram_bot_id = COALESCE(EXCLUDED.telegram_bot_id, matching_dubai.broker_notification_routes.telegram_bot_id),
       updated_at = now()
     RETURNING *`,
    [brokerId, channel, enabled, destination, whatsappAccountId, telegramBotId]
  );
  return rows[0];
}

module.exports = {
  listBrokers,
  getBroker,
  createBroker,
  listTelegramBots,
  getDefaultTelegramBot,
  createTelegramBot,
  listBrokerTelegramAccounts,
  createPendingTelegramConnection,
  deactivateTelegramAccount,
  listBrokerExternalIdentities,
  findBrokerExternalIdentity,
  upsertBrokerExternalIdentity,
  listBrokerNotificationRoutes,
  upsertBrokerNotificationRoute,
};
