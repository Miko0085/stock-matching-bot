#!/usr/bin/env node
'use strict';

require('dotenv').config();
const http = require('http');
const { URL } = require('url');
const { createPool } = require('../src/db/pool');
const queries = require('./queries');
const { renderTable, pageLayout, renderBarChart, renderPagination, escapeHtml } = require('./render');
const workers = require('./workers');
const brokerAdmin = require('./broker-admin-queries');
const stockAdminQueries = require('./stock-admin-queries');
const jokerStockAdminQueries = require('./joker-stock-admin-queries');
const stockView = require('./stock-view');
const pocketListingQueries = require('./pocket-listing-queries');
const sourceQueries = require('./source-queries');
const jokerClient = require('./joker-client');
const summaryQueries = require('./summary-queries');
const summaryView = require('./summary-view');
const settingsQueries = require('./settings-queries');
const moscowSettingsQueries = require('./moscow-settings-queries');
const abuDhabiSettingsQueries = require('./abu-dhabi-settings-queries');
const settingsView = require('./settings-view');
const shadowQueries = require('./shadow-queries');
const shadowView = require('./shadow-view');
const { generateConnectionToken } = require('../src/core/telegram-connection');
const notificationsView = require('./notifications-view');
const notificationStatsQueries = require('./notification-stats-queries');
const telegramBotPoller = require('./telegram-bot-poller');

const PORT = Number(process.env.DASHBOARD_PORT) || 8094;
const AUTH_USER = process.env.DASHBOARD_USERNAME || '';
const AUTH_PASS = process.env.DASHBOARD_PASSWORD || '';

const pool = createPool();

function checkAuth(req, res) {
  if (!AUTH_USER || !AUTH_PASS) return true; // unauthenticated mode — internal network only
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, pass] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
    if (user === AUTH_USER && pass === AUTH_PASS) return true;
  }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Панель NIKA PILOT"', 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Требуется авторизация.');
  return false;
}

function send(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function statusBadge(label, level) {
  return `<span class="badge ${level}">${escapeHtml(label)}</span>`;
}

const STATUS_LABELS = {
  connected: 'подключён',
  disconnected: 'отключён',
  connecting: 'подключение',
  waiting_for_qr: 'ожидание QR-кода',
  needs_password: 'требуется пароль',
  requires_auth: 'требуется авторизация',
  requires_attention: 'требуется внимание',
  error: 'ошибка',
  active: 'активен',
  inactive: 'неактивен',
  pending: 'ожидает подтверждения',
  verified: 'подтверждён',
  enabled: 'включено',
  disabled: 'выключено',
};

function displayStatus(value) {
  return STATUS_LABELS[value] || value;
}

function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

function bucketLabel(bucket, granularity) {
  const d = new Date(bucket);
  if (granularity === 'month') return d.toLocaleDateString('ru-RU', { month: 'short', year: '2-digit' });
  if (granularity === 'week') return d.toLocaleDateString('ru-RU', { month: 'short', day: 'numeric' });
  return d.toLocaleDateString('ru-RU', { month: 'short', day: 'numeric' });
}

function telegramCard(telegram, loginByAccount) {
  if (!telegram.reachable) {
    return `<div class="channel-card">
      <h3>Служба Telegram</h3>
      ${statusBadge('недоступна', 'error')}
      <dl><dt>Ошибка</dt><dd>${escapeHtml(telegram.error || 'неизвестно')}</dd></dl>
    </div>`;
  }
  const accountRows = telegram.accounts
    .map((a) => {
      const level = a.connected && a.authorized ? 'ok' : 'error';
      const login = loginByAccount[a.account_id];

      let actionBlock = '';
      let qrBlock = '';
      if (a.connected && a.authorized) {
        const pauseForm = a.paused
          ? `<form class="inline" method="post" action="/channels/telegram/resume">
              <input type="hidden" name="account_id" value="${escapeHtml(a.account_id)}">
              <button class="small" type="submit">Возобновить мониторинг</button>
            </form>`
          : `<form class="inline" method="post" action="/channels/telegram/pause" onsubmit="return confirm('Приостановить мониторинг для ${escapeHtml(a.account_id)}? Входящие сообщения будут игнорироваться до возобновления, а сессия останется подключённой.')">
              <input type="hidden" name="account_id" value="${escapeHtml(a.account_id)}">
              <button class="small" type="submit">Приостановить мониторинг</button>
            </form>`;
        actionBlock = `${pauseForm}
        <form class="inline" method="post" action="/channels/telegram/logout" onsubmit="return confirm('Выйти из аккаунта ${escapeHtml(a.account_id)} в Telegram? Сессия станет недействительной; каналы, маршрутизация и история совпадений не изменятся.')">
          <input type="hidden" name="account_id" value="${escapeHtml(a.account_id)}">
          <button class="small" type="submit">Выйти</button>
        </form>`;
      } else if (login && login.login_status === 'needs_password') {
        qrBlock = `<form class="inline" method="post" action="/channels/telegram/submit-password">
          <input type="hidden" name="account_id" value="${escapeHtml(a.account_id)}">
          <input type="password" name="password" placeholder="Пароль двухфакторной аутентификации" required>
          <button class="small" type="submit">Отправить</button>
        </form>
        ${login.error ? `<p class="empty">${escapeHtml(login.error)}</p>` : ''}`;
      } else if (login && login.login_status === 'waiting_for_scan' && login.qr_data_url) {
        qrBlock = `<div class="qr-box"><img src="${login.qr_data_url}" alt="QR-код Telegram"><p class="empty">Telegram &rarr; Настройки &rarr; Устройства &rarr; Подключить устройство</p></div>`;
      } else if (login && login.login_status === 'expired') {
        actionBlock = `<form class="inline" method="post" action="/channels/telegram/start-login">
          <input type="hidden" name="account_id" value="${escapeHtml(a.account_id)}">
          <button class="small" type="submit">QR-код истёк — начать вход заново</button>
        </form>`;
      } else if (!a.connected) {
        actionBlock = `<form class="inline" method="post" action="/channels/telegram/start-login">
          <input type="hidden" name="account_id" value="${escapeHtml(a.account_id)}">
          <button class="small" type="submit">Начать вход</button>
        </form>`;
      }

      return `<div>
        <dl>
          <dt>Аккаунт</dt><dd>${escapeHtml(a.account_id)} (${escapeHtml(a.username || a.name || '')})</dd>
          <dt>Статус</dt><dd>${statusBadge(displayStatus(a.status), level)}${a.paused ? ` ${statusBadge('мониторинг приостановлен', 'warn')}` : ''}</dd>
          ${a.error ? `<dt>Ошибка</dt><dd>${escapeHtml(a.error)}</dd>` : ''}
        </dl>
        ${actionBlock}
        ${qrBlock}
      </div>`;
    })
    .join('<hr style="border-color:#262a33;margin:10px 0">');
  return `<div class="channel-card">
    <h3>Служба Telegram</h3>
    ${statusBadge('доступна', 'ok')}
    <dl>
      <dt>Подключённые клиенты</dt><dd>${escapeHtml(telegram.health.connected_clients)}</dd>
      <dt>Отслеживаемые диалоги</dt><dd>${escapeHtml(telegram.destinationCount ?? '—')}</dd>
      <dt>Доставка через вебхук</dt><dd>${telegram.health.webhook_delivery_enabled ? statusBadge('включена', 'ok') : statusBadge('выключена', 'warn')}</dd>
    </dl>
    <hr style="border-color:#262a33;margin:10px 0">
    ${accountRows || '<p class="empty">Аккаунты не настроены.</p>'}
    <hr style="border-color:#262a33;margin:10px 0">
    <form class="inline" method="post" action="/channels/telegram/start-login">
      <input name="account_id" placeholder="Новый ID аккаунта (например, tg_second)" pattern="[A-Za-z0-9_-]{1,64}" required>
      <button class="small" type="submit">Добавить / подключить аккаунт</button>
    </form>
  </div>`;
}

function whatsappCard(whatsapp, qrByAccount) {
  if (!whatsapp.reachable) {
    return `<div class="channel-card">
      <h3>Служба WhatsApp</h3>
      ${statusBadge('недоступна', 'error')}
      <dl><dt>Ошибка</dt><dd>${escapeHtml(whatsapp.error || 'неизвестно')}</dd></dl>
    </div>`;
  }
  const accountBlocks = whatsapp.accounts
    .map((a) => {
      const level = a.connected ? 'ok' : a.requires_auth || a.status === 'requires_attention' ? 'error' : 'warn';
      const qr = qrByAccount[a.account_id];

      let actionBlock = '';
      let qrBlock = '';
      let throttleBlock = '';
      // Note: `requires_auth` is a sticky flag that stays true through the
      // whole waiting_for_qr phase after a real logout, so branch on the
      // precise `status` enum instead — not the boolean.
      if (a.connected) {
        const pauseForm = a.paused
          ? `<form class="inline" method="post" action="/channels/whatsapp/resume">
              <input type="hidden" name="account_id" value="${escapeHtml(a.account_id)}">
              <button class="small" type="submit">Возобновить мониторинг</button>
            </form>`
          : `<form class="inline" method="post" action="/channels/whatsapp/pause" onsubmit="return confirm('Приостановить мониторинг для ${escapeHtml(a.account_id)}? Входящие сообщения будут игнорироваться до возобновления, а сессия останется подключённой.')">
              <input type="hidden" name="account_id" value="${escapeHtml(a.account_id)}">
              <button class="small" type="submit">Приостановить мониторинг</button>
            </form>`;
        actionBlock = `${pauseForm}
        <form class="inline" method="post" action="/channels/whatsapp/logout" onsubmit="return confirm('Выйти из аккаунта ${escapeHtml(a.account_id)} в WhatsApp? Устройство будет отвязано; каналы, маршрутизация и история совпадений не изменятся.')">
          <input type="hidden" name="account_id" value="${escapeHtml(a.account_id)}">
          <button class="small" type="submit">Выйти</button>
        </form>`;
      } else if (a.status === 'requires_auth') {
        // WhatsApp-side logout/device-removal: the saved session is
        // permanently invalid. A plain reconnect would just fail the same
        // way again — the session files must be cleared first so a fresh
        // QR is issued.
        actionBlock = `<form class="inline" method="post" action="/channels/whatsapp/clear-session" onsubmit="return confirm('Сохранённая сессия WhatsApp для ${escapeHtml(a.account_id)} будет удалена, после чего начнётся новое сопряжение. Продолжить?')">
          <input type="hidden" name="account_id" value="${escapeHtml(a.account_id)}">
          <button class="small" type="submit">Очистить сессию и получить новый QR-код</button>
        </form>`;
        qrBlock = `<p class="empty">Сессия стала недействительной на стороне WhatsApp: устройство отвязано или выполнен выход. Нажмите «Очистить сессию и получить новый QR-код», затем обновите страницу через несколько секунд.</p>`;
      } else if (a.status === 'requires_attention') {
        // Auto-reconnect gave up after WA_RECONNECT_GIVE_UP_AFTER_MS of
        // unbroken disconnects/errors — not a real logout (session files
        // are still valid), just a persistent failure. A manual nudge
        // resets the backoff streak and tries again from scratch.
        actionBlock = `<form class="inline" method="post" action="/channels/whatsapp/reconnect">
          <input type="hidden" name="account_id" value="${escapeHtml(a.account_id)}">
          <button class="small" type="submit">Сбросить задержку и повторить сейчас</button>
        </form>`;
        qrBlock = `<p class="empty">Автоматическое переподключение остановилось после длительной серии сбоев. Это не выход: сессия всё ещё действительна, но стабильному соединению что-то мешает. Проверьте ошибку выше и повторите попытку.</p>`;
      } else if (!a.connected) {
        // connecting / waiting_for_qr / disconnected / error: the worker is
        // already retrying on its own. A manual nudge is harmless (it's a
        // no-op if already retrying) but never destructive here.
        actionBlock = `<form class="inline" method="post" action="/channels/whatsapp/reconnect">
          <input type="hidden" name="account_id" value="${escapeHtml(a.account_id)}">
          <button class="small" type="submit">Повторить подключение</button>
        </form>`;
        if (qr && qr.qr_data_url) {
          qrBlock = `<div class="qr-box"><img src="${qr.qr_data_url}" alt="QR-код WhatsApp"><p class="empty">Отсканируйте в WhatsApp &rarr; Связанные устройства</p></div>`;
        } else {
          qrBlock = `<p class="empty">Соединение восстанавливается автоматически — обычно никаких действий не требуется. Обновите страницу через несколько секунд.</p>`;
        }
        if (a.consecutive_failures > 0) {
          const nextRetry = a.next_retry_at ? new Date(a.next_retry_at).toLocaleTimeString() : '—';
          throttleBlock = `<dl>
            <dt>Сбоев подряд</dt><dd>${escapeHtml(a.consecutive_failures)}${a.throttled ? ' (действует задержка)' : ''}</dd>
            <dt>Следующая автоматическая попытка</dt><dd>${escapeHtml(nextRetry)}</dd>
          </dl>`;
        }
      }

      return `<div>
        <dl>
          <dt>Аккаунт</dt><dd>${escapeHtml(a.account_id)}</dd>
          <dt>Статус</dt><dd>${statusBadge(displayStatus(a.status), level)}${a.paused ? ` ${statusBadge('мониторинг приостановлен', 'warn')}` : ''}</dd>
          ${a.last_error ? `<dt>Последняя ошибка</dt><dd>${escapeHtml(a.last_error)}</dd>` : ''}
        </dl>
        ${throttleBlock}
        ${actionBlock}
        ${qrBlock}
      </div>`;
    })
    .join('<hr style="border-color:#262a33;margin:10px 0">');
  return `<div class="channel-card">
    <h3>Служба WhatsApp</h3>
    ${statusBadge('доступна', 'ok')}
    <dl>
      <dt>Загружено аккаунтов</dt><dd>${escapeHtml(whatsapp.health.accounts_loaded)}</dd>
      <dt>Настроено групп</dt><dd>${escapeHtml(whatsapp.health.group_monitor_groups_configured)}</dd>
      <dt>Вебхук мониторинга групп</dt><dd>${whatsapp.health.group_monitor_webhook_enabled ? statusBadge('включён', 'ok') : statusBadge('выключен', 'warn')}</dd>
    </dl>
    <hr style="border-color:#262a33;margin:10px 0">
    ${accountBlocks || '<p class="empty">Аккаунты не настроены.</p>'}
    <hr style="border-color:#262a33;margin:10px 0">
    <form class="inline" method="post" action="/channels/whatsapp/reconnect">
      <input name="account_id" placeholder="Новый ID аккаунта (например, wa_second)" pattern="[A-Za-z0-9_-]{1,64}" required>
      <button class="small" type="submit">Добавить / подключить аккаунт</button>
    </form>
  </div>`;
}

async function readFormBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

// One unified mapping table: broker <-> Joker identity <-> Telegram user,
// with inline actions, instead of three separate pages. There is one
// notification bot for everyone, so connecting Telegram is a single button
// (no bot picker) — the schema still allows more than one bot later, but
// the common case never needs to think about it.
function brokersTable(brokers, defaultBot) {
  if (!brokers.length) return '<p class="empty">Брокеров пока нет.</p>';
  const rows = brokers
    .map((b) => {
      const jokerCell = b.joker_agent_id
        ? `${statusBadge('сопоставлен', 'ok')} <span class="empty">#${escapeHtml(b.joker_agent_id)}</span>`
        : statusBadge('не сопоставлен', 'warn');

      let telegramCell;
      if (b.telegram_verified) {
        telegramCell = `${statusBadge('подключён', 'ok')} @${escapeHtml(b.telegram_username || b.telegram_chat_id)}
          <form class="inline" method="post" action="/brokers/${b.id}/telegram/${b.telegram_account_id}/disconnect">
            <button class="small" type="submit">Отключить</button>
          </form>`;
      } else if (b.telegram_account_id && b.connection_token) {
        const expired = new Date(b.connection_token_expires_at).getTime() < Date.now();
        const link = `https://t.me/${b.telegram_bot_username || defaultBot?.bot_username || '<bot>'}?start=${b.connection_token}`;
        telegramCell = expired
          ? `${statusBadge('ссылка истекла', 'error')}
             <form class="inline" method="post" action="/brokers/${b.id}/telegram/connect"><button class="small" type="submit">Новая ссылка</button></form>`
          : `${statusBadge('ожидает подтверждения', 'warn')} <a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`;
      } else if (defaultBot) {
        telegramCell = `${statusBadge('не подключён', 'warn')}
          <form class="inline" method="post" action="/brokers/${b.id}/telegram/connect"><button class="small" type="submit">Создать ссылку</button></form>`;
      } else {
        telegramCell = `${statusBadge('бот не настроен', 'warn')} <a href="/telegram-bots">добавить</a>`;
      }

      return `<tr>
        <td><a href="/brokers/${b.id}">${escapeHtml(b.name)}</a></td>
        <td>${b.is_active ? statusBadge('активен', 'ok') : statusBadge('неактивен', 'warn')}</td>
        <td>${escapeHtml(b.stock_count)}</td>
        <td>${escapeHtml(b.match_count)}</td>
        <td>${escapeHtml(b.strong_match_count)}</td>
        <td>${jokerCell}</td>
        <td>${telegramCell}</td>
      </tr>`;
    })
    .join('');
  return `<table><thead><tr><th>Имя</th><th>Статус</th><th>Объекты</th><th>Совпадения</th><th>Сильные</th><th>Joker</th><th>Telegram</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function unmappedJokerAgentsTable(agents, brokers) {
  const mappedAgentIds = new Set(brokers.filter((b) => b.joker_agent_id).map((b) => String(b.joker_agent_id)));
  const unmapped = agents.filter((a) => !mappedAgentIds.has(String(a.manager_id)));
  if (!unmapped.length) return '<p class="empty">Все активные агенты Joker уже сопоставлены с брокерами.</p>';

  const brokerOptions = brokers.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
  const rows = unmapped
    .map(
      (agent) => `<tr>
        <td>${escapeHtml(agent.manager_id)}</td>
        <td>${escapeHtml(agent.manager_name || '—')}</td>
        <td>${escapeHtml(agent.manager_position || '—')}</td>
        <td>
          <form class="inline" method="post" action="/joker-mapping/link">
            <input type="hidden" name="external_agent_id" value="${escapeHtml(agent.manager_id)}">
            <input type="hidden" name="external_name" value="${escapeHtml(agent.manager_name || '')}">
            <select name="broker_id">
              <option value="">— создать нового брокера —</option>
              ${brokerOptions}
            </select>
            <button class="small" type="submit">Сопоставить</button>
          </form>
        </td>
      </tr>`
    )
    .join('');
  return `<table><thead><tr><th>ID в Joker</th><th>Имя</th><th>Должность</th><th>Действие</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const PROVIDER_OPTIONS = ['', 'telegram', 'whatsapp'];
const PROVIDER_LABELS = { '': 'Любой канал', telegram: 'Telegram', whatsapp: 'WhatsApp' };
function providerSelect(query) {
  const options = PROVIDER_OPTIONS
    .map((p) => `<option value="${p}" ${query.provider === p ? 'selected' : ''}>${escapeHtml(PROVIDER_LABELS[p])}</option>`)
    .join('');
  return `<label>Канал <select name="provider">${options}</select></label>`;
}

// provider/accountId/chatId (2026-10-07, channel/route/account filters):
// uniform column names across all three per-market views (migration 0042),
// so these three fields are shared verbatim between /history and /requests
// regardless of market. "Route" itself is the market tab bar on each page
// (AGENTS.md section 0 -- markets are separate contours, not a sub-filter
// within one query), preserved across filtering via the hidden `market`
// field below.
function filterForm(query, market = 'uae') {
  const field = (name, label) =>
    `<label>${escapeHtml(label)} <input name="${name}" value="${escapeHtml(query[name] || '')}"></label>`;
  const isMoscow = market === 'moscow';
  return `<form class="filters" method="get">
    <input type="hidden" name="market" value="${escapeHtml(market)}">
    ${isMoscow ? field('district', 'Район') : field('area', 'Район')}
    ${isMoscow ? field('complex', 'ЖК') : field('building', 'Здание')}
    ${field('bedrooms', 'Спальни')}
    ${isMoscow ? '' : field('status', 'Статус (совпадение / сильное совпадение)')}
    ${field('stockId', 'ID объекта')}
    ${providerSelect(query)}
    ${field('accountId', 'Аккаунт')}
    ${field('chatId', 'ID чата/группы')}
    <button type="submit">Фильтровать</button>
  </form>`;
}

// /requests filter (2026-09-28): this page previously had NO filter form at
// all -- every request ever processed was dumped in one table (up to 200
// rows). `resultStatus` filters the REQUEST's own outcome (including
// NO_MATCH, which /history's filter can never show since v_match_history
// only contains successful matches); area/building/bedrooms/stockId filter
// the matched stock's attributes, same names/semantics as /history's
// filterForm() above for consistency.
const REQUEST_RESULT_STATUSES = ['', 'MATCH', 'STRONG_MATCH', 'NO_MATCH'];
const REQUEST_RESULT_STATUS_LABELS = { '': 'Любой статус', MATCH: 'Совпадение', STRONG_MATCH: 'Сильное совпадение', NO_MATCH: 'Нет совпадения' };

function requestsFilterForm(query, market = 'uae') {
  const field = (name, label) =>
    `<label>${escapeHtml(label)} <input name="${name}" value="${escapeHtml(query[name] || '')}"></label>`;
  const statusOptions = REQUEST_RESULT_STATUSES
    .map((s) => `<option value="${s}" ${query.resultStatus === s ? 'selected' : ''}>${escapeHtml(REQUEST_RESULT_STATUS_LABELS[s])}</option>`)
    .join('');
  const isMoscow = market === 'moscow';
  return `<form class="filters" method="get">
    <input type="hidden" name="market" value="${escapeHtml(market)}">
    ${field('sourceMessageId', 'ID сообщения')}
    <label>Статус заявки <select name="resultStatus">${statusOptions}</select></label>
    ${isMoscow ? field('district', 'Район объекта') : field('area', 'Район объекта')}
    ${isMoscow ? field('complex', 'ЖК объекта') : field('building', 'Здание объекта')}
    ${field('bedrooms', 'Спальни')}
    ${field('stockId', 'ID объекта')}
    ${providerSelect(query)}
    ${field('accountId', 'Аккаунт')}
    ${field('chatId', 'ID чата/группы')}
    <button type="submit">Фильтровать</button>
  </form>
  <p class="empty">Показывает каждую заявку (в т.ч. без совпадений). Для списка только успешных совпадений с фильтром по характеристикам объекта см. <a href="/history">«Историю совпадений»</a>.</p>`;
}

const {
  ROUTE_MODES,
  ROUTE_LABELS,
  sourcesFilterForm,
  sourcesTable,
  sourceControlsScript,
  sourcesReturnLocation,
} = require('./sources-view');

// `error` (2026-10-06, multi-route validateRouteModes): when a route-mode
// write was rejected (e.g. AUTO combined with a real market), the
// auto-saving row control (fetch-based, X-Requested-With: source-control)
// gets a real 400 so sourceControlsScript's catch path shows "Ошибка
// сохранения" instead of silently reporting success. The plain-form
// fallback (bulk-update, no JS) has no flash-message mechanism today --
// logged server-side only, same as the existing sync-summary console.log
// above.
function finishSourceMutation(req, res, error) {
  if (req.headers['x-requested-with'] === 'source-control') {
    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(error);
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }
  if (error) console.error(`[sources] route update rejected: ${error}`);
  res.writeHead(303, { Location: sourcesReturnLocation(req.headers.referer) });
  res.end();
}

// Same XHR-vs-plain-form branching as finishSourceMutation above (same
// `X-Requested-With: source-control` header, sent by the SAME reused
// sourceControlsScript() -- it enhances every form.source-control on the
// page, Sources and Stock alike), but with its own redirect target since
// finishSourceMutation hardcodes sourcesReturnLocation().
function finishStockMutation(req, res, error, redirectTo) {
  if (req.headers['x-requested-with'] === 'source-control') {
    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(error);
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }
  if (error) console.error(`[stock] status update rejected: ${error}`);
  res.writeHead(303, { Location: redirectTo });
  res.end();
}

// Nika Matching V2, Phase 2 -- shapes the draft's raw settings array
// (matching_dubai.config_draft.settings: [{key,value_type,value_text,enabled}])
// into the same { [key]: { value, enabled } } map settings-view.js's
// render helpers already expect (matching getActiveRuntimeSettings()'s
// shape, so both a live-table read and a draft read render identically).
function settingsMapFromDraftArray(settingsArray) {
  const map = {};
  for (const s of settingsArray) {
    map[s.key] = { value: settingsQueries.coerceSettingValue(s.value_type, s.value_text), enabled: s.enabled };
  }
  return map;
}

function groupDraftRules(rules) {
  const grouped = { BLACKLIST: [], WHITELIST: [], PROPERTY_SIGNAL: [], SEND_TO_AI: [] };
  for (const r of rules) grouped[r.rule_group].push(r);
  for (const group of Object.keys(grouped)) {
    grouped[group].sort((a, b) => a.priority - b.priority || a.id - b.id);
  }
  return grouped;
}

function settingsErrorPage(message, backHref = '/settings') {
  return pageLayout({
    title: 'Ошибка настроек',
    activePath: '/settings',
    body: `<p class="banner-warning">${escapeHtml(message)}</p><p><a href="${backHref}">&larr; назад</a></p>`,
  });
}

// Market-aware settings backend (2026-09-28, extended 2026-10-05 for Abu
// Dhabi): every /settings* route reads `market` (query string on GET,
// form/query field on POST) and picks the matching draft/config-versions
// module -- `settingsQueries` writes matching_dubai.*, `moscowSettingsQueries`
// writes matching_moscow.* (migration 0029), `abuDhabiSettingsQueries` writes
// matching_abu_dhabi.* (migration 0036). An unrecognized market value always
// falls back to 'uae', same "never pass raw input into a schema-affecting
// path" discipline as queries.resolveMarketKey() for /stock.
//
// `resolveSettingsMarket()` replaces what used to be ~15 separate inline
// `query.market === 'moscow' ? 'moscow' : 'uae'` ternaries scattered across
// every /settings* route handler below -- Abu Dhabi's addition would have
// been a 3rd copy of each one, which is exactly the kind of drift risk (a
// missed call site silently keeps treating Abu Dhabi as UAE) this single
// lookup removes.
const SETTINGS_QUERIES_BY_MARKET = {
  uae: settingsQueries,
  moscow: moscowSettingsQueries,
  abu_dhabi: abuDhabiSettingsQueries,
};

function resolveSettingsMarket(market) {
  return Object.prototype.hasOwnProperty.call(SETTINGS_QUERIES_BY_MARKET, market) ? market : 'uae';
}

function queriesForMarket(market) {
  return SETTINGS_QUERIES_BY_MARKET[resolveSettingsMarket(market)];
}

function settingsRedirect(market) {
  const resolved = resolveSettingsMarket(market);
  return resolved === 'uae' ? '/settings' : `/settings?market=${resolved}`;
}

const routes = [
  {
    // Dashboard Summary v2 (Phase 1) -- request-level operational view,
    // built entirely on existing matching_dubai.match_runs columns (no schema
    // change). See dashboard/summary-queries.js for the canonical-outcome
    // logic and dashboard/SUMMARY_METRICS.md for what every number means,
    // its period/provider behavior, and known limitations. The OLD
    // matching_dubai.v_dashboard_summary-based Summary is retired from this
    // route but the view itself is left in place (other consumers may
    // still reference it; nothing here drops it).
    method: 'GET',
    pattern: /^\/$/,
    handler: async (req, res, match, query) => {
      const period = Object.prototype.hasOwnProperty.call(summaryView.PERIOD_LABELS, query.period) ? query.period : summaryQueries.DEFAULT_PERIOD;
      const provider = query.provider && Object.prototype.hasOwnProperty.call(summaryView.PROVIDER_LABELS, query.provider) ? query.provider || null : null;

      const [activeStock, requestFlow, interpretation, noMatchReasons, providerBreakdown] = await Promise.all([
        summaryQueries.getActiveStock(pool),
        summaryQueries.getRequestFlow(pool, { matcherVersion: summaryQueries.CURRENT_MATCHER_VERSION, period, provider }),
        summaryQueries.getInterpretation(pool, { period, provider }),
        summaryQueries.getNoMatchReasons(pool, { matcherVersion: summaryQueries.CURRENT_MATCHER_VERSION, period, provider }),
        summaryQueries.getProviderBreakdown(pool, { period }),
      ]);

      const body = `<h2>Аналитика</h2>
        <p class="empty">Оперативные показатели текущего сопоставителя ОАЭ на уровне заявок. Подробности: <a href="/requests">заявки</a> · <a href="/history">история совпадений</a> · <a href="/stock">объекты</a> · <a href="/ai-usage">использование ИИ</a> · <a href="/sources">источники</a>.</p>
        ${summaryView.periodProviderFilterForm(query)}
        ${summaryView.renderExecutiveKpis({ activeStock, requestFlow })}
        ${summaryView.renderRequestFlow(requestFlow)}
        ${summaryView.renderInterpretation(interpretation)}
        ${summaryView.renderNoMatchReasons(noMatchReasons)}
        ${provider ? '' : summaryView.renderProviderBreakdown(providerBreakdown)}`;
      send(res, 200, pageLayout({ title: 'Аналитика', activePath: '/', body }));
    },
  },
  {
    method: 'GET',
    pattern: /^\/stock$/,
    handler: async (req, res, match, query) => {
      const market = queries.resolveMarketKey(query.market);
      const requestedPage = Number.parseInt(query.page, 10);
      const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
      const search = (query.q || '').trim() || null;
      const { rows, totalCount, totalPages } = await queries.getStockByMarket(pool, market, { page, search });

      const hasMatchCounts = queries.MARKETS[market].hasMatchCounts;
      // Both shapes are editable (2026-10-07, "all regions" request):
      // hasMatchCounts markets (Dubai/Abu Dhabi) get the stock_id-keyed
      // status dropdown + edit form; the four Joker-fed markets get their
      // own joker_object_id-keyed table with an `include_in_matching`
      // toggle in place of a text status (see
      // dashboard/joker-stock-admin-queries.js's module comment -- Joker
      // re-syncs overwrite most other fields, but never that one). Both
      // auto-save via the same reused sourceControlsScript().
      const table = hasMatchCounts
        ? stockView.stockTable(rows, { market })
        : stockView.jokerStockTable(rows, { market });

      // Quick ID search (2026-10-08): a plain GET form so it's bookmarkable
      // and works with no JS; market tabs/pagination below all carry the
      // current `q` forward so switching market or page never silently
      // drops the search term.
      const qParam = search ? `&q=${encodeURIComponent(search)}` : '';
      const searchForm = `<form class="filters" method="get" action="/stock">
        <input type="hidden" name="market" value="${escapeHtml(market)}">
        <input type="text" name="q" placeholder="Поиск по ID объекта" value="${escapeHtml(search || '')}">
        <button type="submit">Найти</button>
        ${search ? `<a href="/stock?market=${market}">Сбросить</a>` : ''}
      </form>`;

      const tabs = Object.entries(queries.MARKETS)
        .map(([key, m]) => `<a href="/stock?market=${key}${qParam}" class="${key === market ? 'active' : ''}">${escapeHtml(m.label)}</a>`)
        .join('');
      const note = hasMatchCounts
        ? ''
        : `<p class="empty">Источник — Joker CRM. Сопоставление ещё не подключено для этого рынка (см. docs/PER_MARKET_SERVICE_INDEPENDENCE_PLAN.md) — статус объекта и редактирование полей между синхронизациями доступны уже сейчас.</p>`;
      const pagination = renderPagination(
        { page, pageSize: queries.DEFAULT_PAGE_SIZE, totalCount, totalPages },
        (p) => `/stock?market=${market}&page=${p}${qParam}`
      );
      const body = `<h2>Объекты</h2><div class="period-tabs">${tabs}</div>${searchForm}${note}${pagination}<div class="table-wrap">${table}</div>${pagination}${sourceControlsScript()}`;
      send(res, 200, pageLayout({ title: 'Объекты', activePath: '/stock', body }));
    },
  },
  {
    method: 'GET',
    pattern: /^\/stock\/([^/]+)$/,
    handler: async (req, res, match, query) => {
      const stockId = decodeURIComponent(match[1]);
      // Carries which market this stock_id belongs to (2026-10-06, Abu
      // Dhabi dashboard split) -- stock_id is only unique WITHIN a schema,
      // and the /stock table's own links now pass ?market= explicitly for
      // exactly this reason. Falls back to Dubai for any old/bare link.
      const market = queries.resolveMarketKey(query.market);
      const { schema, hasMatchCounts } = queries.MARKETS[market];
      if (!hasMatchCounts) {
        send(res, 404, pageLayout({ title: 'Не найдено', activePath: '/stock', body: `<p class="empty">У рынка «${escapeHtml(queries.MARKETS[market].label)}» ещё нет сопоставления объектов.</p>` }));
        return;
      }
      const rows = await queries.getStockMatchedRequests(pool, stockId, { schema });
      const table = renderTable(rows, {
        columns: ['source_message_id', 'match_score', 'match_status', 'match_rank', 'created_at'],
      });
      const body = `<h2>Заявки, совпавшие с объектом ${escapeHtml(stockId)}</h2><p><a href="/stock?market=${market}">&larr; назад к объектам</a></p><div class="table-wrap">${table}</div>`;
      send(res, 200, pageLayout({ title: stockId, activePath: '/stock', body }));
    },
  },
  {
    // Auto-saving status dropdown (2026-10-07) -- same fetch/X-Requested-
    // With convention as /sources/:id, enhanced by the reused
    // sourceControlsScript() already appended to /stock's page body.
    // Branches on hasMatchCounts: Dubai/Abu Dhabi write a real `status`
    // column (stock_id-keyed); the four Joker-fed markets instead toggle
    // `include_in_matching` (joker_object_id-keyed) -- see
    // dashboard/joker-stock-admin-queries.js's module comment for why
    // that field, not `available`, is the one exposed here.
    method: 'POST',
    pattern: /^\/stock\/([^/]+)\/status$/,
    handler: async (req, res, match, query) => {
      const id = decodeURIComponent(match[1]);
      const market = queries.resolveMarketKey(query.market);
      const { schema, hasMatchCounts } = queries.MARKETS[market];
      const redirectTo = `/stock?market=${market}`;
      const params = await readFormBody(req);
      const result = hasMatchCounts
        ? await stockAdminQueries.updateStockStatus(pool, { schema, stockId: id, status: params.get('status') })
        : await jokerStockAdminQueries.updateIncludeInMatching(pool, { schema, jokerObjectId: Number(id), includeInMatching: params.get('status') === 'true' });
      finishStockMutation(req, res, result.ok ? null : result.error, redirectTo);
    },
  },
  {
    method: 'GET',
    pattern: /^\/stock\/([^/]+)\/edit$/,
    handler: async (req, res, match, query) => {
      const id = decodeURIComponent(match[1]);
      const market = queries.resolveMarketKey(query.market);
      const { schema, hasMatchCounts } = queries.MARKETS[market];
      const row = hasMatchCounts
        ? await stockAdminQueries.getStockRow(pool, { schema, stockId: id })
        : await jokerStockAdminQueries.getStockRow(pool, { schema, jokerObjectId: Number(id) });
      if (!row) {
        send(res, 404, pageLayout({ title: 'Не найдено', activePath: '/stock', body: `<p class="empty">Объект ${escapeHtml(id)} не найден.</p>` }));
        return;
      }
      const body = hasMatchCounts
        ? stockView.stockEditForm(row, { market, saved: query.saved === '1' })
        : stockView.jokerStockEditForm(row, { market, saved: query.saved === '1' });
      send(res, 200, pageLayout({ title: `Редактирование ${id}`, activePath: '/stock', body }));
    },
  },
  {
    method: 'POST',
    pattern: /^\/stock\/([^/]+)\/edit$/,
    handler: async (req, res, match, query) => {
      const id = decodeURIComponent(match[1]);
      const market = queries.resolveMarketKey(query.market);
      const { schema, hasMatchCounts } = queries.MARKETS[market];
      const adminQueries = hasMatchCounts ? stockAdminQueries : jokerStockAdminQueries;
      const params = await readFormBody(req);
      const fields = {};
      for (const key of Object.keys(adminQueries.EDITABLE_FIELDS)) {
        if (params.has(key)) fields[key] = params.get(key);
      }
      const result = hasMatchCounts
        ? await adminQueries.updateStockFields(pool, { schema, stockId: id, fields })
        : await adminQueries.updateStockFields(pool, { schema, jokerObjectId: Number(id), fields });
      if (!result.ok) {
        const submittedRow = hasMatchCounts
          ? { ...Object.fromEntries(params), stock_id: id }
          : { ...Object.fromEntries(params), joker_object_id: id };
        const body = hasMatchCounts
          ? stockView.stockEditForm(submittedRow, { market, error: result.error })
          : stockView.jokerStockEditForm(submittedRow, { market, error: result.error });
        send(res, 400, pageLayout({ title: `Редактирование ${id}`, activePath: '/stock', body }));
        return;
      }
      res.writeHead(303, { Location: `/stock/${encodeURIComponent(id)}/edit?market=${market}&saved=1` });
      res.end();
    },
  },
  {
    method: 'GET',
    pattern: /^\/requests$/,
    handler: async (req, res, match, query) => {
      const market = queries.resolveMatchRunsMarketKey(query.market);
      const schema = queries.MARKETS[market].schema;
      const rows = await queries.getRequestMatches(pool, query, schema);
      const columns = market === 'moscow'
        ? ['match_run_id', 'source_message_id', 'result_status', 'matches_count', 'no_match_reason', 'stock_joker_object_id', 'match_score', 'match_status', 'match_rank', 'district', 'complex', 'bedrooms', 'property_type_raw', 'price', 'agent_name', 'agent_phone', 'provider', 'account_id', 'chat_id', 'run_created_at']
        : ['match_run_id', 'source_message_id', 'result_status', 'matches_count', 'no_match_reason', 'stock_id', 'match_score', 'match_status', 'match_rank', 'area', 'building', 'bedrooms', 'property_type', 'selling_price', 'broker', 'broker_contact', 'telegram_post', 'whatsapp_post', 'provider', 'account_id', 'chat_id', 'run_created_at'];
      const table = renderTable(rows, { columns });
      const tabs = Object.entries(queries.MARKETS)
        .filter(([, m]) => m.hasMatchRuns)
        .map(([key, m]) => `<a href="/requests?market=${key}" class="${key === market ? 'active' : ''}">${escapeHtml(m.label)}</a>`)
        .join('');
      const body = `<h2>Заявка &harr; подходящие объекты</h2><div class="period-tabs">${tabs}</div>${requestsFilterForm(query, market)}<div class="table-wrap">${table}</div>`;
      send(res, 200, pageLayout({ title: 'Заявки', activePath: '/requests', body }));
    },
  },
  {
    method: 'GET',
    pattern: /^\/history$/,
    handler: async (req, res, match, query) => {
      const market = queries.resolveMatchRunsMarketKey(query.market);
      const schema = queries.MARKETS[market].schema;
      const rows = await queries.getMatchHistory(pool, query, schema);
      const columns = market === 'moscow'
        ? ['created_at', 'source_message_id', 'stock_joker_object_id', 'match_score', 'match_status', 'district', 'complex', 'bedrooms', 'property_type_raw', 'price', 'agent_name', 'agent_phone', 'provider', 'account_id', 'chat_id']
        : ['created_at', 'source_message_id', 'stock_id', 'match_score', 'match_status', 'area', 'building', 'bedrooms', 'property_type', 'selling_price', 'broker', 'broker_contact', 'telegram_post', 'whatsapp_post', 'provider', 'account_id', 'chat_id'];
      const table = renderTable(rows, { columns });
      const tabs = Object.entries(queries.MARKETS)
        .filter(([, m]) => m.hasMatchRuns)
        .map(([key, m]) => `<a href="/history?market=${key}" class="${key === market ? 'active' : ''}">${escapeHtml(m.label)}</a>`)
        .join('');
      const body = `<h2>История совпадений</h2><p class="empty">Только успешные совпадения (заявки без совпадений сюда не попадают) — фильтр по характеристикам ОБЪЕКТА. Чтобы увидеть каждую заявку, включая «нет совпадения», см. <a href="/requests">«Заявки»</a>.</p><div class="period-tabs">${tabs}</div>${filterForm(query, market)}<div class="table-wrap">${table}</div>`;
      send(res, 200, pageLayout({ title: 'История совпадений', activePath: '/history', body }));
    },
  },
  {
    method: 'GET',
    pattern: /^\/channels$/,
    handler: async (req, res) => {
      const [telegram, whatsapp] = await Promise.all([workers.getTelegramStatus(), workers.getWhatsappStatus()]);
      const qrByAccount = {};
      await Promise.all(
        whatsapp.accounts
          .filter((a) => !a.connected)
          .map(async (a) => {
            const result = await workers.getWhatsappQr(a.account_id);
            if (result.ok) qrByAccount[a.account_id] = result.data;
          })
      );
      const loginByAccount = {};
      await Promise.all(
        telegram.accounts
          .filter((a) => !a.connected)
          .map(async (a) => {
            const result = await workers.getTelegramLoginStatus(a.account_id);
            if (result.ok) loginByAccount[a.account_id] = result.data;
          })
      );
      const body = `<h2>Подключения каналов <a href="/channels" class="refresh-link">&#8635; Обновить статус</a></h2>
        <p class="empty">Вход и выход из аккаунтов служб мониторинга групп Telegram и WhatsApp. Обнаружение каналов и групп, а также назначение маршрутов ОАЭ / РФ / ОАЭ и РФ / автоматически / без маршрута выполняются в разделе <a href="/sources">«Источники»</a>.</p>
        <div class="channels">${telegramCard(telegram, loginByAccount)}${whatsappCard(whatsapp, qrByAccount)}</div>`;
      send(res, 200, pageLayout({ title: 'Подключения', activePath: '/channels', body }));
    },
  },
  {
    method: 'POST',
    pattern: /^\/channels\/whatsapp\/reconnect$/,
    handler: async (req, res) => {
      const params = await readFormBody(req);
      const accountId = params.get('account_id');
      if (accountId) await workers.reconnectWhatsapp(accountId);
      res.writeHead(303, { Location: '/channels' });
      res.end();
    },
  },
  {
    method: 'POST',
    pattern: /^\/channels\/whatsapp\/logout$/,
    handler: async (req, res) => {
      const params = await readFormBody(req);
      const accountId = params.get('account_id');
      if (accountId) await workers.logoutWhatsapp(accountId);
      res.writeHead(303, { Location: '/channels' });
      res.end();
    },
  },
  {
    method: 'POST',
    pattern: /^\/channels\/whatsapp\/pause$/,
    handler: async (req, res) => {
      const params = await readFormBody(req);
      const accountId = params.get('account_id');
      if (accountId) await workers.pauseWhatsapp(accountId);
      res.writeHead(303, { Location: '/channels' });
      res.end();
    },
  },
  {
    method: 'POST',
    pattern: /^\/channels\/whatsapp\/resume$/,
    handler: async (req, res) => {
      const params = await readFormBody(req);
      const accountId = params.get('account_id');
      if (accountId) await workers.resumeWhatsapp(accountId);
      res.writeHead(303, { Location: '/channels' });
      res.end();
    },
  },
  {
    method: 'POST',
    pattern: /^\/channels\/whatsapp\/clear-session$/,
    handler: async (req, res) => {
      const params = await readFormBody(req);
      const accountId = params.get('account_id');
      if (accountId) {
        // Re-check live status right before deleting anything — never trust
        // a stale page load. Only a genuine requires_auth (WhatsApp-side
        // logout/device-removal) may have its session files cleared.
        const status = await workers.getWhatsappStatus();
        const account = status.accounts.find((a) => a.account_id === accountId);
        if (account && account.requires_auth) {
          await workers.clearWhatsappSession(accountId);
          await workers.reconnectWhatsapp(accountId);
        }
      }
      res.writeHead(303, { Location: '/channels' });
      res.end();
    },
  },
  {
    method: 'POST',
    pattern: /^\/channels\/telegram\/start-login$/,
    handler: async (req, res) => {
      const params = await readFormBody(req);
      const accountId = (params.get('account_id') || '').trim();
      if (accountId) await workers.startTelegramLogin(accountId);
      res.writeHead(303, { Location: '/channels' });
      res.end();
    },
  },
  {
    method: 'POST',
    pattern: /^\/channels\/telegram\/submit-password$/,
    handler: async (req, res) => {
      const params = await readFormBody(req);
      const accountId = (params.get('account_id') || '').trim();
      const password = params.get('password') || '';
      if (accountId && password) await workers.submitTelegramLoginPassword(accountId, password);
      res.writeHead(303, { Location: '/channels' });
      res.end();
    },
  },
  {
    method: 'POST',
    pattern: /^\/channels\/telegram\/logout$/,
    handler: async (req, res) => {
      const params = await readFormBody(req);
      const accountId = params.get('account_id');
      if (accountId) await workers.logoutTelegram(accountId);
      res.writeHead(303, { Location: '/channels' });
      res.end();
    },
  },
  {
    method: 'POST',
    pattern: /^\/channels\/telegram\/pause$/,
    handler: async (req, res) => {
      const params = await readFormBody(req);
      const accountId = params.get('account_id');
      if (accountId) await workers.pauseTelegram(accountId);
      res.writeHead(303, { Location: '/channels' });
      res.end();
    },
  },
  {
    method: 'POST',
    pattern: /^\/channels\/telegram\/resume$/,
    handler: async (req, res) => {
      const params = await readFormBody(req);
      const accountId = params.get('account_id');
      if (accountId) await workers.resumeTelegram(accountId);
      res.writeHead(303, { Location: '/channels' });
      res.end();
    },
  },
  {
    // Sources / Channels catalog (MARKET_CONTOURS_AND_SOURCE_ROUTING.md
    // section 10). Deliberately reuses this existing dashboard rather
    // than a separate admin app -- same layout/nav/auth as every other
    // page here.
    method: 'GET',
    pattern: /^\/sources$/,
    handler: async (req, res, match, query) => {
      const filters = {
        provider: query.provider || undefined,
        accountId: query.accountId || undefined,
        routeMode: query.routeMode || undefined,
        monitoringEnabled: query.monitoringEnabled || undefined,
        search: query.search || undefined,
      };
      const [sources, duplicates, accounts] = await Promise.all([
        sourceQueries.listSources(pool, filters),
        sourceQueries.findDuplicateExternalIds(pool),
        sourceQueries.listAccounts(pool),
      ]);
      // AUDIT items #4/#5: `bulk-form` is now an EMPTY, standalone <form> --
      // no <form> is ever nested inside another. Every bulk control
      // (checkboxes in the table, the two <select>s, the submit button)
      // associates with it purely via the HTML `form="bulk-form"`
      // attribute, which works regardless of DOM nesting position (see
      // sourcesTable()'s per-row checkbox and the controls below). This
      // also means unchecked checkboxes are simply never submitted, same
      // as any normal form -- no JS is needed any more to synthesize
      // hidden inputs for "selected" rows.
      const body = `<h2>Источники / каналы</h2>
        <p class="empty">Группы Telegram и WhatsApp, обнаруженные в подключённых сессиях служб.</p>
        <p class="banner-ok"><strong>Живая конфигурация.</strong> Мониторинг и маршрут, выставленные здесь, читаются напрямую сервисом сопоставления перед обработкой каждого входящего сообщения (source lookup → monitoring_enabled? → route). Выключенный мониторинг или маршрут «Без маршрута» — сообщение отклоняется ещё до вызова ИИ. Маршрут «РФ» тоже отклоняется: отдельного сервиса сопоставления для РФ пока не существует, поэтому такие сообщения нигде не обрабатываются — не назначайте его источникам, если только не готовитесь к запуску РФ-контура отдельно. «Автоматически» временно приравнивается к «ОАЭ» (детерминированного классификатора рынка ещё нет).</p>
        ${sourcesFilterForm(query, accounts)}
        <form method="post" action="/sources/bulk-update" id="bulk-form"></form>
        <div class="filters" style="margin: 12px 0;">
          <label><input type="checkbox" id="select-all"> Выбрать всё</label>
          <label>Мониторинг: <select name="monitoringEnabled" form="bulk-form"><option value="">(без изменений)</option><option value="true">Включить</option><option value="false">Выключить</option></select></label>
          <label>Маршрут: <select name="routeModes" form="bulk-form"><option value="">(без изменений)</option>${ROUTE_MODES.map((r) => `<option value="${r}">${ROUTE_LABELS[r]}</option>`).join('')}</select></label>
          <button type="submit" form="bulk-form">Применить к выбранным</button>
        </div>
        ${sourcesTable(sources, duplicates)}
        <script>
          document.getElementById('select-all').addEventListener('change', function () {
            document.querySelectorAll('.source-select').forEach(function (cb) { cb.checked = this.checked; }, this);
          });
        </script>
        ${sourceControlsScript()}`;
      send(res, 200, pageLayout({ title: 'Источники', activePath: '/sources', body }));
    },
  },
  {
    method: 'POST',
    pattern: /^\/sources\/sync$/,
    handler: async (req, res) => {
      const results = await sourceQueries.syncAllSources(pool);
      const summaryLines = [...results.telegram, ...results.whatsapp]
        .map((r) => (r.ok ? `${r.accountId}: обнаружено=${r.sourcesSeen} создано=${r.sourcesCreated} обновлено=${r.sourcesUpdated}` : `${r.accountId || '?'}: ОШИБКА (${r.error})`))
        .join(' | ');
      console.log(`[синхронизация источников] ${summaryLines}`);
      finishSourceMutation(req, res);
    },
  },
  {
    method: 'POST',
    pattern: /^\/sources\/bulk-update$/,
    handler: async (req, res) => {
      const params = await readFormBody(req);
      const sourceIds = params.getAll('sourceIds').map(Number).filter(Number.isFinite);
      const patch = {};
      if (params.get('monitoringEnabled')) patch.monitoringEnabled = params.get('monitoringEnabled') === 'true';
      const bulkRouteModes = params.getAll('routeModes').filter(Boolean);
      if (bulkRouteModes.length) patch.routeModes = bulkRouteModes;
      let error = null;
      if (sourceIds.length && Object.keys(patch).length) {
        const results = await sourceQueries.bulkUpdateSourceRoutes(pool, sourceIds, patch);
        const failed = results.find((r) => r && r.ok === false);
        if (failed) error = failed.error;
      }
      finishSourceMutation(req, res, error);
    },
  },
  {
    method: 'POST',
    pattern: /^\/sources\/(\d+)$/,
    handler: async (req, res, match) => {
      const sourceId = Number(match[1]);
      const params = await readFormBody(req);
      const patch = {};
      // A checkbox submits nothing at all when unchecked -- the row form
      // pairs it with a hidden "false" field of the same name so
      // getAll(...).pop() always sees the checkbox's real state (browsers
      // submit same-named fields in DOM order, hidden first).
      const monitoringValues = params.getAll('monitoringEnabled');
      if (monitoringValues.length) patch.monitoringEnabled = monitoringValues[monitoringValues.length - 1] === 'true';
      // Checkbox group (2026-10-06, multi-route): zero checked boxes submits
      // no `routeModes` field at all -- `params.has(...)` would then be
      // false and the route would be left untouched, which is wrong here
      // (unchecking everything must mean "set to NONE"). The row form
      // always pairs the group with a hidden `routeModes=` sentinel (see
      // sources-view.js) so `has('routeModes')` is reliably true whenever
      // this form was actually submitted.
      if (params.has('routeModes')) patch.routeModes = params.getAll('routeModes').filter(Boolean);
      if (params.has('notes')) patch.notes = params.get('notes');
      const result = await sourceQueries.updateSourceRoute(pool, sourceId, patch);
      finishSourceMutation(req, res, result && result.ok === false ? result.error : null);
    },
  },
  {
    // Nika Matching V2 Phase 2 (AGENTS_NIKA_MATCHING_V2.md section 26) --
    // configuration CONTROL PLANE only. Every write here goes to the DRAFT
    // (matching_dubai.config_draft), never directly to matching_dubai.runtime_settings/
    // intake_rules -- only Apply/Rollback touch those, atomically. Nothing
    // on this page is read by the live matching pipeline (see
    // docs/MATCHING_V2_PHASE2_SETTINGS_UI.md for the explicit proof).
    method: 'GET',
    pattern: /^\/settings$/,
    handler: async (req, res, match, query) => {
      // Market separation (2026-09-28, extended 2026-10-05 for Abu Dhabi):
      // the user asked for Moscow's page to have "the same parameters" as
      // UAE's, not a separate static reference page -- so every market now
      // renders through the exact same section pipeline below, each
      // reading/writing its OWN schema (matching_dubai.* / matching_moscow.*
      // / matching_abu_dhabi.*) via queriesForMarket(). Oman/Saudi/Turkey are
      // deliberately absent from the tab bar -- no settings tables exist for
      // them yet (SAUDI is a routing label only, see AGENTS.md section 0).
      const settingsMarket = resolveSettingsMarket(query.market);
      const q = queriesForMarket(settingsMarket);
      const marketTabs = [
        { key: 'uae', label: 'ОАЭ' },
        { key: 'moscow', label: 'Москва' },
        { key: 'abu_dhabi', label: 'Абу-Даби' },
      ]
        .map((m) => `<a href="/settings${m.key === 'uae' ? '' : `?market=${m.key}`}" class="${m.key === settingsMarket ? 'active' : ''}">${m.label}</a>`)
        .join('');
      const marketTabsHtml = `<div class="period-tabs">${marketTabs}</div>`;

      const [draft, recentHistory] = await Promise.all([
        q.getOrInitDraft(pool),
        q.getConfigVersionHistory(pool),
      ]);
      const settingsMap = settingsMapFromDraftArray(draft.settings);
      const rulesGrouped = groupDraftRules(draft.intake_rules);
      const cutoverEnabled = settingsMap.v2_intake_cutover_enabled?.value === true;

      // Plain-language pending-change summary (Settings UI simplification,
      // 2026-09-27, spec section 13) -- reuses the existing, already-tested
      // diffConfigVersions() against the version the draft is based on.
      // Presentation only: Apply/Discard still act on the draft exactly as
      // before, this just shows what would change.
      let pendingDiff = null;
      if (draft.is_dirty) {
        const activeVersion = draft.based_on_version ? await q.getConfigVersionDetail(pool, draft.based_on_version) : null;
        pendingDiff = q.diffConfigVersions(
          activeVersion ? activeVersion.snapshot : { runtime_settings: [], intake_rules: [] },
          { runtime_settings: draft.settings, intake_rules: draft.intake_rules }
        );
      }

      // Live rule performance statistics (read-only, spec 2026-09-27):
      // UAE only -- there is no matching_moscow.shadow_gate_evaluations
      // table (no live Moscow matcher generates any telemetry to show yet;
      // every render function below already handles ruleStats=null
      // gracefully, same as before this page had any stats at all).
      const rulesStatsPeriod = shadowQueries.resolveRuleStatsPeriod(query.rule_stats_period);
      let ruleStats = null;
      let groupSummaries = new Map();
      if (settingsMarket === 'uae') {
        try {
          const [statsResult, summaryResult] = await Promise.all([
            shadowQueries.getRulePerformanceStats(pool, { period: rulesStatsPeriod }),
            shadowQueries.getRuleGroupPerformanceSummary(pool, { period: rulesStatsPeriod }),
          ]);
          ruleStats = { period: statsResult.period, error: false, byRule: statsResult.byRule };
          groupSummaries = summaryResult.byGroup;
        } catch (err) {
          console.error('[settings] rule performance stats query failed:', err);
          ruleStats = { period: rulesStatsPeriod, error: true, byRule: new Map() };
        }
      }

      // 2026-10-06 bug fix: this used to be a plain binary uae/moscow
      // ternary, so adding Abu Dhabi as a 3rd settingsMarket silently gave
      // it Moscow's heading AND Moscow's stale "no real matcher exists yet"
      // banner -- both wrong, since Abu Dhabi has its own real matcher.
      // Only Moscow gets its own tailored banner (genuinely true when it
      // was written, now also stale for different reasons -- see
      // moscow-settings-reference.js's own note); uae/abu_dhabi share the
      // generic shadow-gate/cutover banner, which is accurate for both.
      const SETTINGS_HEADING_BY_MARKET = { uae: 'ОАЭ (Дубай)', moscow: 'Москва', abu_dhabi: 'Абу-Даби' };
      const heading = `Настройки / конфигурация — ${SETTINGS_HEADING_BY_MARKET[settingsMarket]}`;
      const notLiveBanner = settingsMarket === 'moscow' ? settingsView.renderMoscowNotLiveBanner() : settingsView.runtimeNotLiveBanner();
      const body = `<h2>${heading}</h2>
        ${marketTabsHtml}
        ${notLiveBanner}
        ${settingsView.renderActiveModeBanner(settingsMap)}
        ${settingsView.renderDraftBanner(draft, pendingDiff, { market: settingsMarket })}
        ${settingsView.sectionNav()}
        ${settingsMarket === 'uae' ? settingsView.renderRuleStatsPeriodSelector(rulesStatsPeriod) : ''}
        ${settingsView.renderSourcesIntakeSection()}
        ${settingsView.renderDedupSection(settingsMap, { market: settingsMarket })}
        ${settingsView.renderRuleSection(3, 'BLACKLIST', 'Blacklist', 'Сильные отрицательные признаки: очевидные объявления продавцов, реклама или сообщения брокеров с предложением услуг. В будущем шлюзе приёма V2 такие сообщения должны отклоняться до ИИ; пока правило НЕ применяется в рабочем процессе.', rulesGrouped, cutoverEnabled, ruleStats, groupSummaries.get('BLACKLIST'), { market: settingsMarket })}
        ${settingsView.renderRuleSection(4, 'WHITELIST', 'Whitelist', 'Признаки намерения покупателя, например «ищу», «нужен», «требуется», «looking for», «need», «required», «seeking» или «WTB». Ниже показаны реальные правила из базы данных, а не жёстко заданная классификация.', rulesGrouped, cutoverEnabled, ruleStats, groupSummaries.get('WHITELIST'), { market: settingsMarket })}
        ${settingsView.renderRuleSection(5, 'PROPERTY_SIGNAL', 'Property Signals', 'Признаки того, что сообщение содержит требования к недвижимости или контекст объекта: количество спален, цены, площадь в квадратных футах и т. п.', rulesGrouped, cutoverEnabled, ruleStats, groupSummaries.get('PROPERTY_SIGNAL'), { market: settingsMarket })}
        ${settingsView.renderBuyerGateSection(settingsMap, rulesGrouped, ruleStats, groupSummaries.get('SEND_TO_AI'), { market: settingsMarket })}
        ${settingsView.renderCutoverSection(settingsMap, { market: settingsMarket })}
        ${settingsView.renderAiSection(settingsMap, { market: settingsMarket })}
        ${settingsView.renderMatchingSection(settingsMap, { market: settingsMarket })}
        ${settingsView.renderHistorySection(recentHistory, { market: settingsMarket })}`;
      send(res, 200, pageLayout({ title: settingsMarket === 'uae' ? 'Настройки' : `Настройки — ${SETTINGS_HEADING_BY_MARKET[settingsMarket]}`, activePath: '/settings', body }));
    },
  },
  {
    method: 'POST',
    pattern: /^\/settings\/setting$/,
    handler: async (req, res, match, query) => {
      const settingsMarket = resolveSettingsMarket(query.market);
      const params = await readFormBody(req);
      const key = params.get('key');
      const valueText = params.get('valueText');
      const enabledValues = params.getAll('enabled');
      const enabled = enabledValues.length ? enabledValues[enabledValues.length - 1] === 'true' : true;
      const result = await queriesForMarket(settingsMarket).updateDraftSetting(pool, key, { valueText, enabled });
      if (!result.ok) {
        send(res, 400, settingsErrorPage(result.error, settingsRedirect(settingsMarket)));
        return;
      }
      res.writeHead(303, { Location: settingsRedirect(settingsMarket) });
      res.end();
    },
  },
  {
    method: 'POST',
    pattern: /^\/settings\/rule$/,
    handler: async (req, res, match, query) => {
      const settingsMarket = resolveSettingsMarket(query.market);
      const params = await readFormBody(req);
      const result = await queriesForMarket(settingsMarket).addDraftRule(pool, {
        rule_group: params.get('rule_group'),
        match_type: params.get('match_type'),
        pattern: params.get('pattern'),
        priority: params.get('priority') ? Number(params.get('priority')) : 100,
        description: params.get('description') || null,
      });
      if (!result.ok) {
        send(res, 400, settingsErrorPage(result.error, settingsRedirect(settingsMarket)));
        return;
      }
      res.writeHead(303, { Location: settingsRedirect(settingsMarket) });
      res.end();
    },
  },
  {
    method: 'POST',
    pattern: /^\/settings\/rule\/(-?\d+)$/,
    handler: async (req, res, match, query) => {
      const settingsMarket = resolveSettingsMarket(query.market);
      const id = Number(match[1]);
      const params = await readFormBody(req);
      const enabledValues = params.getAll('enabled');
      const patch = {
        match_type: params.get('match_type'),
        pattern: params.get('pattern'),
        priority: params.get('priority') ? Number(params.get('priority')) : 100,
        description: params.get('description') || null,
        enabled: enabledValues.length ? enabledValues[enabledValues.length - 1] === 'true' : false,
      };
      const result = await queriesForMarket(settingsMarket).updateDraftRule(pool, id, patch);
      if (!result.ok) {
        send(res, 400, settingsErrorPage(result.error, settingsRedirect(settingsMarket)));
        return;
      }
      res.writeHead(303, { Location: settingsRedirect(settingsMarket) });
      res.end();
    },
  },
  {
    method: 'POST',
    pattern: /^\/settings\/rule\/(-?\d+)\/delete$/,
    handler: async (req, res, match, query) => {
      const settingsMarket = resolveSettingsMarket(query.market);
      const id = Number(match[1]);
      await queriesForMarket(settingsMarket).deleteDraftRule(pool, id);
      res.writeHead(303, { Location: settingsRedirect(settingsMarket) });
      res.end();
    },
  },
  {
    method: 'POST',
    pattern: /^\/settings\/apply$/,
    handler: async (req, res, match, query) => {
      const settingsMarket = resolveSettingsMarket(query.market);
      const params = await readFormBody(req);
      const note = params.get('note') || null;
      const result = await queriesForMarket(settingsMarket).applyDraft(pool, { note, createdBy: AUTH_USER || 'dashboard-operator' });
      if (!result.ok) {
        send(res, 400, settingsErrorPage(`Не удалось применить конфигурацию: ${result.error}`, settingsRedirect(settingsMarket)));
        return;
      }
      res.writeHead(303, { Location: settingsRedirect(settingsMarket) });
      res.end();
    },
  },
  {
    method: 'POST',
    pattern: /^\/settings\/discard$/,
    handler: async (req, res, match, query) => {
      const settingsMarket = resolveSettingsMarket(query.market);
      await queriesForMarket(settingsMarket).discardDraft(pool);
      res.writeHead(303, { Location: settingsRedirect(settingsMarket) });
      res.end();
    },
  },
  {
    method: 'GET',
    pattern: /^\/settings\/history$/,
    handler: async (req, res, match, query) => {
      const settingsMarket = resolveSettingsMarket(query.market);
      const versions = await queriesForMarket(settingsMarket).getConfigVersionHistory(pool);
      send(res, 200, pageLayout({ title: 'История конфигурации', activePath: '/settings', body: settingsView.renderHistoryPage(versions, { market: settingsMarket }) }));
    },
  },
  {
    method: 'GET',
    pattern: /^\/settings\/history\/(\d+)$/,
    handler: async (req, res, match, query) => {
      const settingsMarket = resolveSettingsMarket(query.market);
      const q = queriesForMarket(settingsMarket);
      const versionNumber = Number(match[1]);
      const version = await q.getConfigVersionDetail(pool, versionNumber);
      if (!version) {
        send(res, 404, pageLayout({ title: 'Не найдено', activePath: '/settings', body: '<p class="empty">Версия не найдена.</p>' }));
        return;
      }
      // Version numbers are always sequential (writeConfigAndSnapshot uses
      // max(version_number)+1), so versionNumber-1 is always the
      // immediately-preceding version if one exists.
      const previousVersionNumber = versionNumber > 1 ? versionNumber - 1 : null;
      let diff = null;
      if (previousVersionNumber) {
        const previous = await q.getConfigVersionDetail(pool, previousVersionNumber);
        if (previous) diff = q.diffConfigVersions(previous.snapshot, version.snapshot);
      }
      const body = settingsView.renderVersionDetailPage(version, diff, previousVersionNumber, { market: settingsMarket });
      send(res, 200, pageLayout({ title: `Конфигурация, версия ${versionNumber}`, activePath: '/settings', body }));
    },
  },
  {
    method: 'POST',
    pattern: /^\/settings\/history\/(\d+)\/rollback$/,
    handler: async (req, res, match, query) => {
      const settingsMarket = resolveSettingsMarket(query.market);
      const versionNumber = Number(match[1]);
      const result = await queriesForMarket(settingsMarket).rollbackToVersion(pool, versionNumber, { createdBy: AUTH_USER || 'dashboard-operator' });
      if (!result.ok) {
        send(res, 400, settingsErrorPage(`Не удалось выполнить откат: ${result.error}`, settingsMarket === 'uae' ? '/settings/history' : `/settings/history?market=${settingsMarket}`));
        return;
      }
      res.writeHead(303, { Location: settingsRedirect(settingsMarket) });
      res.end();
    },
  },
  {
    // Nika Matching V2 Phase 3/4 (AGENTS_NIKA_MATCHING_V2.md section 26).
    // Every number here comes from matching_dubai.shadow_gate_evaluations
    // (migrations 0022/0023). PROJECTED sections (mode=SHADOW) remain
    // observational only; the ACTUAL section (mode=AUTHORITATIVE) reflects
    // real live decisions ONLY once an operator has turned cutover on via
    // /settings -- this page never itself changes routing (see
    // docs/MATCHING_V2_PHASE3_SHADOW_GATE.md and
    // docs/MATCHING_V2_PHASE4_GATE_CUTOVER.md for the explicit proof).
    method: 'GET',
    pattern: /^\/shadow-gate$/,
    handler: async (req, res, match, query) => {
      const period = Object.prototype.hasOwnProperty.call(shadowView.PERIOD_LABELS, query.period) ? query.period : shadowQueries.DEFAULT_PERIOD;

      const [summary, breakdown, ruleHits, modeCounts, actualSummary, activeSettings, currentVersion] = await Promise.all([
        shadowQueries.getShadowSummary(pool, { period }),
        shadowQueries.getDisagreementBreakdown(pool, { period }),
        shadowQueries.getRuleHitAnalytics(pool, { period }),
        shadowQueries.getGateModeCounts(pool, { period }),
        shadowQueries.getActualGateSummary(pool, { period }),
        settingsQueries.getActiveRuntimeSettings(pool),
        settingsQueries.getCurrentConfigVersion(pool),
      ]);
      const cutoverEnabled = activeSettings.v2_intake_cutover_enabled?.value === true;
      const buyerSignalPolicy = activeSettings.buyer_signal_policy?.value;

      const body = `<h2>Теневой шлюз (сопоставление V2, этапы 3/4)</h2>
        <p class="empty">Сравнивает текущие рабочие решения с решениями детерминированного шлюза приёма V2 на основе применённой <a href="/settings">конфигурации</a>.</p>
        ${shadowView.shadowNotLiveBanner(cutoverEnabled)}
        ${shadowView.periodTabs(period)}
        ${shadowView.renderModeCounts(modeCounts)}
        ${cutoverEnabled || modeCounts.AUTHORITATIVE > 0 ? shadowView.renderActualGateSummary(actualSummary, { buyerSignalPolicy, configVersion: currentVersion?.version_number }) : ''}
        ${shadowView.renderShadowSummary(summary)}
        ${shadowView.renderDisagreementBreakdown(breakdown)}
        ${shadowView.renderRuleHitAnalytics(ruleHits)}`;
      send(res, 200, pageLayout({ title: 'Теневой шлюз', activePath: '/shadow-gate', body }));
    },
  },
  {
    method: 'GET',
    pattern: /^\/brokers$/,
    handler: async (req, res) => {
      const [brokers, defaultBot, agentsResult] = await Promise.all([
        brokerAdmin.listBrokers(pool),
        brokerAdmin.getDefaultTelegramBot(pool),
        jokerClient.listJokerAgents(),
      ]);

      const unmappedSection = !agentsResult.ok
        ? `<p class="empty">Не удалось подключиться к Joker: ${escapeHtml(agentsResult.error)}</p>`
        : `<p class="empty">Активных агентов из Joker CRM: ${escapeHtml(agentsResult.data.length)}. Реальные контактные данные отображаются только здесь и никогда не записываются в репозиторий.</p>
           <div class="table-wrap">${unmappedJokerAgentsTable(agentsResult.data, brokers)}</div>`;

      const body = `<h2>Брокеры — сопоставление профилей Joker и Telegram</h2>
        <p class="empty">Одна строка на брокера: профиль в Joker CRM и пользователь Telegram, который получает уведомления о возможностях. ${defaultBot ? `Бот уведомлений: <strong>@${escapeHtml(defaultBot.bot_username || defaultBot.name)}</strong>` : `<a href="/notifications">Настройте бота уведомлений</a>, чтобы подключать Telegram.`}</p>
        <form class="filters" method="post" action="/brokers">
          <input name="name" placeholder="Полное имя" required>
          <input name="phone" placeholder="Телефон">
          <input name="email" placeholder="Электронная почта">
          <button type="submit">Добавить брокера вручную</button>
        </form>
        <div class="table-wrap">${brokersTable(brokers, defaultBot)}</div>
        <h3>Несопоставленные агенты Joker</h3>
        ${unmappedSection}`;
      send(res, 200, pageLayout({ title: 'Брокеры', activePath: '/brokers', body }));
    },
  },
  {
    method: 'POST',
    pattern: /^\/brokers$/,
    handler: async (req, res) => {
      const params = await readFormBody(req);
      const name = (params.get('name') || '').trim();
      if (name) {
        await brokerAdmin.createBroker(pool, {
          name,
          phone: params.get('phone') || null,
          email: params.get('email') || null,
        });
      }
      res.writeHead(303, { Location: '/brokers' });
      res.end();
    },
  },
  {
    method: 'GET',
    pattern: /^\/brokers\/(\d+)$/,
    handler: async (req, res, match) => {
      const brokerId = Number(match[1]);
      const [broker, identities, telegramAccounts, bots] = await Promise.all([
        brokerAdmin.getBroker(pool, brokerId),
        brokerAdmin.listBrokerExternalIdentities(pool, brokerId),
        brokerAdmin.listBrokerTelegramAccounts(pool, brokerId),
        brokerAdmin.listTelegramBots(pool),
      ]);
      if (!broker) {
        send(res, 404, pageLayout({ title: 'Не найдено', activePath: '/brokers', body: '<p class="empty">Брокер не найден.</p>' }));
        return;
      }

      const jokerBlock = identities.length
        ? identities
            .map(
              (i) =>
                `<dl><dt>Источник</dt><dd>${escapeHtml(i.source)}</dd><dt>ID агента</dt><dd>${escapeHtml(i.external_agent_id || '—')}</dd></dl>`
            )
            .join('')
        : `<p class="empty">Не сопоставлен с Joker. Выполните сопоставление на странице <a href="/brokers">«Брокеры»</a>.</p>`;

      const botOptions = bots.map((b) => `<option value="${b.id}">${escapeHtml(b.name)} (@${escapeHtml(b.bot_username || '—')})</option>`).join('');
      const telegramBlock = telegramAccounts.length
        ? telegramAccounts
            .map((a) => {
              const level = a.is_verified ? 'ok' : 'warn';
              const link = a.connection_token && !a.is_verified
                ? `https://t.me/${a.bot_username || '<bot>'}?start=${a.connection_token}`
                : null;
              return `<div>
                <dl>
                  <dt>Бот</dt><dd>${escapeHtml(a.bot_name || '—')}</dd>
                  <dt>Статус</dt><dd>${statusBadge(a.is_verified ? 'подтверждён' : 'ожидает подтверждения', level)} ${a.is_active ? '' : statusBadge('неактивен', 'warn')}</dd>
                  ${a.telegram_username ? `<dt>Имя пользователя</dt><dd>@${escapeHtml(a.telegram_username)}</dd>` : ''}
                  ${link ? `<dt>Ссылка для подключения</dt><dd><a href="${escapeHtml(link)}">${escapeHtml(link)}</a> (действует до ${escapeHtml(new Date(a.connection_token_expires_at).toLocaleString('ru-RU'))})</dd>` : ''}
                </dl>
                ${a.is_active ? `<form class="inline" method="post" action="/brokers/${brokerId}/telegram/${a.id}/disconnect"><button class="small" type="submit">Отключить</button></form>` : ''}
              </div>`;
            })
            .join('<hr style="border-color:#262a33;margin:10px 0">')
        : '<p class="empty">Подключения к Telegram пока нет.</p>';

      // One bot for everyone is the common case — only show a picker once
      // there's actually more than one to choose from.
      const generateForm = bots.length === 0
        ? `<p class="empty">Боты Telegram пока не настроены. Сначала добавьте бота на странице <a href="/notifications">«Уведомления»</a>.</p>`
        : bots.length === 1
          ? `<form class="inline" method="post" action="/brokers/${brokerId}/telegram/connect">
              <button class="small" type="submit">Создать ссылку для подключения</button>
            </form>`
          : `<form class="filters" method="post" action="/brokers/${brokerId}/telegram/connect">
              <select name="telegram_bot_id">${botOptions}</select>
              <button type="submit">Создать ссылку для подключения</button>
            </form>`;

      const body = `<h2>${escapeHtml(broker.name)}</h2><p><a href="/brokers">&larr; назад к брокерам</a></p>
        <div class="channels">
          <div class="channel-card"><h3>Joker CRM</h3>${jokerBlock}</div>
          <div class="channel-card"><h3>Telegram</h3>${telegramBlock}<hr style="border-color:#262a33;margin:10px 0">${generateForm}</div>
        </div>`;
      send(res, 200, pageLayout({ title: broker.name, activePath: '/brokers', body }));
    },
  },
  {
    method: 'POST',
    pattern: /^\/brokers\/(\d+)\/telegram\/connect$/,
    handler: async (req, res, match) => {
      const brokerId = Number(match[1]);
      const params = await readFormBody(req);
      // A bot picker is only relevant once more than one bot exists (the
      // /brokers/:id detail page still offers one for that case) — the
      // common single-bot flow (the inline "Generate link" button on the
      // main /brokers table) never sends telegram_bot_id, so fall back to
      // the platform's one default bot.
      const explicitBotId = params.get('telegram_bot_id') ? Number(params.get('telegram_bot_id')) : null;
      const telegramBotId = explicitBotId || (await brokerAdmin.getDefaultTelegramBot(pool))?.id || null;
      const referer = req.headers.referer && req.headers.referer.includes('/brokers/') ? `/brokers/${brokerId}` : '/brokers';
      if (telegramBotId) {
        const { token, expiresAt } = generateConnectionToken();
        await brokerAdmin.createPendingTelegramConnection(pool, { brokerId, telegramBotId, token, expiresAt });
      }
      res.writeHead(303, { Location: referer });
      res.end();
    },
  },
  {
    method: 'POST',
    pattern: /^\/brokers\/(\d+)\/telegram\/(\d+)\/disconnect$/,
    handler: async (req, res, match) => {
      const brokerId = Number(match[1]);
      const accountId = Number(match[2]);
      await brokerAdmin.deactivateTelegramAccount(pool, accountId);
      res.writeHead(303, { Location: `/brokers/${brokerId}` });
      res.end();
    },
  },
  {
    // Renamed from /telegram-bots (2026-10-08) -- same bots table/add-bot
    // form, now joined by a per-broker Telegram/WhatsApp notification
    // toggle panel and an embedded delivery-stats panel, so "уведомления"
    // (notifications) is one section instead of three.
    method: 'GET',
    pattern: /^\/notifications$/,
    handler: async (req, res, match, query) => {
      const [bots, routeRows, whatsappAccounts, stats] = await Promise.all([
        brokerAdmin.listTelegramBots(pool),
        brokerAdmin.listBrokerNotificationRoutes(pool),
        workers.listWhatsappAccounts(),
        notificationStatsQueries.getNotificationStats(pool, {
          period: query.period,
          from: query.from || null,
          to: query.to || null,
        }),
      ]);

      const brokers = notificationsView.groupRoutesByBroker(routeRows);
      const body = `<h2>Уведомления</h2><p><a href="/brokers">&larr; назад к брокерам</a></p>
        <h3>Боты Telegram</h3>
        ${notificationsView.renderAddBotForm()}
        <div class="table-wrap">${notificationsView.renderBotsTable(renderTable, bots)}</div>
        <h3>Уведомления по брокерам</h3>
        <p class="empty">Telegram доставляется в личный чат брокера после привязки на странице <a href="/brokers">«Брокеры»</a>. WhatsApp доставляется через выбранный ниже подключённый аккаунт воркера.</p>
        ${notificationsView.renderBrokerRoutesPanel(brokers, whatsappAccounts)}
        <h3>Статистика отправленных уведомлений</h3>
        ${notificationsView.renderStatsPanel(stats, query)}`;
      send(res, 200, pageLayout({ title: 'Уведомления', activePath: '/notifications', body }));
    },
  },
  {
    method: 'POST',
    pattern: /^\/notifications$/,
    handler: async (req, res) => {
      const params = await readFormBody(req);
      const name = (params.get('name') || '').trim();
      if (name) {
        await brokerAdmin.createTelegramBot(pool, {
          name,
          botUsername: params.get('bot_username') || null,
          botToken: params.get('bot_token') || null,
        });
      }
      res.writeHead(303, { Location: '/notifications' });
      res.end();
    },
  },
  {
    method: 'POST',
    pattern: /^\/notifications\/routes\/(\d+)$/,
    handler: async (req, res, match) => {
      const brokerId = Number(match[1]);
      const params = await readFormBody(req);
      const telegramEnabled = params.get('telegram_enabled') === '1';
      const whatsappEnabled = params.get('whatsapp_enabled') === '1';
      const whatsappAccountId = params.get('whatsapp_account_id') || null;

      await Promise.all([
        brokerAdmin.upsertBrokerNotificationRoute(pool, { brokerId, channel: 'TELEGRAM', enabled: telegramEnabled }),
        brokerAdmin.upsertBrokerNotificationRoute(pool, { brokerId, channel: 'WHATSAPP', enabled: whatsappEnabled, whatsappAccountId }),
      ]);
      res.writeHead(303, { Location: '/notifications' });
      res.end();
    },
  },
  {
    // Bookmarked-link safety net, same pattern as /joker-mapping -> /brokers.
    method: 'GET',
    pattern: /^\/telegram-bots$/,
    handler: async (req, res) => {
      res.writeHead(303, { Location: '/notifications' });
      res.end();
    },
  },
  {
    // The Joker mapping table now lives on /brokers itself (one unified
    // page instead of three) — keep this path alive as a redirect in case
    // it's bookmarked anywhere.
    method: 'GET',
    pattern: /^\/joker-mapping$/,
    handler: async (req, res) => {
      res.writeHead(303, { Location: '/brokers' });
      res.end();
    },
  },
  {
    method: 'GET',
    pattern: /^\/ai-usage$/,
    handler: async (req, res, match, query) => {
      const granularity = queries.AI_USAGE_GRANULARITIES[query.granularity] ? query.granularity : 'day';
      const [totals, series, recent] = await Promise.all([
        queries.getAiUsageTotals(pool),
        queries.getAiUsageSeries(pool, granularity),
        queries.getRecentAiUsage(pool, { limit: 100 }),
      ]);

      const kpis = `<div class="kpis">
        <div class="kpi"><div class="value">${escapeHtml(formatUsd(totals.cost_today))}</div><div class="label">Расходы сегодня</div></div>
        <div class="kpi"><div class="value">${escapeHtml(formatUsd(totals.cost_7d))}</div><div class="label">Расходы за 7 дней</div></div>
        <div class="kpi"><div class="value">${escapeHtml(formatUsd(totals.cost_30d))}</div><div class="label">Расходы за 30 дней</div></div>
        <div class="kpi"><div class="value">${escapeHtml(formatUsd(totals.cost_all_time))}</div><div class="label">Расходы за всё время</div></div>
        <div class="kpi"><div class="value">${escapeHtml(Number(totals.tokens_all_time).toLocaleString('ru-RU'))}</div><div class="label">Токены за всё время</div></div>
        <div class="kpi"><div class="value">${escapeHtml(totals.requests_all_time)}</div><div class="label">Запросы к ИИ за всё время</div></div>
      </div>`;

      const periodTabs = `<div class="period-tabs">
        <a href="/ai-usage?granularity=day" class="${granularity === 'day' ? 'active' : ''}">День</a>
        <a href="/ai-usage?granularity=week" class="${granularity === 'week' ? 'active' : ''}">Неделя</a>
        <a href="/ai-usage?granularity=month" class="${granularity === 'month' ? 'active' : ''}">Месяц</a>
      </div>`;

      const chart = renderBarChart(series, {
        labelFn: (row) => bucketLabel(row.bucket, granularity),
        valueFn: (row) => Number(row.cost_usd),
        valueLabelFn: (row) => formatUsd(row.cost_usd),
      });

      const recentTable = renderTable(recent, {
        columns: ['created_at', 'source_message_id', 'model', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'estimated_cost_usd'],
      });

      const body = `<h2>Использование ИИ</h2>
        <p class="empty">Расход токенов и долларов на вызовы структурированного анализатора OpenAI в этом процессе. OpenAI не предоставляет API остатка средств аккаунта, поэтому здесь учитываются фактические расходы, рассчитанные по данным использования каждого ответа и вручную поддерживаемой таблице тарифов (<code>src/core/ai-usage.js</code>), а не общий предоплаченный баланс аккаунта.</p>
        ${kpis}
        ${periodTabs}
        ${chart}
        <h3>Последние запросы</h3>
        <div class="table-wrap">${recentTable}</div>`;
      send(res, 200, pageLayout({ title: 'Использование ИИ', activePath: '/ai-usage', body }));
    },
  },
  {
    // pocket-listing-ingest-service (ADR-050) is a separate, independent
    // service with no UI of its own -- this is its only observability
    // surface. Health comes from the service's own /health (live, not
    // persisted); activity comes from pocket_listing_ingest.processed_messages
    // (this dashboard's own DB connection, same pool as everything else).
    method: 'GET',
    pattern: /^\/pocket-listings$/,
    handler: async (req, res) => {
      const [status, totals, skipReasons, recent] = await Promise.all([
        workers.getPocketListingIngestStatus(),
        pocketListingQueries.getTotals(pool),
        pocketListingQueries.getSkipReasonBreakdown(pool),
        pocketListingQueries.getRecentProcessedMessages(pool, { limit: 100 }),
      ]);

      const statusBanner = status.reachable
        ? `<p class="banner-ok">Сервис доступен (${escapeHtml(status.health?.database === 'ok' ? 'БД подключена' : 'БД: ' + status.health?.database)}). Отслеживаемые чаты: ${(status.health?.source_chat_ids || []).map((id) => escapeHtml(id)).join(', ') || '—'}</p>`
        : `<p class="banner-warning">Сервис недоступен: ${escapeHtml(status.error || 'нет ответа от http://localhost:8098')}. Новые сообщения из группы сейчас не обрабатываются.</p>`;

      const kpis = `<div class="kpis">
        <div class="kpi"><div class="value">${escapeHtml(totals.total)}</div><div class="label">Всего обработано</div></div>
        <div class="kpi"><div class="value">${escapeHtml(totals.listings_created)}</div><div class="label">Создано объектов</div></div>
        <div class="kpi"><div class="value">${escapeHtml(totals.not_a_listing)}</div><div class="label">Не объявление (личная переписка)</div></div>
        <div class="kpi"><div class="value">${escapeHtml(totals.skipped_other)}</div><div class="label">Пропущено (не Дубай и т.п.)</div></div>
      </div>`;

      const reasonsTable = renderTable(skipReasons, { columns: ['reason', 'c'] });

      const recentTable = renderTable(recent, {
        columns: ['created_at', 'sender_name', 'chat_id', 'classified_as_listing', 'skip_reason', 'stock_id'],
        linkFn: (row) => (row.stock_id ? `/stock/${encodeURIComponent(row.stock_id)}/edit?market=uae` : null),
      });

      const body = `<h2>Pocket-листинги (WhatsApp)</h2>
        <p class="empty">Независимый сервис <code>pocket-listing-ingest-service</code> — читает новые сообщения из группы «Secondary Nika Estate», через ИИ отличает объявления об объектах от обычной переписки и создаёт объекты со статусом NEEDS_REVIEW в <a href="/stock?market=uae">объектах Дубая</a>. Не связан с сопоставлением заявок (Dubai/RF/Abu Dhabi).</p>
        ${statusBanner}
        ${kpis}
        <h3>Причины пропуска</h3>
        <div class="table-wrap">${reasonsTable}</div>
        <h3>Последние обработанные сообщения</h3>
        <p class="empty">Клик по ID объекта открывает его редактирование (там же меняется статус NEEDS_REVIEW → ACTIVE).</p>
        <div class="table-wrap">${recentTable}</div>`;
      send(res, 200, pageLayout({ title: 'Pocket-листинги', activePath: '/pocket-listings', body }));
    },
  },
  {
    method: 'POST',
    pattern: /^\/joker-mapping\/link$/,
    handler: async (req, res) => {
      const params = await readFormBody(req);
      const externalAgentId = params.get('external_agent_id');
      const externalName = params.get('external_name') || 'Брокер без имени';
      let brokerId = params.get('broker_id') ? Number(params.get('broker_id')) : null;

      if (externalAgentId) {
        const existing = await brokerAdmin.findBrokerExternalIdentity(pool, 'JOKER', externalAgentId);
        if (!existing) {
          if (!brokerId) {
            const created = await brokerAdmin.createBroker(pool, { name: externalName });
            brokerId = created.id;
          }
          await brokerAdmin.upsertBrokerExternalIdentity(pool, {
            brokerId,
            source: 'JOKER',
            externalAgentId,
          });
        }
      }
      res.writeHead(303, { Location: '/brokers' });
      res.end();
    },
  },
];

const server = http.createServer(async (req, res) => {
  if (!checkAuth(req, res)) return;

  const url = new URL(req.url, `http://${req.headers.host}`);
  const query = Object.fromEntries(url.searchParams.entries());

  for (const route of routes) {
    if (route.method !== req.method) continue;
    const match = route.pattern.exec(url.pathname);
    if (!match) continue;
    try {
      await route.handler(req, res, match, query);
    } catch (err) {
      console.error(err);
      send(res, 500, pageLayout({ title: 'Ошибка', activePath: '', body: `<p class="empty">Ошибка: ${escapeHtml(err.message)}</p>` }));
    }
    return;
  }

  send(res, 404, pageLayout({ title: 'Не найдено', activePath: '', body: '<p class="empty">Страница не найдена.</p>' }));
});

server.listen(PORT, () => {
  console.log(`Панель NIKA PILOT доступна по адресу http://localhost:${PORT}`);
  if (!AUTH_USER || !AUTH_PASS) {
    console.log('ПРЕДУПРЕЖДЕНИЕ: DASHBOARD_USERNAME/DASHBOARD_PASSWORD не заданы — панель работает без авторизации. Публикуйте её только во внутренней сети.');
  }
});

// Completes the broker Telegram /start handshake (see
// dashboard/telegram-bot-poller.js) -- long-polling, so no public webhook
// endpoint is needed. Runs for every bot that has a bot_token configured;
// a deployment with no notification bot yet configured just polls zero
// bots per tick (the SELECT returns no rows), so this is always safe to
// start unconditionally.
const notificationsPoller = telegramBotPoller.start(pool);

process.on('SIGTERM', () => { notificationsPoller.stop(); pool.end(); server.close(); });
process.on('SIGINT', () => { notificationsPoller.stop(); pool.end(); server.close(); });
