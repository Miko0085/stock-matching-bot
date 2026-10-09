'use strict';

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const DISPLAY_VALUES = {
  true: 'Да',
  false: 'Нет',
  ACTIVE: 'Активен',
  INACTIVE: 'Неактивен',
  SALE: 'Продажа',
  RENT: 'Аренда',
  RENT_YEARLY: 'Годовая аренда',
  MATCH: 'Совпадение',
  STRONG_MATCH: 'Сильное совпадение',
  NO_MATCH: 'Нет совпадений',
  ERROR: 'Ошибка',
  REJECTED: 'Отклонено',
  DUPLICATE: 'Дубликат',
  INSUFFICIENT_CRITERIA: 'Недостаточно критериев',
  PARSER_ERROR: 'Ошибка разбора',
  AI_ERROR: 'Ошибка ИИ',
  AI_REVIEW: 'Проверка ИИ',
  PARSED_LOCALLY: 'Обработано локально',
  UNASSIGNED: 'Не назначен',
  Apartment: 'Квартира',
  Villa: 'Вилла',
  Townhouse: 'Таунхаус',
  Penthouse: 'Пентхаус',
  Duplex: 'Дуплекс',
  Studio: 'Студия',
  Plot: 'Участок',
  Furnished: 'Меблировано',
  Unfurnished: 'Без мебели',
  'Partly Furnished': 'Частично меблировано',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  no_stock_in_location: 'Нет объектов в указанном месте',
  area_not_resolved: 'Район не распознан',
  building_not_resolved: 'Здание не распознано',
  bedrooms_mismatch: 'Не совпадает количество спален',
  property_type_mismatch: 'Не совпадает тип недвижимости',
  transaction_type_mismatch: 'Не совпадает тип сделки',
  all_candidates_over_budget: 'Все варианты выходят за бюджет',
  score_below_threshold: 'Оценка ниже порога',
  parser_missing_fields: 'В разборе не хватает полей',
  stock_not_synced: 'Объекты не синхронизированы',
  matching_error: 'Ошибка сопоставления',
};

function formatCell(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return escapeHtml(value.toLocaleString('ru-RU'));
  if (typeof value === 'object') return escapeHtml(JSON.stringify(value));
  if (Object.prototype.hasOwnProperty.call(DISPLAY_VALUES, String(value))) {
    return escapeHtml(DISPLAY_VALUES[String(value)]);
  }
  return escapeHtml(value);
}

const COLUMN_LABELS = {
  id: 'ID',
  stock_id: 'ID объекта',
  status: 'Статус',
  area: 'Район',
  building: 'Здание',
  bedrooms: 'Спальни',
  property_type: 'Тип недвижимости',
  selling_price: 'Цена продажи',
  broker: 'Брокер',
  broker_contact: 'Контакт брокера',
  match_count: 'Совпадения',
  strong_match_count: 'Сильные совпадения',
  latest_match: 'Последнее совпадение',
  source_message_id: 'ID исходного сообщения',
  match_score: 'Оценка совпадения',
  match_status: 'Статус совпадения',
  match_rank: 'Место в рейтинге',
  created_at: 'Создано',
  match_run_id: 'ID запуска сопоставления',
  result_status: 'Статус результата',
  matches_count: 'Количество совпадений',
  no_match_reason: 'Причина отсутствия совпадений',
  telegram_post: 'Публикация в Telegram',
  whatsapp_post: 'Публикация в WhatsApp',
  run_created_at: 'Запуск создан',
  name: 'Название',
  bot_username: 'Имя пользователя бота',
  is_default: 'По умолчанию',
  last_healthcheck_at: 'Последняя проверка',
  last_error: 'Последняя ошибка',
  model: 'Модель',
  prompt_tokens: 'Токены запроса',
  completion_tokens: 'Токены ответа',
  total_tokens: 'Всего токенов',
  estimated_cost_usd: 'Расчётная стоимость, USD',
  // Multi-market /stock (2026-09-28) -- Joker-fed markets' stock_inventory columns.
  joker_object_id: 'ID Joker',
  joker_url: 'Ссылка',
  agent_name: 'Агент',
  agent_phone: 'Телефон агента',
  property_type_raw: 'Тип объекта',
  district: 'Округ/Район',
  complex: 'ЖК/Комплекс',
  rooms: 'Комнаты',
  rooms_sentinel: 'Студия/Своб. планировка',
  bedrooms: 'Спальни',
  area_sqm: 'Площадь, м²',
  floor: 'Этаж',
  floors_total: 'Этажей в доме',
  price: 'Цена, руб',
  readiness_year: 'Год постройки',
  readiness_quarter: 'Квартал готовности',
  include_in_matching: 'Включить в матчинг',
  synced_at: 'Синхронизировано',
  // Channel/route/account filters (2026-10-07) -- uniform across all three
  // per-market request/history views (migration 0042).
  provider: 'Канал',
  account_id: 'Аккаунт',
  chat_id: 'ID чата/группы',
  stock_joker_object_id: 'ID объекта (Joker)',
  // pocket-listing-ingest-service (ADR-050).
  reason: 'Причина',
  c: 'Количество',
  sender_name: 'Отправитель',
  classified_as_listing: 'Объявление?',
  skip_reason: 'Причина пропуска',
};

// Renders an array of plain row objects as an HTML table. `linkFn(row)` may
// return a URL to make the first column a link (used for stock -> requests
// drill-down).
function renderTable(rows, { columns, linkFn } = {}) {
  if (!rows.length) return '<p class="empty">Нет строк.</p>';
  const cols = columns || Object.keys(rows[0]);
  const head = cols.map((c) => `<th>${escapeHtml(COLUMN_LABELS[c] || c)}</th>`).join('');
  const body = rows
    .map((row) => {
      const cells = cols
        .map((c, i) => {
          const value = formatCell(row[c]);
          if (i === 0 && linkFn) {
            const href = linkFn(row);
            if (href) return `<td><a href="${escapeHtml(href)}">${value}</a></td>`;
          }
          return `<td>${value}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

const NAV = [
  ['/', 'Аналитика'],
  ['/stock', 'Объекты'],
  ['/requests', 'Заявки'],
  ['/history', 'История совпадений'],
  ['/channels', 'Подключения'],
  ['/sources', 'Источники'],
  ['/settings', 'Настройки'],
  ['/shadow-gate', 'Теневой шлюз'],
  ['/brokers', 'Брокеры'],
  ['/notifications', 'Уведомления'],
  ['/ai-usage', 'Использование ИИ'],
  ['/pocket-listings', 'Pocket-листинги'],
];

function pageLayout({ title, activePath, body }) {
  const nav = NAV.map(
    ([href, label]) =>
      `<a href="${href}" class="${href === activePath ? 'active' : ''}">${label}</a>`
  ).join('');

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} — Панель NIKA PILOT</title>
<style>
  :root { color-scheme: light; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 0; background: #ffffff; color: #1a1d24; }
  header { padding: 16px 24px; border-bottom: 1px solid #e2e5ea; display: flex; align-items: center; gap: 24px; }
  header h1 { font-size: 16px; margin: 0; color: #3355cc; }
  nav a { color: #5a6472; text-decoration: none; margin-right: 16px; padding: 4px 0; }
  nav a.active, nav a:hover { color: #111319; border-bottom: 2px solid #4a6cf0; }
  main { padding: 24px; max-width: none; margin: 0; box-sizing: border-box; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border-bottom: 1px solid #e2e5ea; padding: 6px 10px; text-align: left; white-space: nowrap; }
  th { color: #5a6472; font-weight: 600; position: sticky; top: 0; background: #ffffff; }
  tr:hover td { background: #f5f7fa; }
  a { color: #4a6cf0; }
  .empty { color: #6b7280; }
  .kpis { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 24px; }
  .kpi { background: #f5f7fa; border: 1px solid #e2e5ea; border-radius: 8px; padding: 16px 20px; min-width: 160px; }
  .kpi .value { font-size: 28px; font-weight: 700; color: #3355cc; }
  .kpi .label { font-size: 12px; color: #6b7280; margin-top: 4px; }
  form.filters { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
  form.filters input, form.filters select { background: #ffffff; border: 1px solid #d0d5dd; color: #1a1d24; padding: 6px 8px; border-radius: 4px; }
  form.filters button { background: #4a6cf0; border: none; color: #ffffff; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-weight: 600; }
  .table-wrap { overflow-x: auto; }
  .channels { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 24px; }
  .channel-card { background: #f5f7fa; border: 1px solid #e2e5ea; border-radius: 8px; padding: 16px 20px; min-width: 280px; flex: 1; }
  .channel-card h3 { margin: 0 0 12px; font-size: 14px; color: #1a1d24; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .badge.ok { background: #e3f6ea; color: #1a7a41; }
  .badge.warn { background: #fff4dc; color: #8a6d1a; }
  .badge.error { background: #fdeaea; color: #b23a3a; }
  .banner-warning { background: #fff4dc; color: #7a5c10; border: 1px solid #f0d98a; border-radius: 6px; padding: 10px 14px; margin: 12px 0; font-size: 13px; }
  .channel-card dl { margin: 8px 0 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 13px; }
  .channel-card dt { color: #6b7280; }
  .channel-card dd { margin: 0; }
  .qr-box { margin-top: 12px; text-align: center; }
  .qr-box img { width: 220px; height: 220px; background: #fff; padding: 8px; border-radius: 4px; border: 1px solid #e2e5ea; }
  h3 { margin: 28px 0 12px; font-size: 15px; color: #1a1d24; }
  h3 .badge { margin-left: 8px; vertical-align: middle; }
  h3 .hint { font-size: 12px; font-weight: 400; color: #6b7280; }
  .flow { display: flex; flex-direction: column; gap: 6px; max-width: 720px; }
  .flow-row { display: grid; grid-template-columns: 180px 1fr 70px; align-items: center; gap: 10px; font-size: 13px; }
  .flow-row.flow-indent .flow-label { color: #6b7280; padding-left: 12px; }
  .flow-row.flow-eligible .flow-label { font-weight: 600; }
  .flow-track { background: #eef0f3; border-radius: 4px; height: 16px; overflow: hidden; }
  .flow-bar { background: #4a6cf0; height: 100%; border-radius: 4px; }
  .flow-eligible .flow-bar { background: #34b368; }
  .flow-indent .flow-bar { background: #93a3d6; }
  .flow-count { text-align: right; }
  form.inline { display: inline; }
  .hidden-row-form { display: none; }
  .edit-form { display: flex; flex-direction: column; gap: 10px; max-width: 480px; }
  .edit-form label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: #6b7280; }
  .edit-form input { background: #ffffff; border: 1px solid #d0d5dd; color: #1a1d24; padding: 6px 8px; border-radius: 4px; font-size: 14px; }
  .edit-form button { align-self: flex-start; background: #4a6cf0; border: none; color: #ffffff; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: 600; }
  .source-save-state { display: inline-block; min-width: 76px; margin-left: 6px; font-size: 11px; color: #6b7280; }
  .source-save-state.saved { color: #1a7a41; }
  .source-save-state.error { color: #b23a3a; }
  .banner-ok { background: #e3f6ea; color: #1a7a41; border: 1px solid #a8e0bc; border-radius: 6px; padding: 10px 14px; margin: 12px 0; font-size: 13px; }
  .settings-toc { margin: -8px 0 20px; }
  .setting-row { background: #f5f7fa; border: 1px solid #e2e5ea; border-radius: 8px; padding: 12px 16px; margin-bottom: 10px; }
  .setting-explain { margin: 6px 0 0; }
  button.small { background: #4a6cf0; border: none; color: #ffffff; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 12px; }
  .refresh-link { font-size: 13px; font-weight: 400; margin-left: 12px; }
  .period-tabs { display: flex; gap: 4px; margin-bottom: 16px; }
  .period-tabs a { padding: 6px 14px; border: 1px solid #d0d5dd; border-radius: 6px; font-size: 13px; text-decoration: none; color: #5a6472; }
  .period-tabs a.active { background: #4a6cf0; color: #ffffff; border-color: #4a6cf0; font-weight: 600; }
  .chart { display: flex; align-items: flex-end; gap: 6px; height: 220px; padding: 12px; background: #f5f7fa; border: 1px solid #e2e5ea; border-radius: 8px; margin-bottom: 24px; overflow-x: auto; }
  .chart-bar-col { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; min-width: 28px; flex: 1; }
  .chart-bar { width: 100%; max-width: 34px; background: #4a6cf0; border-radius: 3px 3px 0 0; min-height: 2px; }
  .chart-bar-value { font-size: 10px; color: #6b7280; margin-bottom: 4px; white-space: nowrap; }
  .chart-bar-label { font-size: 10px; color: #6b7280; margin-top: 6px; white-space: nowrap; transform: rotate(-40deg); transform-origin: top right; }
</style>
</head>
<body>
<header>
  <h1>NIKA PILOT</h1>
  <nav>${nav}</nav>
</header>
<main>${body}</main>
</body>
</html>`;
}

// Dependency-free bar chart (pure CSS flex bars) for the AI Usage page's
// day/week/month spend view — no charting library needed for one series.
function renderBarChart(rows, { labelFn, valueFn, valueLabelFn }) {
  if (!rows.length) return '<p class="empty">За этот период данных об использовании пока нет.</p>';
  const max = Math.max(...rows.map(valueFn), 0.0001);
  const bars = rows
    .map((row) => {
      const value = valueFn(row);
      const heightPct = Math.max((value / max) * 100, 1);
      return `<div class="chart-bar-col">
        <div class="chart-bar-value">${escapeHtml(valueLabelFn(row))}</div>
        <div class="chart-bar" style="height:${heightPct}%"></div>
        <div class="chart-bar-label">${escapeHtml(labelFn(row))}</div>
      </div>`;
    })
    .join('');
  return `<div class="chart">${bars}</div>`;
}

// Pagination controls + an honest "showing X-Y of Z" line (2026-09-28) --
// added after /stock?market=moscow silently truncated to a hardcoded
// LIMIT 500 with no indication 9,911 rows were being hidden. `linkFor(page)`
// builds the href for a given page number (the caller owns the base path
// and any other query params, e.g. `?market=moscow&page=3`).
function renderPagination({ page, pageSize, totalCount, totalPages }, linkFor) {
  if (totalCount === 0) return '<p class="empty">Ничего не найдено.</p>';
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, totalCount);
  const prev = page > 1 ? `<a href="${linkFor(page - 1)}">&larr; Назад</a>` : '<span class="disabled">&larr; Назад</span>';
  const next = page < totalPages ? `<a href="${linkFor(page + 1)}">Вперёд &rarr;</a>` : '<span class="disabled">Вперёд &rarr;</span>';
  return `<p class="empty settings-toc">Показано ${from}–${to} из ${totalCount} &middot; ${prev} &middot; страница ${page} из ${totalPages} &middot; ${next}</p>`;
}

module.exports = { escapeHtml, renderTable, pageLayout, renderBarChart, renderPagination };
