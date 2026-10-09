'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { groupRoutesByBroker, renderBrokerRoutesPanel, renderStatsPanel } = require('../../dashboard/notifications-view');

test('groupRoutesByBroker: a broker with no configured route yet still appears once, both channels off', () => {
  const rows = [{ broker_id: 1, broker_name: 'Anna', phone: '+971501111111', normalized_phone: '971501111111', active_stock_count: 3, channel: null, enabled: null, destination: null, whatsapp_account_id: null, telegram_bot_id: null }];
  const brokers = groupRoutesByBroker(rows);
  assert.equal(brokers.length, 1);
  assert.equal(brokers[0].telegram.enabled, false);
  assert.equal(brokers[0].whatsapp.enabled, false);
});

test('groupRoutesByBroker: TELEGRAM and WHATSAPP rows for the same broker merge into one broker entry', () => {
  const rows = [
    { broker_id: 1, broker_name: 'Anna', phone: '+971501111111', active_stock_count: 3, channel: 'TELEGRAM', enabled: true, telegram_bot_id: 5 },
    { broker_id: 1, broker_name: 'Anna', phone: '+971501111111', active_stock_count: 3, channel: 'WHATSAPP', enabled: true, whatsapp_account_id: 'wa_anna', destination: '971501111111' },
  ];
  const brokers = groupRoutesByBroker(rows);
  assert.equal(brokers.length, 1);
  assert.equal(brokers[0].telegram.enabled, true);
  assert.equal(brokers[0].telegram.telegramBotId, 5);
  assert.equal(brokers[0].whatsapp.enabled, true);
  assert.equal(brokers[0].whatsapp.whatsappAccountId, 'wa_anna');
});

test('groupRoutesByBroker: two different brokers never merge', () => {
  const rows = [
    { broker_id: 1, broker_name: 'Anna', channel: null, active_stock_count: 1 },
    { broker_id: 2, broker_name: 'Boris', channel: null, active_stock_count: 2 },
  ];
  assert.equal(groupRoutesByBroker(rows).length, 2);
});

test('renderBrokerRoutesPanel: an empty broker list renders a helpful empty-state message, not a broken table', () => {
  const html = renderBrokerRoutesPanel([], []);
  assert.match(html, /Брокеров пока нет/);
});

test('renderBrokerRoutesPanel: a checked Telegram toggle reflects enabled=true', () => {
  const brokers = [{ brokerId: 1, brokerName: 'Anna', phone: '+971501111111', activeStockCount: 3, telegram: { enabled: true }, whatsapp: { enabled: false, whatsappAccountId: null } }];
  const html = renderBrokerRoutesPanel(brokers, []);
  assert.match(html, /name="telegram_enabled" value="1" checked/);
});

test('renderBrokerRoutesPanel: the WhatsApp account dropdown lists every supplied account, with the saved one selected', () => {
  const brokers = [{ brokerId: 1, brokerName: 'Anna', phone: '+971501111111', activeStockCount: 3, telegram: { enabled: false }, whatsapp: { enabled: true, whatsappAccountId: 'wa_anna' } }];
  const accounts = [{ account_id: 'wa_anna', connected: true }, { account_id: 'wa_backup', connected: false }];
  const html = renderBrokerRoutesPanel(brokers, accounts);
  assert.match(html, /<option value="wa_anna" selected>wa_anna<\/option>/);
  assert.match(html, /<option value="wa_backup" >wa_backup \(не подключён\)<\/option>/);
});

test('renderBrokerRoutesPanel: zero connected WhatsApp accounts shows a placeholder option, never an empty/broken select', () => {
  const brokers = [{ brokerId: 1, brokerName: 'Anna', phone: null, activeStockCount: 0, telegram: { enabled: false }, whatsapp: { enabled: false, whatsappAccountId: null } }];
  const html = renderBrokerRoutesPanel(brokers, []);
  assert.match(html, /нет подключённых аккаунтов/);
});

test('renderStatsPanel: from/to query values pre-fill the date inputs', () => {
  const stats = { byChannel: { TELEGRAM: { sent: 1, failed: 0, skipped: 0 }, WHATSAPP: { sent: 2, failed: 1, skipped: 0 } }, totalSent: 3, totalFailed: 1, usingCalendar: true };
  const html = renderStatsPanel(stats, { from: '2026-10-01', to: '2026-10-05' });
  assert.match(html, /name="from" value="2026-10-01"/);
  assert.match(html, /name="to" value="2026-10-05"/);
});

test('renderStatsPanel: when using the calendar range, no rolling-period tab is marked active', () => {
  const stats = { byChannel: { TELEGRAM: { sent: 0, failed: 0, skipped: 0 }, WHATSAPP: { sent: 0, failed: 0, skipped: 0 } }, totalSent: 0, totalFailed: 0, usingCalendar: true };
  const html = renderStatsPanel(stats, { from: '2026-10-01' });
  assert.ok(!html.includes('class="active"'));
});
