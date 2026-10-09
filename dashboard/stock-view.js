'use strict';

// Pure HTML-rendering helpers for the editable /stock table and its
// per-row edit page (dashboard/server.js's `/stock`, `/stock/:id/status`,
// `/stock/:id/edit` routes). Same role as dashboard/sources-view.js: no
// DB/HTTP access, just data-in/HTML-out, directly unit-testable.
//
// Two shapes, two sets of renderers (2026-10-07, "all regions" request):
// `stockTable`/`stockEditForm` for the `hasMatchCounts` markets (Dubai/
// Abu Dhabi, `stock_id` TEXT identity, a real `status` column);
// `jokerStockTable`/`jokerStockEditForm` for the four Joker-fed markets
// (Moscow/Oman/Saudi/Turkey, `joker_object_id` BIGINT identity, no
// `status` column -- `include_in_matching` is the nearest equivalent, see
// dashboard/joker-stock-admin-queries.js's own module comment for why).
const { escapeHtml } = require('./render');
const { EDITABLE_FIELDS } = require('./stock-admin-queries');
const { EDITABLE_FIELDS: JOKER_EDITABLE_FIELDS } = require('./joker-stock-admin-queries');

// The three real statuses observed in production (ACTIVE/INACTIVE from
// the original sync's own status vocabulary -- src/core/sync-normalize.js
// -- plus NEEDS_REVIEW, which both the Google-Sheets export and the
// pocket-listing import use for a row whose source data was incomplete
// or ambiguous and needs a human look before it's trusted as live stock).
const STOCK_STATUS_OPTIONS = ['ACTIVE', 'INACTIVE', 'NEEDS_REVIEW'];

const FIELD_LABELS = {
  area: 'Район',
  building: 'Здание',
  project_community: 'Проект/комьюнити',
  property_type: 'Тип недвижимости',
  transaction_type: 'Тип сделки',
  furnishing: 'Меблировка',
  view: 'Вид',
  broker: 'Брокер',
  broker_contact: 'Контакт брокера',
  notes: 'Заметки',
  city: 'Город',
  bedrooms: 'Спальни',
  bathrooms: 'Санузлы',
  selling_price: 'Цена продажи',
  annual_rent: 'Годовая аренда',
  size_sqft: 'Площадь, sqft',
  plot_size_sqft: 'Площадь участка, sqft',
  status: 'Статус',
};

function formatCellValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return escapeHtml(value.toLocaleString('ru-RU'));
  return escapeHtml(value);
}

// Union of the fixed option set and the row's own current value -- an
// unusual/legacy status string already in the DB must never be silently
// misrepresented by a dropdown that doesn't even contain it (the row
// would visibly show a DIFFERENT option as "selected" than what is
// actually stored).
function statusOptionsFor(current) {
  const options = STOCK_STATUS_OPTIONS.includes(current) || !current
    ? STOCK_STATUS_OPTIONS
    : [...STOCK_STATUS_OPTIONS, current];
  return options
    .map((s) => `<option value="${escapeHtml(s)}" ${s === current ? 'selected' : ''}>${escapeHtml(s)}</option>`)
    .join('');
}

function stockTable(rows, { market }) {
  if (!rows.length) return '<p class="empty">Объектов пока нет.</p>';
  const body = rows
    .map((r) => {
      const editHref = `/stock/${encodeURIComponent(r.stock_id)}/edit?market=${market}`;
      return `<tr>
        <td><a href="/stock/${encodeURIComponent(r.stock_id)}?market=${market}">${escapeHtml(r.stock_id)}</a></td>
        <td>
          <form class="inline source-control" method="post" action="/stock/${encodeURIComponent(r.stock_id)}/status?market=${market}">
            <select name="status">${statusOptionsFor(r.status)}</select>
            <span class="source-save-state" aria-live="polite"></span>
          </form>
        </td>
        <td>${formatCellValue(r.area)}</td>
        <td>${formatCellValue(r.building)}</td>
        <td>${formatCellValue(r.bedrooms)}</td>
        <td>${formatCellValue(r.property_type)}</td>
        <td>${formatCellValue(r.size_sqft)}</td>
        <td>${formatCellValue(r.view)}</td>
        <td>${formatCellValue(r.selling_price)}</td>
        <td>${formatCellValue(r.broker)}</td>
        <td>${formatCellValue(r.broker_contact)}</td>
        <td>${formatCellValue(r.match_count)}</td>
        <td>${formatCellValue(r.strong_match_count)}</td>
        <td>${formatCellValue(r.latest_match)}</td>
        <td><a href="${editHref}" title="Редактировать объект">&#9998;</a></td>
      </tr>`;
    })
    .join('');

  // No outer `.table-wrap` div here -- callers wrap it, same convention
  // as dashboard/render.js's renderTable().
  return `<table>
    <thead><tr>
      <th>ID объекта</th><th>Статус</th><th>Район</th><th>Здание</th><th>Спальни</th><th>Тип недвижимости</th>
      <th>Площадь, sqft</th><th>Вид</th>
      <th>Цена продажи</th><th>Брокер</th><th>Контакт брокера</th><th>Совпадения</th><th>Сильные совпадения</th><th>Последнее совпадение</th><th>Действия</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function stockEditForm(row, { market, saved = false, error = null } = {}) {
  const fields = Object.keys(EDITABLE_FIELDS)
    .map((key) => {
      const type = EDITABLE_FIELDS[key];
      const value = row[key];
      const inputType = type === 'int' || type === 'numeric' ? 'number' : 'text';
      const step = type === 'numeric' ? ' step="any"' : '';
      return `<label>${escapeHtml(FIELD_LABELS[key] || key)}
        <input type="${inputType}"${step} name="${key}" value="${value === null || value === undefined ? '' : escapeHtml(value)}">
      </label>`;
    })
    .join('');

  const banner = saved ? '<p class="banner-ok">Сохранено.</p>' : error ? `<p class="banner-warning">${escapeHtml(error)}</p>` : '';

  return `<h2>Редактирование объекта ${escapeHtml(row.stock_id)}</h2>
    <p><a href="/stock?market=${market}">&larr; назад к объектам</a></p>
    ${banner}
    <form method="post" action="/stock/${encodeURIComponent(row.stock_id)}/edit?market=${market}" class="edit-form">
      ${fields}
      <button type="submit">Сохранить</button>
    </form>`;
}

const JOKER_FIELD_LABELS = {
  agent_name: 'Агент',
  agent_phone: 'Телефон агента',
  agent_email: 'Email агента',
  property_type_raw: 'Тип объекта',
  deal_type: 'Тип сделки',
  city: 'Город',
  district: 'Округ/Район',
  complex: 'ЖК/Комплекс',
  rooms: 'Комнаты',
  bedrooms: 'Спальни',
  floor: 'Этаж',
  floors_total: 'Этажей в доме',
  readiness_year: 'Год постройки',
  readiness_quarter: 'Квартал готовности',
  area_sqm: 'Площадь, м²',
  price: 'Цена',
};

// `include_in_matching` is the status-equivalent for these markets (see
// dashboard/joker-stock-admin-queries.js) -- a boolean, not a free
// multi-value status, so a two-option select rather than STOCK_STATUS_
// OPTIONS' enum pattern. Labeled "Активен"/"Неактивен", same wording as
// Dubai/Abu Dhabi's status dropdown (2026-10-07, operator request: the two
// tables' status controls looked inconsistent) -- the underlying field is
// still include_in_matching, not available, precisely because it is the
// one value here that a re-sync never overwrites (see the title attribute
// on the column header for the one-line explanation).
function includeInMatchingSelect(current) {
  const options = [
    ['true', 'Активен', current === true],
    ['false', 'Неактивен', current === false],
  ];
  return options
    .map(([value, label, selected]) => `<option value="${value}" ${selected ? 'selected' : ''}>${escapeHtml(label)}</option>`)
    .join('');
}

function jokerStockTable(rows, { market }) {
  if (!rows.length) return '<p class="empty">Объектов пока нет.</p>';
  const body = rows
    .map((r) => {
      const editHref = `/stock/${encodeURIComponent(r.joker_object_id)}/edit?market=${market}`;
      return `<tr>
        <td>${r.joker_url ? `<a href="${escapeHtml(r.joker_url)}">${formatCellValue(r.joker_object_id)}</a>` : formatCellValue(r.joker_object_id)}</td>
        <td>
          <form class="inline source-control" method="post" action="/stock/${encodeURIComponent(r.joker_object_id)}/status?market=${market}">
            <select name="status">${includeInMatchingSelect(r.include_in_matching)}</select>
            <span class="source-save-state" aria-live="polite"></span>
          </form>
        </td>
        <td>${formatCellValue(r.agent_name)}</td>
        <td>${formatCellValue(r.agent_phone)}</td>
        <td>${formatCellValue(r.property_type_raw)}</td>
        <td>${formatCellValue(r.city)}</td>
        <td>${formatCellValue(r.district)}</td>
        <td>${formatCellValue(r.complex)}</td>
        <td>${formatCellValue(r.rooms)}</td>
        <td>${formatCellValue(r.rooms_sentinel)}</td>
        <td>${formatCellValue(r.bedrooms)}</td>
        <td>${formatCellValue(r.area_sqm)}</td>
        <td>${formatCellValue(r.floor)}</td>
        <td>${formatCellValue(r.floors_total)}</td>
        <td>${formatCellValue(r.price)}</td>
        <td>${formatCellValue(r.readiness_year)}</td>
        <td>${formatCellValue(r.readiness_quarter)}</td>
        <td>${formatCellValue(r.synced_at)}</td>
        <td><a href="${editHref}" title="Редактировать объект">&#9998;</a></td>
      </tr>`;
    })
    .join('');

  return `<table>
    <thead><tr>
      <th>ID Joker</th><th title="Ручной флаг: участие в будущем сопоставлении. В отличие от остальных полей, не перезаписывается синхронизацией.">Статус</th><th>Агент</th><th>Телефон агента</th><th>Тип объекта</th><th>Город</th>
      <th>Округ/Район</th><th>ЖК/Комплекс</th><th>Комнаты</th><th>Студия/Своб. планировка</th><th>Спальни</th>
      <th>Площадь, м²</th><th>Этаж</th><th>Этажей в доме</th><th>Цена</th><th>Год постройки</th><th>Квартал готовности</th>
      <th>Синхронизировано</th><th>Действия</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function jokerStockEditForm(row, { market, saved = false, error = null } = {}) {
  const fields = Object.keys(JOKER_EDITABLE_FIELDS)
    .map((key) => {
      const type = JOKER_EDITABLE_FIELDS[key];
      const value = row[key];
      const inputType = type === 'int' || type === 'numeric' ? 'number' : 'text';
      const step = type === 'numeric' ? ' step="any"' : '';
      return `<label>${escapeHtml(JOKER_FIELD_LABELS[key] || key)}
        <input type="${inputType}"${step} name="${key}" value="${value === null || value === undefined ? '' : escapeHtml(value)}">
      </label>`;
    })
    .join('');

  const banner = saved ? '<p class="banner-ok">Сохранено.</p>' : error ? `<p class="banner-warning">${escapeHtml(error)}</p>` : '';
  const note = '<p class="empty">Поля (кроме «Статус») синхронизируются из Joker CRM и могут быть перезаписаны при следующей синхронизации — это правка между синхронизациями.</p>';

  return `<h2>Редактирование объекта ${escapeHtml(row.joker_object_id)}</h2>
    <p><a href="/stock?market=${market}">&larr; назад к объектам</a></p>
    ${note}
    ${banner}
    <form method="post" action="/stock/${encodeURIComponent(row.joker_object_id)}/edit?market=${market}" class="edit-form">
      ${fields}
      <button type="submit">Сохранить</button>
    </form>`;
}

module.exports = {
  STOCK_STATUS_OPTIONS,
  stockTable,
  stockEditForm,
  jokerStockTable,
  jokerStockEditForm,
};
