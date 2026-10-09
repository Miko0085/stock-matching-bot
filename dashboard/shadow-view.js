'use strict';

// Nika Matching V2, Phase 3 -- pure HTML-rendering helpers for the shadow
// gate analytics page. No DB access, data-in/HTML-out, directly
// unit-testable (mirrors dashboard/summary-view.js's own split from
// summary-queries.js).
const { escapeHtml } = require('./render');
// Same presentation-only friendly-name mapping used by the Settings page
// (Settings UI simplification, 2026-09-27) -- reused here purely so the two
// pages use consistent terminology for the same underlying rule groups.
const ruleUi = require('./rule-ui-metadata');

const PERIOD_LABELS = { '24h': 'Последние 24 часа', '7d': '7 дней', '30d': '30 дней', all: 'Всё время' };
const BUYER_SIGNAL_POLICY_LABELS = {
  REQUIRE_BOTH: ruleUi.BUYER_SIGNAL_POLICY_UI.REQUIRE_BOTH.label,
  REQUIRE_ANY: ruleUi.BUYER_SIGNAL_POLICY_UI.REQUIRE_ANY.label,
};

function formatPct(rate) {
  if (rate === null || rate === undefined) return '—';
  return `${Math.round(rate * 100)}%`;
}

function formatSignedPct(rate) {
  if (rate === null || rate === undefined) return '—';
  const rounded = Math.round(rate * 100);
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

function formatNum(n) {
  return Number(n ?? 0).toLocaleString('ru-RU');
}

function formatSignedNum(n) {
  const value = Number(n ?? 0);
  return `${value > 0 ? '+' : ''}${formatNum(value)}`;
}

function periodTabs(activePeriod) {
  const tabs = Object.entries(PERIOD_LABELS)
    .map(([value, label]) => `<a href="/shadow-gate?period=${value}" class="${value === activePeriod ? 'active' : ''}">${escapeHtml(label)}</a>`)
    .join('');
  return `<div class="period-tabs">${tabs}</div>`;
}

// Runtime-not-live banner reused verbatim in spirit from Phase 2's AI
// section (settings-view.js) -- this page is observational-only, and an
// operator landing here must never mistake "shadow gate says X" for "the
// live system does X".
// Phase 4: dynamic based on the real cutover state (dashboard/server.js
// passes the current v2_intake_cutover_enabled value) -- this banner must
// never claim "shadow only" once cutover is actually on, and must never
// claim "live" while it's off.
function shadowNotLiveBanner(cutoverEnabled = false) {
  if (cutoverEnabled) {
    return `<p class="banner-warning"><strong>Переключение на рабочий режим включено.</strong> Разделы ниже с пометкой «Прогноз» по-прежнему отражают теневое сравнение там, где оно выполняется; раздел «Фактические данные» показывает реальные решения шлюза для рабочего трафика. При необходимости немедленно отключите режим в <a href="/settings#v2-intake-gate-live-cutover">настройках</a>.</p>`;
  }
  return `<p class="banner-warning">Только теневой режим: шлюз V2 ниже НЕ подключён к рабочей маршрутизации. Все реальные сообщения обрабатываются по текущим правилам; эта страница для сравнения показывает, что произошло бы при использовании нового детерминированного шлюза. Включайте рабочий режим в <a href="/settings#v2-intake-gate-live-cutover">настройках</a> только после проверки этих данных.</p>`;
}

function renderShadowSummary(summary) {
  const cards = [
    ['Оценено', formatNum(summary.evaluated)],
    ['Новые вызовы ИИ по старым правилам', formatNum(summary.oldSendToAiCount)],
    ['V2 отправил бы в ИИ', formatNum(summary.v2SendToAiCount)],
    ['Прогноз экономии вызовов ИИ', formatNum(summary.projectedAiSavedCount)],
    ['Прогноз дополнительных вызовов ИИ', formatNum(summary.projectedAiAddedCount)],
    ['Прогноз итогового изменения ИИ', formatSignedNum(summary.netProjectedAiChange)],
    ['Прогноз сокращения ИИ', summary.projectedAiReductionPct === null ? '—' : formatSignedPct(summary.projectedAiReductionPct / 100)],
    ['Доля согласованных решений', formatPct(summary.agreementRate)],
    ['Расхождения', formatNum(summary.disagreementCount)],
  ];
  const kpis = cards
    .map(([label, value]) => `<div class="kpi"><div class="value">${escapeHtml(value)}</div><div class="label">${escapeHtml(label)}</div></div>`)
    .join('');
  return `<h3>Прогноз влияния на ИИ (теневой режим)</h3><div class="kpis">${kpis}</div>`;
}

function renderDisagreementBreakdown(breakdown) {
  const rows = [
    ['Раньше «Отправить в ИИ» → V2 «Отклонить»', breakdown.oldSendToAiV2Reject],
    ['Раньше «Отклонить» (без ИИ) → V2 «Отправить в ИИ»', breakdown.oldRejectV2SendToAi],
    ['Раньше «Обработано локально» → V2 «Отправить в ИИ»', breakdown.oldParsedLocallyV2SendToAi],
    ['Расхождение по чёрному списку', breakdown.blacklistDisagreement],
    ['Нет сигнала белого списка', breakdown.missingWhitelistSignal],
    ['Нет сигнала о недвижимости', breakdown.missingPropertySignal],
    ['Сработало исключение «Отправить в ИИ»', breakdown.sendToAiExceptionRuleHit],
  ];
  const body = rows.map(([label, count]) => `<tr><td>${label}</td><td>${formatNum(count)}</td></tr>`).join('');
  return `<h3>Структура расхождений</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Категория</th><th>Количество</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
}

// Settings UI simplification (2026-09-27, spec section 10): the friendly
// rule name/category is now the primary label; the raw pattern, backend
// group enum, and raw description move into a per-row "Дополнительно"
// (Advanced) disclosure, same convention as settings-view.js's rule cards.
// Purely a relabeling of already-computed analytics rows -- the underlying
// hit-counting query and numbers are unchanged.
function renderRuleHitAnalytics(rows) {
  if (!rows.length) return '<h3>Статистика срабатывания правил</h3><p class="empty">За этот период срабатываний правил пока нет.</p>';
  const body = rows
    .map((r) => {
      const groupUi = ruleUi.getRuleGroupUi(r.ruleGroup);
      const friendlyName = ruleUi.getRuleFriendlyName({ pattern: r.pattern, description: r.description });
      const friendlyDescription = ruleUi.getRuleFriendlyDescription({ pattern: r.pattern, description: r.description });
      return `<tr>
        <td><strong>${escapeHtml(friendlyName)}</strong></td>
        <td>${escapeHtml(groupUi.title)}</td>
        <td>${escapeHtml(friendlyDescription || '')}</td>
        <td>${formatNum(r.hitCount)}</td>
        <td>${formatNum(r.oldSendToAiCount)}</td>
        <td>${formatNum(r.v2SendToAiCount)}</td>
        <td><details><summary>Дополнительно</summary>
          <p class="empty setting-explain">Шаблон: <code>${escapeHtml(r.pattern)}</code><br>Группа (backend): <code>${escapeHtml(r.ruleGroup)}</code>${r.description ? `<br>Исходное описание: ${escapeHtml(r.description)}` : ''}</p>
        </details></td>
      </tr>`;
    })
    .join('');
  return `<h3>Статистика срабатывания правил <span class="hint">(отслеживание покупателей, подтверждённых ИИ, отложено — см. docs/MATCHING_V2_PHASE3_SHADOW_GATE.md)</span></h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Правило</th><th>Категория</th><th>Что обнаруживает</th><th>Срабатывания</th><th>Старая логика → ИИ</th><th>V2 → ИИ</th><th>Дополнительно</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
}

// Phase 4 (AGENTS_NIKA_MATCHING_V2.md section 26, Phase 4, requirement
// 11): mode breakdown for the period, plus an explicit warning when
// FALLBACK is non-zero -- one of the documented rollback triggers.
function renderModeCounts(counts) {
  const cards = [
    ['Теневой (наблюдение)', counts.SHADOW],
    ['Рабочий (основной)', counts.AUTHORITATIVE],
    ['Резервный (сбой шлюза)', counts.FALLBACK],
  ];
  const kpis = cards
    .map(([label, value]) => `<div class="kpi"><div class="value">${formatNum(value)}</div><div class="label">${escapeHtml(label)}</div></div>`)
    .join('');
  const warning = counts.FALLBACK > 0
    ? `<p class="banner-warning">За этот период есть резервные срабатывания: инфраструктура шлюза хотя бы один раз дала сбой, и управление перешло к предыдущей обработке. Разберитесь в причине, прежде чем продолжать полагаться на рабочий режим (см. условия отката в docs/MATCHING_V2_PHASE4_GATE_CUTOVER.md).</p>`
    : '';
  return `<h3>Режим телеметрии за период</h3><div class="kpis">${kpis}</div>${warning}`;
}

// ACTUAL authoritative gate behavior -- only shown meaningfully once
// cutover has actually been on. Distinguished from renderShadowSummary's
// PROJECTED numbers both by heading and by section placement (spec
// section 11: "distinguish PROJECTED... versus ACTUAL").
function renderActualGateSummary(summary, { buyerSignalPolicy, configVersion } = {}) {
  const cards = [
    ['Оценено в рабочем режиме', formatNum(summary.evaluated)],
    ['V2 отправил в ИИ', formatNum(summary.v2SendToAiCount)],
    ['Детерминированные отказы V2', formatNum(summary.v2RejectCount)],
    ['Отказы по чёрному списку', formatNum(summary.blacklistRejectCount)],
    ['Отказы из-за недостаточного сигнала', formatNum(summary.insufficientSignalCount)],
    ['Новые вызовы ИИ', formatNum(summary.freshAiCalls)],
    ['Попадания в кэш ИИ', formatNum(summary.cacheHits)],
    ['Резервные срабатывания', formatNum(summary.fallbackCount)],
    ['Политика сигнала покупателя', BUYER_SIGNAL_POLICY_LABELS[buyerSignalPolicy] || buyerSignalPolicy || '—'],
    ['Версия конфигурации', configVersion ?? '—'],
  ];
  const kpis = cards
    .map(([label, value]) => `<div class="kpi"><div class="value">${escapeHtml(value)}</div><div class="label">${escapeHtml(label)}</div></div>`)
    .join('');
  return `<h3>Фактическая работа шлюза <span class="hint">(только основной рабочий режим — реальные события, не прогноз)</span></h3><div class="kpis">${kpis}</div>`;
}

module.exports = {
  PERIOD_LABELS,
  formatPct,
  formatNum,
  periodTabs,
  shadowNotLiveBanner,
  renderShadowSummary,
  renderDisagreementBreakdown,
  renderRuleHitAnalytics,
  renderModeCounts,
  renderActualGateSummary,
};
