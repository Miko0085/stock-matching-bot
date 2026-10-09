'use strict';

// Pure HTML-rendering helpers for the Sources/Channels page
// (dashboard/server.js's `/sources` route). Extracted into their own
// module -- no DB/HTTP access, just data-in/HTML-out -- so the structural
// HTML contract (AUDIT item #4: no <form> ever nested inside another) is
// directly unit-testable without spinning up the real dashboard server.

const { escapeHtml } = require('./render');

function statusBadge(label, level) {
  return `<span class="badge ${level}">${escapeHtml(label)}</span>`;
}

// `BOTH` retired as a stored value (2026-10-06, migration 0041, multi-
// route selection): it used to be the only way to route a source to more
// than one contour, hardcoded to the single pair [DUBAI, RF]
// (src/sources/route-resolver.js). Any combination is now just a
// `route_modes` array with more than one element -- a source can be
// DUBAI+ABU_DHABI, RF+SAUDI, or any other mix, not just the old pair.
const REAL_MARKET_MODES = ['DUBAI', 'RF', 'SAUDI', 'ABU_DHABI'];
const ROUTE_MODES = [...REAL_MARKET_MODES, 'AUTO', 'NONE'];
const ROUTE_LABELS = {
  DUBAI: 'Дубай',
  RF: 'РФ',
  SAUDI: 'Саудовская Аравия',
  ABU_DHABI: 'Абу-Даби',
  AUTO: 'Автоматически',
  NONE: 'Без маршрута',
};
const SOURCE_TYPE_LABELS = {
  group: 'Группа',
  channel: 'Канал',
  supergroup: 'Супергруппа',
  community: 'Сообщество',
  other: 'Другое',
};

function sourcesFilterForm(query, accounts = []) {
  const providerOptions = ['', 'telegram', 'whatsapp']
    .map((p) => `<option value="${p}" ${query.provider === p ? 'selected' : ''}>${p || 'Все платформы'}</option>`)
    .join('');
  const accountOptions = ['']
    .concat(accounts.map((a) => a.account_id))
    .map((accountId) => `<option value="${escapeHtml(accountId)}" ${query.accountId === accountId ? 'selected' : ''}>${accountId ? escapeHtml(accountId) : 'Все каналы'}</option>`)
    .join('');
  const routeOptions = ['', ...ROUTE_MODES]
    .map((r) => `<option value="${r}" ${query.routeMode === r ? 'selected' : ''}>${r ? ROUTE_LABELS[r] : 'Все маршруты'}</option>`)
    .join('');
  const monitorOptions = [
    ['', 'Любой режим мониторинга'],
    ['true', 'Мониторинг включён'],
    ['false', 'Мониторинг выключен'],
  ]
    .map(([v, label]) => `<option value="${v}" ${query.monitoringEnabled === v ? 'selected' : ''}>${label}</option>`)
    .join('');
  return `<form class="filters" method="get">
    <select name="provider">${providerOptions}</select>
    <select name="accountId">${accountOptions}</select>
    <select name="routeMode">${routeOptions}</select>
    <select name="monitoringEnabled">${monitorOptions}</select>
    <input name="search" placeholder="Поиск по названию, имени пользователя или ID" value="${escapeHtml(query.search || '')}">
    <button type="submit">Фильтровать</button>
  </form>
  <form class="inline" method="post" action="/sources/sync">
    <button type="submit">&#8635; Синхронизировать источники</button>
  </form>`;
}

function sourcesReturnLocation(referer) {
  if (!referer) return '/sources';
  try {
    const url = new URL(referer);
    return url.pathname === '/sources' ? `/sources${url.search}` : '/sources';
  } catch {
    return '/sources';
  }
}

// Generalized 2026-10-06 (multi-route selection) from a single-control
// form to a form-level listener: the route control is now a CHECKBOX
// GROUP (several `input[name="routeModes"]` in one form, not one control),
// so saving/reverting has to snapshot/restore the whole form, not one
// element's value. The single-checkbox "мониторинг" form keeps working
// unchanged -- FormData/URLSearchParams handle one-field and many-field
// forms identically.
function sourceControlsScript() {
  return `<script>
    document.querySelectorAll('form.source-control').forEach(function (form) {
      var state = form.querySelector('.source-save-state');
      if (!state) return;

      function serialize() { return new URLSearchParams(new FormData(form)).toString(); }
      function restore(serialized) {
        var saved = new URLSearchParams(serialized);
        form.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
          cb.checked = saved.getAll(cb.name).includes(cb.value);
        });
        form.querySelectorAll('select').forEach(function (sel) {
          var v = saved.get(sel.name);
          if (v !== null) sel.value = v;
        });
      }

      var savedState = serialize();

      form.addEventListener('change', async function (ev) {
        // AUTO/NONE exclusivity -- UX convenience only, the real
        // enforcement is validateRouteModes() (src/sources/
        // source-repository.js) plus the DB's own CHECK constraint.
        // Checking AUTO or NONE clears every other box in the group;
        // checking a real market clears AUTO/NONE.
        if (ev.target.name === 'routeModes' && ev.target.checked) {
          var isSentinel = ev.target.value === 'AUTO' || ev.target.value === 'NONE';
          form.querySelectorAll('input[name="routeModes"]').forEach(function (cb) {
            if (cb === ev.target) return;
            if (isSentinel || cb.value === 'AUTO' || cb.value === 'NONE') cb.checked = false;
          });
        }

        var payload = new URLSearchParams(new FormData(form));
        var controls = form.querySelectorAll('select, input[type="checkbox"]');
        controls.forEach(function (c) { c.disabled = true; });
        state.className = 'source-save-state saving';
        state.textContent = 'Сохранение…';
        try {
          var response = await fetch(form.action, {
            method: 'POST',
            body: payload,
            headers: { 'X-Requested-With': 'source-control' },
            credentials: 'same-origin'
          });
          if (!response.ok) throw new Error((await response.text()) || ('HTTP ' + response.status));
          savedState = serialize();
          state.className = 'source-save-state saved';
          state.textContent = 'Сохранено';
          window.setTimeout(function () {
            if (state.textContent === 'Сохранено') state.textContent = '';
          }, 1600);
        } catch (error) {
          restore(savedState);
          state.className = 'source-save-state error';
          state.textContent = String(error.message || error);
        } finally {
          controls.forEach(function (c) { c.disabled = false; });
        }
      });
    });
  </script>`;
}

// AUDIT item #4 (P1 release blocker): previously this table was rendered
// INSIDE the bulk-update <form>, which itself contained each row's own
// monitoring/route <form> -- nested <form> elements are invalid HTML with
// undefined browser behavior. Fixed by making every row's selection
// checkbox a form-associated field of the (now empty, standalone)
// `#bulk-form` via the `form="bulk-form"` attribute -- valid HTML5, works
// regardless of DOM nesting position -- while the row's own monitoring/
// route <form> stays completely outside `#bulk-form`. See
// dashboard/server.js's `/sources` GET handler for where `#bulk-form`
// itself and the bulk controls (also `form="bulk-form"`) are rendered.
// Read-only indicator only (explicit product decision, 2026-09-27): shows
// that the SAME physical group/channel is also synced under a different
// one of our own accounts, so an operator can decide by hand whether both
// copies should stay monitored -- this never merges, disables, or deletes
// either row itself.
function duplicateBadge(source, duplicates) {
  const dup = duplicates.get(`${source.provider}:${source.external_source_id}`);
  if (!dup) return '';
  const others = dup.accountIds.filter((accountId) => accountId !== source.account_id);
  const title = `Этот же источник также синхронизирован под аккаунтом(ами): ${others.join(', ')}`;
  return ` <span class="badge warn" title="${escapeHtml(title)}">дубль ×${dup.accountCount}</span>`;
}

function sourcesTable(sources, duplicates = new Map()) {
  if (!sources.length) return '<p class="empty">Источников пока нет. Нажмите «Синхронизировать источники», чтобы найти группы Telegram и WhatsApp в подключённых аккаунтах.</p>';
  // Checkbox group, not a single <select> (2026-10-06, multi-route
  // selection, migration 0041): `routeModes` is now an array, any non-
  // empty combination of the four real markets, or exactly one of
  // AUTO/NONE. The leading hidden `routeModes=""` sentinel guarantees
  // `params.has('routeModes')` is true even when every box is unchecked
  // (dashboard/server.js's POST /sources/:id handler relies on this to
  // tell "the form was submitted with nothing checked, set NONE" apart
  // from "this field was never present, leave the route untouched").
  const routeCheckboxesFor = (current) => {
    const currentSet = new Set(current || []);
    const boxes = ROUTE_MODES.map(
      (r) => `<label class="route-checkbox"><input type="checkbox" name="routeModes" value="${r}" ${currentSet.has(r) ? 'checked' : ''}> ${escapeHtml(ROUTE_LABELS[r])}</label>`
    ).join(' ');
    return `<input type="hidden" name="routeModes" value="">${boxes}`;
  };

  const rows = sources
    .map((s) => {
      const availability = s.available ? statusBadge('доступен', 'ok') : statusBadge('больше не доступен', 'warn');
      return `<tr>
        <td>${escapeHtml(s.provider)}</td>
        <td>${escapeHtml(s.account_id)}</td>
        <td>${escapeHtml(s.name || '—')}${duplicateBadge(s, duplicates)}</td>
        <td>${s.username_or_handle ? '@' + escapeHtml(s.username_or_handle) : '—'}</td>
        <td>${escapeHtml(s.external_source_id)}</td>
        <td>${escapeHtml(SOURCE_TYPE_LABELS[s.source_type] || s.source_type || '—')}</td>
        <td>${escapeHtml(s.member_count ?? '—')}</td>
        <td>${availability}</td>
        <td>
          <form class="inline source-control" method="post" action="/sources/${s.id}">
            <input type="hidden" name="monitoringEnabled" value="false">
            <input type="checkbox" name="monitoringEnabled" value="true" ${s.monitoring_enabled ? 'checked' : ''}>
            <span class="source-save-state" aria-live="polite"></span>
          </form>
        </td>
        <td>
          <form class="inline source-control route-modes-form" method="post" action="/sources/${s.id}">
            ${routeCheckboxesFor(s.route_modes)}
            <span class="source-save-state" aria-live="polite"></span>
          </form>
        </td>
        <td>${s.manual_override ? statusBadge('вручную', 'ok') : statusBadge('авто / по умолчанию', 'warn')}</td>
        <td>${s.last_synced_at ? new Date(s.last_synced_at).toLocaleString('ru-RU') : '—'}</td>
        <td><input type="checkbox" class="source-select" name="sourceIds" value="${s.id}" form="bulk-form"></td>
      </tr>`;
    })
    .join('');

  return `<div class="table-wrap"><table>
    <thead><tr>
      <th>Платформа</th><th>Аккаунт</th><th>Источник / группа</th><th>Имя пользователя</th><th>Внешний ID</th>
      <th>Тип</th><th>Участники</th><th title="Показывает, обнаружила ли последняя синхронизация этот источник в подключённом аккаунте. Это реальное состояние Telegram/WhatsApp, а не настройка в базе данных.">Доступен в системе</th><th title="Решение оператора. Читается напрямую сервисом сопоставления перед каждым входящим сообщением.">Мониторинг</th><th>Маршрут</th><th>Ручной / авто</th><th>Последняя синхронизация</th><th>Выбрать</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

module.exports = {
  ROUTE_MODES,
  ROUTE_LABELS,
  sourcesFilterForm,
  sourcesTable,
  duplicateBadge,
  sourceControlsScript,
  sourcesReturnLocation,
  statusBadge,
};
