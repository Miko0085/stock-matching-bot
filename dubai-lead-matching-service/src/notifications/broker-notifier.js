'use strict';

// Per-broker MATCH notifications -- a SEPARATE, additive step from the
// existing shared-group Telegram broadcast (telegram-sender.js, called
// directly from pipeline.js). This module tells the property's OWN broker
// their listing just matched a buyer, via their personally-linked
// Telegram account and/or WhatsApp, gated entirely by per-broker opt-in
// (matching_dubai.broker_notification_routes) and dormant until a real
// brokers.normalized_phone/route exists -- see
// scripts/broker-backfill-from-stock-contacts-run.js and the /notifications
// dashboard page.
//
// Off by default (config.brokerNotificationsEnabled), same posture as the
// existing telegramNotificationsEnabled flag: deploying this code changes
// nothing until an operator explicitly opts in.
const crypto = require('crypto');
const { normalizePhoneDigits } = require('../../../src/core/phone-normalize');
const { buildBrokerNotificationMessages } = require('../../../src/core/broker-notifications');
const { sendMatchNotification } = require('./telegram-sender');

async function sendWhatsapp({ whatsappWorkerUrl, workerApiKey, accountId, phone, message, timeoutMs = 10000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${whatsappWorkerUrl}/whatsapp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': workerApiKey },
      body: JSON.stringify({ account_id: accountId, phone, message }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Groups matched stock by the broker's own normalized phone (NOT
// entry.stock.broker_id, which is 0% populated in production -- see
// AGENTS.md's confirmed-scope notes for this feature). An entry with no
// normalizable broker_contact is excluded here, never throws (scope item
// 4: no identity to route to, skip silently).
function groupMatchesByBrokerPhone(matches) {
  const groups = new Map();
  for (const entry of matches) {
    const normalized = normalizePhoneDigits(entry.stock.broker_contact);
    if (!normalized) continue;
    if (!groups.has(normalized)) groups.set(normalized, []);
    groups.get(normalized).push(entry);
  }
  return groups;
}

// One channel's delivery for one broker's batch of NEWLY-matched stock
// (the caller has already excluded whatever was previously notified).
// Resolves the real destination, sends ONE bundled message (reusing the
// existing, unit-tested buildBrokerNotificationMessages chunking), and
// records one notification_deliveries row PER stock_id -- this is where
// the DB-enforced "one notification per (stock_id, source_message_id,
// channel) pair" guarantee (migration 0045) actually gets written.
async function deliverRouteNotifications({ pool, sourceMessageId, broker, route, entries, normalizedRequest, normalizedPhone, config, sendTelegram, sendWhatsappFn }) {
  const stockIds = entries.map((e) => e.stock.stock_id);
  const { rows: already } = await pool.query(
    `SELECT stock_id FROM matching_dubai.notification_deliveries
     WHERE source_message_id = $1 AND channel = $2 AND stock_id = ANY($3::text[])`,
    [sourceMessageId, route.channel, stockIds]
  );
  const alreadySet = new Set(already.map((r) => r.stock_id));
  const remaining = entries.filter((e) => !alreadySet.has(e.stock.stock_id));
  if (remaining.length === 0) return; // true no-op: this (broker, request, channel) is already fully notified

  let destination;
  let telegramBotToken;
  if (route.channel === 'TELEGRAM') {
    const { rows: accounts } = await pool.query(
      `SELECT ta.telegram_chat_id, tb.bot_token FROM matching_dubai.broker_telegram_accounts ta
       JOIN matching_dubai.telegram_bots tb ON tb.id = ta.telegram_bot_id
       WHERE ta.broker_id = $1 AND ta.is_verified AND ta.is_active AND ta.telegram_chat_id IS NOT NULL
       ORDER BY ta.connected_at DESC LIMIT 1`,
      [broker.id]
    );
    if (accounts.length === 0) return; // not linked/verified yet -- skip silently
    destination = accounts[0].telegram_chat_id;
    telegramBotToken = accounts[0].bot_token;
    if (!telegramBotToken) return;
  } else if (route.channel === 'WHATSAPP') {
    destination = route.destination || normalizedPhone;
    if (!destination || !route.whatsapp_account_id) return; // no sending account chosen -- skip silently
  } else {
    return; // EMAIL and any future channel: not implemented yet, skip silently
  }

  const messages = buildBrokerNotificationMessages({
    sourceMessageId,
    brokerId: broker.id,
    normalizedRequest,
    matches: remaining.map((entry) => ({ stock: entry.stock, score: entry.score, status: 'MATCH' })),
    maxMessageLength: config.telegramMaxMessageLength,
  });

  let sendResult;
  if (route.channel === 'TELEGRAM') {
    sendResult = await sendTelegram({ botToken: telegramBotToken, chatId: destination, messages });
  } else {
    sendResult = { ok: true, results: [] };
    for (const text of messages) {
      const one = await sendWhatsappFn({
        whatsappWorkerUrl: config.whatsappWorkerUrl,
        workerApiKey: config.workerApiKey,
        accountId: route.whatsapp_account_id,
        phone: destination,
        message: text,
      });
      sendResult.results.push(one);
      if (!one.ok) sendResult.ok = false;
    }
  }

  // A failed attempt still claims these stock_ids (status FAILED, not
  // skipped) -- a hard channel outage must not turn into an endless resend
  // storm on every reprocess of the same request. Documented tradeoff: a
  // genuine resend after fixing an outage needs an operator to clear the
  // FAILED rows, no retry UI exists yet.
  const batchId = crypto.randomUUID();
  const status = sendResult.ok ? 'SENT' : 'FAILED';
  const errorText = sendResult.ok ? null : JSON.stringify(sendResult.results || sendResult.error || null).slice(0, 2000);

  for (const entry of remaining) {
    await pool.query(
      `INSERT INTO matching_dubai.notification_deliveries
         (source_message_id, broker_id, channel, route_id, destination, stock_id, source_message_broker_batch_id, status, error_text, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $8 = 'SENT' THEN now() ELSE NULL END)
       ON CONFLICT (stock_id, source_message_id, channel) DO NOTHING`,
      [sourceMessageId, broker.id, route.channel, route.id, destination, entry.stock.stock_id, batchId, status, errorText]
    );
  }
}

// Entry point, called from pipeline.js's MATCH branch, after match_results
// persistence and after the existing shared-group broadcast -- in its own
// try/catch there, never able to affect either.
async function notifyMatchedBrokers({ pool, sourceMessageId, structuredRequest, matches, config, deps = {} }) {
  if (!config.brokerNotificationsEnabled) return;

  const groups = groupMatchesByBrokerPhone(matches);
  if (groups.size === 0) return;

  const sendTelegram = deps.sendTelegram || sendMatchNotification;
  const sendWhatsappFn = deps.sendWhatsapp || sendWhatsapp;
  const normalizedRequest = {
    area: structuredRequest.area,
    budgetMin: structuredRequest.budget_min,
    budgetMax: structuredRequest.budget_max,
  };

  for (const [normalizedPhone, entries] of groups) {
    const { rows: brokerRows } = await pool.query(
      `SELECT id FROM matching_dubai.brokers WHERE normalized_phone = $1`,
      [normalizedPhone]
    );
    const broker = brokerRows[0];
    if (!broker) continue; // no backfilled/linked broker identity yet -- skip silently

    const { rows: routeRows } = await pool.query(
      `SELECT * FROM matching_dubai.broker_notification_routes WHERE broker_id = $1 AND enabled`,
      [broker.id]
    );
    if (routeRows.length === 0) continue; // no channel enabled for this broker -- skip silently

    for (const route of routeRows) {
      await deliverRouteNotifications({ pool, sourceMessageId, broker, route, entries, normalizedRequest, normalizedPhone, config, sendTelegram, sendWhatsappFn });
    }
  }
}

module.exports = { notifyMatchedBrokers, groupMatchesByBrokerPhone, sendWhatsapp };
