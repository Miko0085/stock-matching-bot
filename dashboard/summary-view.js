'use strict';

// Pure HTML-rendering helpers for Dashboard Summary v2 (Phase 1) -- no DB
// access, data-in/HTML-out, directly unit-testable. See
// dashboard/summary-queries.js for where every number comes from and
// dashboard/SUMMARY_METRICS.md for the business definition of each one.

const { escapeHtml } = require('./render');

const PERIOD_LABELS = { '24h': 'Последние 24 часа', '7d': '7 дней', '30d': '30 дней', all: 'Всё время' };
const PROVIDER_LABELS = { '': 'Все платформы', telegram: 'Telegram', whatsapp: 'WhatsApp' };
const REASON_LABELS = {
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

function formatPct(rate) {
  if (rate === null || rate === undefined) return '—';
  return `${Math.round(rate * 100)}%`;
}

function formatNum(n) {
  return Number(n ?? 0).toLocaleString('ru-RU');
}

function periodProviderFilterForm(query) {
  const periodOptions = Object.entries(PERIOD_LABELS)
    .map(([v, label]) => `<option value="${v}" ${((query.period || '7d') === v) ? 'selected' : ''}>${label}</option>`)
    .join('');
  const providerOptions = Object.entries(PROVIDER_LABELS)
    .map(([v, label]) => `<option value="${v}" ${(query.provider || '') === v ? 'selected' : ''}>${label}</option>`)
    .join('');
  return `<form class="filters" method="get">
    <select name="period">${periodOptions}</select>
    <select name="provider">${providerOptions}</select>
    <button type="submit">Применить</button>
  </form>`;
}

function renderExecutiveKpis({ activeStock, requestFlow }) {
  const cards = [
    ['Активные объекты', formatNum(activeStock)],
    ['Заявки, готовые к сопоставлению', formatNum(requestFlow.matchEligible)],
    ['Заявки с совпадениями', formatNum(requestFlow.matched)],
    ['Доля совпадений', formatPct(requestFlow.matchRate)],
    ['Ошибки обработки', formatNum(requestFlow.errors)],
  ];
  const kpis = cards
    .map(([label, value]) => `<div class="kpi"><div class="value">${escapeHtml(value)}</div><div class="label">${escapeHtml(label)}</div></div>`)
    .join('');
  return `<h3>Текущее сопоставление — ОАЭ <span class="badge ok">${escapeHtml('lead-matching-service-v1')}</span></h3>
    <div class="kpis">${kpis}</div>`;
}

// Simple CSS-bar funnel -- no charting library. Bar width is proportional
// to `processed` (the largest possible bucket), never to the section's
// own local max, so the visual proportions are honest across rows.
function flowBarRow(label, count, total, extraClass = '') {
  const pct = total > 0 ? Math.max((count / total) * 100, count > 0 ? 1 : 0) : 0;
  return `<div class="flow-row ${extraClass}">
    <div class="flow-label">${escapeHtml(label)}</div>
    <div class="flow-track"><div class="flow-bar" style="width:${pct}%"></div></div>
    <div class="flow-count">${formatNum(count)}</div>
  </div>`;
}

function renderRequestFlow(flow) {
  const reconciliationBadge = flow.reconciled
    ? '<span class="badge ok">сверка: успешно</span>'
    : '<span class="badge error">сверка: ошибка</span>';

  return `<h3>Поток заявок ${reconciliationBadge}</h3>
    <div class="flow">
      ${flowBarRow('Обработано', flow.processed, flow.processed)}
      ${flowBarRow('Дубликаты / повторы', flow.duplicates, flow.processed)}
      ${flowBarRow('Отклонено / не покупатель', flow.rejected, flow.processed)}
      ${flowBarRow('Недостаточно критериев', flow.insufficientCriteria, flow.processed)}
      ${flowBarRow('Ошибки обработки', flow.errors, flow.processed)}
      ${flow.other > 0 ? flowBarRow('Прочее / не классифицировано', flow.other, flow.processed) : ''}
      ${flowBarRow('Готово к сопоставлению', flow.matchEligible, flow.processed, 'flow-eligible')}
      ${flowBarRow('&nbsp;&nbsp;├ Есть совпадения', flow.matched, flow.processed, 'flow-indent')}
      ${flowBarRow('&nbsp;&nbsp;└ Нет совпадений', flow.noMatch, flow.processed, 'flow-indent')}
    </div>`;
}

function renderInterpretation(interp) {
  const cards = [
    ['Локальная обработка', interp.localTotal],
    ['Проверка ИИ', interp.triage.AI_REVIEW],
    ['ИИ (новые запросы)', interp.interpretation.ai],
    ['Попадания в кэш', interp.cacheTotal],
  ];
  const kpis = cards
    .map(([label, value]) => `<div class="kpi"><div class="value">${formatNum(value)}</div><div class="label">${escapeHtml(label)}</div></div>`)
    .join('');
  return `<h3>Интерпретация <span class="hint">(из ${formatNum(interp.triageTotal)} заявок, дошедших до предварительного отбора)</span></h3>
    <div class="kpis">${kpis}</div>
    <p class="empty">Доля проверок ИИ: ${formatPct(interp.aiReviewRate)} · Доля попаданий в кэш (среди ИИ- и локальных интерпретаций): ${formatPct(interp.aiCacheHitRate)}</p>`;
}

function renderNoMatchReasons(data) {
  if (!data.reasons.length) return '<h3>Почему заявки не совпали</h3><p class="empty">За этот период нет заявок без совпадений или отклонённых заявок с указанной причиной.</p>';
  const rows = data.reasons
    .map((r) => `<tr><td>${escapeHtml(REASON_LABELS[r.reason] || r.reason)}</td><td>${formatNum(r.count)}</td><td>${formatPct(r.share)}</td></tr>`)
    .join('');
  return `<h3>Почему заявки не совпали</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Причина</th><th>Количество</th><th>Доля</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function renderProviderBreakdown(rows) {
  const body = rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.provider)}</td><td>${formatNum(r.processed)}</td><td>${formatNum(r.matchEligible)}</td><td>${formatNum(r.matched)}</td><td>${formatPct(r.matchRate)}</td></tr>`
    )
    .join('');
  return `<h3>Трафик по платформам</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Платформа</th><th>Обработано</th><th>Готово к сопоставлению</th><th>С совпадениями</th><th>Доля совпадений</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
}

module.exports = {
  PERIOD_LABELS,
  PROVIDER_LABELS,
  formatPct,
  formatNum,
  periodProviderFilterForm,
  renderExecutiveKpis,
  renderRequestFlow,
  renderInterpretation,
  renderNoMatchReasons,
  renderProviderBreakdown,
};
