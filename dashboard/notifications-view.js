'use strict';

// Pure HTML-rendering helpers for the /notifications page (renamed from
// /telegram-bots) -- no DB access, data-in/HTML-out, directly
// unit-testable, following the same split dashboard/summary-view.js and
// dashboard/stock-view.js already use.

const { escapeHtml } = require('./render');

// Pivots the flat listBrokerNotificationRoutes(pool) rows (one row per
// broker per configured channel, LEFT JOINed so a broker with zero routes
// yet still appears once with channel=null) into one object per broker
// with its TELEGRAM/WHATSAPP route folded in. Pure -- no DB access, so the
// pivot logic is independently testable from the SQL shape.
function groupRoutesByBroker(rows) {
  const byBroker = new Map();
  for (const row of rows) {
    if (!byBroker.has(row.broker_id)) {
      byBroker.set(row.broker_id, {
        brokerId: row.broker_id,
        brokerName: row.broker_name,
        phone: row.phone,
        normalizedPhone: row.normalized_phone,
        activeStockCount: Number(row.active_stock_count) || 0,
        telegram: { enabled: false, telegramBotId: null },
        whatsapp: { enabled: false, whatsappAccountId: null, destination: null },
      });
    }
    const broker = byBroker.get(row.broker_id);
    if (row.channel === 'TELEGRAM') {
      broker.telegram = { enabled: !!row.enabled, telegramBotId: row.telegram_bot_id };
    } else if (row.channel === 'WHATSAPP') {
      broker.whatsapp = { enabled: !!row.enabled, whatsappAccountId: row.whatsapp_account_id, destination: row.destination };
    }
  }
  return Array.from(byBroker.values());
}

function renderBotsTable(renderTable, bots) {
  return renderTable(bots, { columns: ['id', 'name', 'bot_username', 'status', 'is_default', 'last_healthcheck_at', 'last_error'] });
}

function renderAddBotForm() {
  return `<form class="filters" method="post" action="/notifications">
    <input name="name" placeholder="Название бота" required>
    <input name="bot_username" placeholder="Имя пользователя бота (без @)">
    <input name="bot_token" placeholder="Токен бота (из BotFather)">
    <button type="submit">Добавить бота</button>
  </form>`;
}

// One row per broker: Telegram toggle, WhatsApp toggle + sending-account
// dropdown. Both channels submit together (one form per broker row) --
// the no-channel-configured case (scope item 4: skip silently in the
// pipeline) is simply both checkboxes unticked, nothing special to render.
function renderBrokerRoutesPanel(brokers, whatsappAccounts) {
  if (!brokers.length) return '<p class="empty">Брокеров пока нет. Добавьте их на странице <a href="/brokers">«Брокеры»</a>.</p>';

  const accountOptions = (selected) =>
    whatsappAccounts.length
      ? whatsappAccounts
          .map((a) => `<option value="${escapeHtml(a.account_id)}" ${a.account_id === selected ? 'selected' : ''}>${escapeHtml(a.account_id)}${a.connected ? '' : ' (не подключён)'}</option>`)
          .join('')
      : '<option value="">нет подключённых аккаунтов</option>';

  const rows = brokers
    .map((b) => `
      <tr>
        <td><a href="/brokers/${b.brokerId}">${escapeHtml(b.brokerName)}</a></td>
        <td>${escapeHtml(b.phone || '—')}</td>
        <td>${escapeHtml(b.activeStockCount)}</td>
        <td colspan="2">
          <form class="filters" method="post" action="/notifications/routes/${b.brokerId}">
            <label><input type="checkbox" name="telegram_enabled" value="1" ${b.telegram.enabled ? 'checked' : ''}> Telegram</label>
            <label><input type="checkbox" name="whatsapp_enabled" value="1" ${b.whatsapp.enabled ? 'checked' : ''}> WhatsApp</label>
            <select name="whatsapp_account_id">${accountOptions(b.whatsapp.whatsappAccountId)}</select>
            <button type="submit">Сохранить</button>
          </form>
        </td>
      </tr>`)
    .join('');

  return `<div class="table-wrap"><table>
    <thead><tr><th>Брокер</th><th>Контакт</th><th>Активных объектов</th><th colspan="2">Каналы уведомлений</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

const STATS_PERIOD_LABELS = { '24h': 'Последние 24 часа', '7d': '7 дней', '30d': '30 дней', all: 'Всё время' };

function renderStatsPanel(stats, query) {
  const periodTabs = Object.entries(STATS_PERIOD_LABELS)
    .map(([v, label]) => `<a href="/notifications?period=${v}" class="${!stats.usingCalendar && (query.period || '7d') === v ? 'active' : ''}">${label}</a>`)
    .join('');

  const dateForm = `<form class="filters" method="get" action="/notifications">
    <input type="date" name="from" value="${escapeHtml(query.from || '')}">
    <input type="date" name="to" value="${escapeHtml(query.to || '')}">
    <button type="submit">Произвольный период</button>
  </form>`;

  const row = (label, counts) => `
    <tr><td>${escapeHtml(label)}</td><td>${escapeHtml(counts.sent)}</td><td>${escapeHtml(counts.failed)}</td><td>${escapeHtml(counts.skipped)}</td></tr>`;

  const table = `<table>
    <thead><tr><th>Канал</th><th>Отправлено</th><th>Ошибка</th><th>Прочее</th></tr></thead>
    <tbody>
      ${row('Telegram', stats.byChannel.TELEGRAM)}
      ${row('WhatsApp', stats.byChannel.WHATSAPP)}
    </tbody>
  </table>`;

  return `<div class="period-tabs">${periodTabs}</div>
    ${dateForm}
    <div class="kpis">
      <div class="kpi"><div class="value">${escapeHtml(stats.totalSent)}</div><div class="label">Всего отправлено</div></div>
      <div class="kpi"><div class="value">${escapeHtml(stats.totalFailed)}</div><div class="label">Всего ошибок</div></div>
    </div>
    <div class="table-wrap">${table}</div>`;
}

module.exports = { groupRoutesByBroker, renderBotsTable, renderAddBotForm, renderBrokerRoutesPanel, renderStatsPanel };
