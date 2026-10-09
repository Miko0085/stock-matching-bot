'use strict';

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { getPool, ensureMigrated } = require('./helpers/setup');
const brokerAdmin = require('../../dashboard/broker-admin-queries');

before(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  const pool = getPool();
  await pool.query('DELETE FROM matching_dubai.notification_deliveries');
  await pool.query('DELETE FROM matching_dubai.broker_notification_routes');
  await pool.query('DELETE FROM matching_dubai.broker_telegram_accounts');
  await pool.query(`DELETE FROM matching_dubai.stock_inventory WHERE stock_id LIKE 'SCHEMA-TEST-%'`);
  await pool.query(`DELETE FROM matching_dubai.brokers WHERE normalized_phone LIKE '9715%'`);
});

async function seedBroker(pool, { normalizedPhone = '971500000001', name = 'Test Broker' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO matching_dubai.brokers (name, phone, normalized_phone) VALUES ($1, $2, $3) RETURNING id`,
    [name, `+${normalizedPhone}`, normalizedPhone]
  );
  return rows[0].id;
}

test('migration 0045: brokers.normalized_phone is unique', async () => {
  const pool = getPool();
  await seedBroker(pool, { normalizedPhone: '971500000002' });
  await assert.rejects(
    () => pool.query(`INSERT INTO matching_dubai.brokers (name, normalized_phone) VALUES ('Dup', '971500000002')`),
    /duplicate key value violates unique constraint/
  );
});

test('migration 0045: notification_deliveries.idempotency_key is nullable (the legacy request+broker+channel key is no longer required)', async () => {
  const pool = getPool();
  const brokerId = await seedBroker(pool);
  await pool.query(
    `INSERT INTO matching_dubai.notification_deliveries (source_message_id, broker_id, channel, stock_id, status)
     VALUES ('req-x', $1, 'WHATSAPP', 'SCHEMA-TEST-1', 'SENT')`,
    [brokerId]
  );
});

test('THE DEDUP GUARANTEE: a second row for the same (stock_id, source_message_id, channel) violates the unique index', async () => {
  const pool = getPool();
  const brokerId = await seedBroker(pool);
  await pool.query(
    `INSERT INTO matching_dubai.notification_deliveries (source_message_id, broker_id, channel, stock_id, status)
     VALUES ('req-dedup', $1, 'WHATSAPP', 'SCHEMA-TEST-2', 'SENT')`,
    [brokerId]
  );
  await assert.rejects(
    () => pool.query(
      `INSERT INTO matching_dubai.notification_deliveries (source_message_id, broker_id, channel, stock_id, status)
       VALUES ('req-dedup', $1, 'WHATSAPP', 'SCHEMA-TEST-2', 'SENT')`,
      [brokerId]
    ),
    /duplicate key value violates unique constraint/
  );
});

test('THE DEDUP GUARANTEE: the same stock_id+request is fine under a DIFFERENT channel (dedup is per-channel, not global)', async () => {
  const pool = getPool();
  const brokerId = await seedBroker(pool);
  await pool.query(
    `INSERT INTO matching_dubai.notification_deliveries (source_message_id, broker_id, channel, stock_id, status)
     VALUES ('req-multi', $1, 'WHATSAPP', 'SCHEMA-TEST-3', 'SENT')`,
    [brokerId]
  );
  await pool.query(
    `INSERT INTO matching_dubai.notification_deliveries (source_message_id, broker_id, channel, stock_id, status)
     VALUES ('req-multi', $1, 'TELEGRAM', 'SCHEMA-TEST-3', 'SENT')`,
    [brokerId]
  );
  const { rows } = await pool.query(
    `SELECT channel FROM matching_dubai.notification_deliveries WHERE source_message_id = 'req-multi' ORDER BY channel`
  );
  assert.deepEqual(rows.map((r) => r.channel), ['TELEGRAM', 'WHATSAPP']);
});

test('migration 0045: broker_notification_routes upsert is one row per (broker, channel) -- a second save updates in place, never duplicates', async () => {
  const pool = getPool();
  const brokerId = await seedBroker(pool);
  await brokerAdmin.upsertBrokerNotificationRoute(pool, { brokerId, channel: 'WHATSAPP', enabled: false, whatsappAccountId: 'wa_old' });
  await brokerAdmin.upsertBrokerNotificationRoute(pool, { brokerId, channel: 'WHATSAPP', enabled: true, whatsappAccountId: 'wa_new' });

  const { rows } = await pool.query(
    `SELECT enabled, whatsapp_account_id FROM matching_dubai.broker_notification_routes WHERE broker_id = $1 AND channel = 'WHATSAPP'`,
    [brokerId]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].enabled, true);
  assert.equal(rows[0].whatsapp_account_id, 'wa_new');
});

test('migration 0045: telegram_bots.last_update_id defaults to NULL on a freshly-inserted bot', async () => {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO matching_dubai.telegram_bots (name, status) VALUES ('Schema Test Bot', 'UNKNOWN') RETURNING last_update_id`
  );
  assert.equal(rows[0].last_update_id, null);
  await pool.query(`DELETE FROM matching_dubai.telegram_bots WHERE name = 'Schema Test Bot'`);
});

test('listBrokerNotificationRoutes: a broker with zero configured routes still appears once (LEFT JOIN), with both channels implicitly off', async () => {
  const pool = getPool();
  await seedBroker(pool, { normalizedPhone: '971500000009', name: 'No Routes Yet' });
  const rows = await brokerAdmin.listBrokerNotificationRoutes(pool);
  const mine = rows.filter((r) => r.broker_name === 'No Routes Yet');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].channel, null);
});
