'use strict';

// Pure HTML-rendering helpers for the Settings / Configuration page
// (dashboard/server.js's `/settings*` routes) -- Nika Matching V2 Phase 2
// (AGENTS_NIKA_MATCHING_V2.md section 26). No DB/HTTP access here, same
// "data-in/HTML-out, directly unit-testable" contract as sources-view.js.

const { escapeHtml } = require('./render');
const { RULE_GROUPS, MATCH_TYPES } = require('./settings-queries');
// Presentation-only friendly-name/label mapping for the Settings UI
// simplification task (2026-09-27, see docs/SETTINGS_UI_SIMPLIFICATION.md).
// Never imported by src/gates/**, src/matching/**, or src/services/** --
// this file only decides how already-computed backend data is LABELED, it
// never changes rule semantics, thresholds, or enum values.
const ruleUi = require('./rule-ui-metadata');
// Read-only Joker matching-criteria reference (Settings -> Matching,
// 2026-09-28). See dashboard/joker-criteria-reference.js's own header for
// why this is display-only, not a live toggle set.
const jokerCriteria = require('./joker-criteria-reference');
// Moscow's own independent settings/prompt reference (2026-09-28) -- kept
// OFF the UAE pipeline page entirely, rendered on its own /settings?market=
// moscow page instead. See dashboard/moscow-settings-reference.js's header.
const moscowReference = require('./moscow-settings-reference');

// Market-aware form action suffix (2026-09-28): UAE's forms post to
// /settings/... exactly as before (no query string, byte-identical
// behavior); Moscow's forms post to the same paths with `?market=moscow`
// so dashboard/server.js's handlers know which schema (matching_dubai vs
// matching_moscow) to write the draft edit into.
function marketQS(market) {
  return market === 'uae' ? '' : `?market=${market}`;
}

function statusBadge(label, level) {
  return `<span class="badge ${level}">${escapeHtml(label)}</span>`;
}

// Order matters: this IS the pipeline order the whole page renders in
// (spec section 18 / this phase's own "render in pipeline order").
const PIPELINE_SECTIONS = [
  'Sources & Intake',
  'Deduplication',
  'Blacklist',
  'Whitelist',
  'Property Signals',
  'Buyer Candidate Gate',
  'V2 Intake Gate — Live Cutover',
  'AI',
  'Matching',
  'Configuration History',
];

const SECTION_LABELS = {
  'Sources & Intake': 'Источники и приём сообщений',
  Deduplication: 'Удаление дубликатов',
  Blacklist: ruleUi.RULE_GROUP_UI.BLACKLIST.title,
  Whitelist: ruleUi.RULE_GROUP_UI.WHITELIST.title,
  'Property Signals': ruleUi.RULE_GROUP_UI.PROPERTY_SIGNAL.title,
  'Buyer Candidate Gate': 'Порог допуска в ИИ',
  'V2 Intake Gate — Live Cutover': 'Шлюз приёма V2 — рабочий режим',
  AI: 'ИИ',
  Matching: 'Сопоставление',
  'Configuration History': 'История конфигурации',
};

const RULE_GROUP_LABELS = {
  BLACKLIST: 'Чёрный список',
  WHITELIST: 'Белый список',
  PROPERTY_SIGNAL: 'Сигналы о недвижимости',
  SEND_TO_AI: 'Отправить в ИИ',
};

const MATCH_TYPE_LABELS = {
  PHRASE: 'Точная фраза',
  REGEX: 'Регулярное выражение',
  WORD_BOUNDARY_REGEX: 'Регулярное выражение с границами слов',
};

function formatBoolean(value) {
  return value ? 'Да' : 'Нет';
}

const SETTING_VALUE_LABELS = {
  true: 'Да',
  false: 'Нет',
  REQUIRE_BOTH: ruleUi.BUYER_SIGNAL_POLICY_UI.REQUIRE_BOTH.label,
  REQUIRE_ANY: ruleUi.BUYER_SIGNAL_POLICY_UI.REQUIRE_ANY.label,
};

function formatSettingValue(value) {
  const text = String(value);
  return SETTING_VALUE_LABELS[text] || text;
}

function sectionNav() {
  const links = PIPELINE_SECTIONS.map((label, i) => {
    const anchor = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return `<a href="#${anchor}">${i + 1}. ${escapeHtml(SECTION_LABELS[label] || label)}</a>`;
  }).join(' &middot; ');
  return `<p class="empty settings-toc">${links}</p>`;
}

function sectionHeading(index, label) {
  const anchor = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `<h3 id="${anchor}">${index}. ${escapeHtml(SECTION_LABELS[label] || label)}</h3>`;
}

// Draft status banner: what "unsaved / draft" (spec section 3) looks like
// on a plain server-rendered page -- the draft row IS the working copy;
// Apply/Discard act on it. Shown once, at the top of the page.
function renderDraftBanner(draft, pendingDiff, { market = 'uae' } = {}) {
  if (!draft.is_dirty) {
    return `<div class="banner-ok">Нет ожидающих изменений — эта конфигурация соответствует применённой версии ${escapeHtml(draft.based_on_version ?? '?')}.</div>`;
  }
  // Plain-language pending-change summary (spec section 13): reuses the
  // SAME diffConfigVersions()/diffSummary() already used for version-to-
  // version history, comparing the draft against the currently active
  // version's snapshot. Presentation only -- Apply/Discard still act on
  // the draft exactly as before; this only shows what would change.
  const pendingSummary = pendingDiff
    ? `<div style="margin-top:8px;"><strong>Что изменится при применении:</strong>${diffSummary(pendingDiff)}</div>`
    : '';
  const qs = marketQS(market);
  return `<div class="banner-warning">
    <strong>Есть неприменённые изменения.</strong> Изменения ниже сохранены только как черновик и не влияют на активную конфигурацию, пока вы не нажмёте «Применить конфигурацию».
    ${pendingSummary}
    <form class="inline" method="post" action="/settings/apply${qs}" style="margin-top:8px;">
      <input name="note" placeholder="Необязательное примечание к версии" style="width:280px;">
      <button type="submit">Применить конфигурацию</button>
    </form>
    <form class="inline" method="post" action="/settings/discard${qs}" onsubmit="return confirm('Отменить все неприменённые изменения черновика?')">
      <button class="small" type="submit">Отменить черновик</button>
    </form>
  </div>`;
}

// "Current active mode" banner (spec section 8): a plain-language summary
// computed FROM the live settings map every time the page renders -- never
// a hardcoded description of production state, so it can never go stale
// the way the old Sources page banner once did.
function renderActiveModeBanner(settings) {
  const cutoverEnabled = settings.v2_intake_cutover_enabled?.value === true;
  const policy = settings.buyer_signal_policy?.value;
  const policyUi = ruleUi.getBuyerSignalPolicyUi(policy);
  const whitelistThreshold = settings.whitelist_threshold?.value;
  const propertyThreshold = settings.property_signal_threshold?.value;
  const connector = policy === 'REQUIRE_BOTH' ? 'И' : 'ИЛИ';

  if (!cutoverEnabled) {
    return `<div class="banner-ok"><strong>Текущий режим:</strong> обычная обработка (рабочий режим V2 выключен). Правила и пороги на этой странице пока действуют только в теневом режиме и не влияют на реальные сообщения.</div>`;
  }
  return `<div class="banner-warning"><strong>Текущий режим:</strong> детерминированный шлюз V2 управляет допуском к ИИ. Сообщение отклоняется, если сработал «${ruleUi.RULE_GROUP_UI.BLACKLIST.title}». Иначе оно отправляется в ИИ, если сработало правило «${ruleUi.RULE_GROUP_UI.SEND_TO_AI.title}», либо набрано не менее ${escapeHtml(whitelistThreshold ?? '?')} сигнал(ов) «${ruleUi.RULE_GROUP_UI.WHITELIST.title}» ${connector} не менее ${escapeHtml(propertyThreshold ?? '?')} сигнал(ов) «${ruleUi.RULE_GROUP_UI.PROPERTY_SIGNAL.title}» (политика: ${escapeHtml(policyUi.label)}).</div>`;
}

function runtimeNotLiveBanner() {
  return `<p class="banner-warning">Большинство настроек на этой странице (правила, пороги, удаление дубликатов и параметры сопоставления) используются для ТЕНЕВОЙ оценки шлюза V2, а текущий локальный анализатор и предварительный отбор ИИ остаются основными. Единственное исключение — раздел «Шлюз приёма V2 — рабочий режим»: его включение передаёт детерминированному шлюзу управление реальным допуском к ИИ. Все остальные изменения начинают действовать только после применения черновика.</p>`;
}

// ---- A. Sources & Intake --------------------------------------------
function renderSourcesIntakeSection() {
  return `${sectionHeading(1, 'Sources & Intake')}
    <p class="empty">Маршрутизация и мониторинг источников по-прежнему настраиваются на странице <a href="/sources">«Источники / каналы»</a> и здесь не дублируются. Эта страница не добавляет новую логику маршрутизации источников.</p>`;
}

// ---- B. Deduplication -------------------------------------------------
function settingToggleRow(settings, key, label, explanation, market = 'uae') {
  const s = settings[key];
  if (!s) return `<p class="empty">Отсутствует настройка «${escapeHtml(key)}». Применена ли миграция 0020?</p>`;
  return `<div class="setting-row">
    <form class="inline" method="post" action="/settings/setting${marketQS(market)}">
      <input type="hidden" name="key" value="${escapeHtml(key)}">
      <input type="hidden" name="valueText" value="${s.value === true ? 'false' : 'true'}">
      <label><input type="checkbox" ${s.value ? 'checked' : ''} onchange="this.form.requestSubmit()"> <strong>${escapeHtml(label)}</strong></label>
    </form>
    <p class="empty setting-explain">${explanation}</p>
  </div>`;
}

function settingNumberRow(settings, key, label, explanation, { min, step } = {}, market = 'uae') {
  const s = settings[key];
  if (!s) return `<p class="empty">Отсутствует настройка «${escapeHtml(key)}». Применена ли миграция 0020?</p>`;
  return `<div class="setting-row">
    <form class="inline" method="post" action="/settings/setting${marketQS(market)}">
      <input type="hidden" name="key" value="${escapeHtml(key)}">
      <input type="hidden" name="enabled" value="true">
      <label><strong>${escapeHtml(label)}</strong>
        <input type="number" name="valueText" value="${escapeHtml(s.value)}" ${min !== undefined ? `min="${min}"` : ''} ${step !== undefined ? `step="${step}"` : ''}>
      </label>
      <button class="small" type="submit">Сохранить</button>
    </form>
    <p class="empty setting-explain">${explanation}</p>
  </div>`;
}

function renderDedupSection(settings, { market = 'uae' } = {}) {
  return `${sectionHeading(2, 'Deduplication')}
    ${settingToggleRow(settings, 'event_dedup_enabled', 'Удаление дубликатов событий',
      'Одно и то же сочетание платформы, аккаунта, чата и сообщения не должно обрабатываться дважды. Используется существующая модель захвата событий с арендой и безопасным повтором.', market)}
    ${settingToggleRow(settings, 'content_dedup_enabled', 'Удаление дубликатов содержимого и кэш',
      'Для повторяющегося текста можно использовать предыдущую интерпретацию вместо нового вызова ИИ.', market)}
    ${settingNumberRow(settings, 'content_dedup_ttl_hours', 'Срок хранения дубликатов содержимого, часы',
      'Как долго действует окно обнаружения дубликатов содержимого.', { min: 1, step: 1 }, market)}
    ${settingToggleRow(settings, 'ai_cache_enabled', 'Кэш интерпретаций ИИ',
      'Разрешает повторно использовать ранее вычисленную классификацию и разбор ИИ для одинакового нормализованного текста.', market)}
    ${settingNumberRow(settings, 'ai_cache_ttl_days', 'Срок хранения кэша ИИ, дни',
      'Как долго кэшированная интерпретация ИИ считается действительной.', { min: 1, step: 1 }, market)}
    ${settingNumberRow(settings, 'route_reject_retention_days', 'Автоочистка отклонённых по маршруту заявок, дни',
      'Каждое сообщение из общего источника приходит на вебхук всех рынков сразу, и этот сервис отклоняет чужой трафик (не свой маршрут) — такие записи не несут диагностической ценности и со временем накапливаются в базе (найдено 2026-10-06: 119 тыс. строк у РФ за неделю). Автоматически удаляются записи старше указанного срока; значение 0 отключает автоочистку. Реальные совпадения, НЕ-совпадения и отклонения по чёрному списку никогда не удаляются.', { min: 0, step: 1 }, market)}`;
}

// ---- C/D/E/F(SEND_TO_AI). Rule group CRUD (generic) --------------------
function ruleTypeOptions(current) {
  return MATCH_TYPES.map((t) => `<option value="${t}" ${t === current ? 'selected' : ''}>${MATCH_TYPE_LABELS[t] || t}</option>`).join('');
}

// ---- Live rule performance statistics (read-only, spec 2026-09-27) -----
// `ruleStats` (when provided) has the shape:
//   { period: '24h'|'7d'|'30d', error: boolean, byRule: Map<string, {mode, hits, v2SendToAi, v2Reject, hitToAiPct, hitToRejectPct}> }
// as produced by dashboard/shadow-queries.js's getRulePerformanceStats().
// `ruleStats` is entirely OPTIONAL everywhere below -- omitting it (as
// every pre-existing test does) renders the exact same cards as before,
// with no stats block at all. This keeps the feature additive/backward
// compatible rather than a breaking change to renderRuleSection's contract.
const RULE_STATS_PERIOD_LABELS = { '24h': 'последние 24 часа', '7d': 'последние 7 дней', '30d': 'последние 30 дней' };

// Same identity convention as getRulePerformanceStats() in
// dashboard/shadow-queries.js -- kept as a small local copy (no cross-page
// DB-layer import) rather than shared, matching this file's existing
// per-page constant duplication (RULE_GROUP_LABELS also duplicated in
// shadow-view.js).
function statsKeyForRule(rule) {
  return rule.id != null && Number(rule.id) > 0 ? `id:${rule.id}` : `key:${rule.rule_group}::${rule.match_type}::${rule.pattern}`;
}

function formatStatPct(rate) {
  return rate === null || rate === undefined ? '—' : `${Math.round(rate * 100)}%`;
}

// Group-specific labels (spec sections 8/9): BLACKLIST talks about
// "заблокировано", SEND_TO_AI talks about "принудительно" + an "unexpected
// reject" warning badge, everything else uses the generic AI/reject wording.
function renderRuleCardStats(rule, ruleStats) {
  if (!ruleStats) return '';
  const periodLabel = RULE_STATS_PERIOD_LABELS[ruleStats.period] || ruleStats.period;
  if (ruleStats.error) {
    return `<p class="empty setting-explain">Статистика недоступна (за ${periodLabel})</p>`;
  }
  const disabledBadge = rule.enabled === false ? ' ' + statusBadge('отключено', 'warn') : '';

  // Duplicate rules (spec section 17): prefer stats keyed by this rule's
  // OWN stable id; if telemetry has no per-id breakdown for it (legacy
  // rows, or two duplicate-pattern rules whose hits were only ever
  // recorded under the shared pattern key), fall back to the
  // group+match_type+pattern key and say so explicitly -- never invent a
  // per-id split the data doesn't support.
  let stat = ruleStats.byRule.get(statsKeyForRule(rule));
  let sharedFallback = false;
  if (!stat) {
    const fallbackKey = `key:${rule.rule_group}::${rule.match_type}::${rule.pattern}`;
    const fallbackStat = ruleStats.byRule.get(fallbackKey);
    if (fallbackStat) {
      stat = fallbackStat;
      sharedFallback = true;
    }
  }
  const sharedNote = sharedFallback ? ' <em>(общая статистика для повторяющегося шаблона)</em>' : '';

  if (!stat || stat.hits === 0) {
    return `<p class="empty setting-explain">За ${periodLabel}: нет срабатываний${disabledBadge}</p>`;
  }
  const modeLabel = stat.mode === 'AUTHORITATIVE' ? `Рабочий режим &middot; ${periodLabel}` : `Теневой режим &middot; ${periodLabel}`;

  if (rule.rule_group === 'BLACKLIST') {
    return `<p class="empty setting-explain">${modeLabel}: ${stat.hits} срабатываний &middot; заблокировано: ${stat.v2Reject} &middot; дошло до ИИ: ${stat.v2SendToAi}${sharedNote}${disabledBadge}</p>`;
  }
  if (rule.rule_group === 'SEND_TO_AI') {
    const unexpectedRejectWarning = stat.v2Reject > 0 ? ' ' + statusBadge('Проверить', 'warn') : '';
    return `<p class="empty setting-explain">${modeLabel}: ${stat.hits} срабатываний &middot; принудительно в ИИ: ${stat.v2SendToAi} &middot; неожиданный отказ: ${stat.v2Reject}${unexpectedRejectWarning}${sharedNote}${disabledBadge}</p>`;
  }
  return `<p class="empty setting-explain">${modeLabel}: ${stat.hits} срабатываний &middot; в ИИ: ${stat.v2SendToAi} (${formatStatPct(stat.hitToAiPct)}) &middot; отклонено: ${stat.v2Reject} (${formatStatPct(stat.hitToRejectPct)})${sharedNote}${disabledBadge}</p>`;
}

// Lightweight period selector (spec section 5) -- ONE control for the whole
// rule-management area, not one per card. A plain link (full page reload,
// same as every other navigation on this dependency-free server-rendered
// page) that never creates a draft or touches config state -- it only
// changes the `rule_stats_period` query parameter.
function renderRuleStatsPeriodSelector(currentPeriod) {
  const periods = ['24h', '7d', '30d'];
  const links = periods
    .map((p) => (p === currentPeriod
      ? `<strong>${escapeHtml(RULE_STATS_PERIOD_LABELS[p])}</strong>`
      : `<a href="/settings?rule_stats_period=${p}#blacklist">${escapeHtml(RULE_STATS_PERIOD_LABELS[p])}</a>`))
    .join(' &middot; ');
  return `<p class="empty settings-toc">Статистика правил за: ${links}</p>`;
}

// Group-level summary (spec section 10, optional). `groupSummary` (when
// provided) is one entry of getRuleGroupPerformanceSummary()'s byGroup Map:
// { mode, messagesWithHit, messagesReachingAi, totalRuleHits, distinctRuleIds }.
function renderRuleGroupSummary(groupSummary, period) {
  if (!groupSummary) return '';
  const periodLabel = RULE_STATS_PERIOD_LABELS[period] || period;
  if (!groupSummary.mode || groupSummary.totalRuleHits === 0) {
    return `<p class="empty setting-explain">За ${periodLabel}: срабатываний пока нет.</p>`;
  }
  const modeLabel = groupSummary.mode === 'AUTHORITATIVE' ? 'рабочий режим' : 'теневой режим';
  return `<p class="empty setting-explain">За ${periodLabel} (${modeLabel}): сработавших правил — ${groupSummary.distinctRuleIds}, всего срабатываний — ${groupSummary.totalRuleHits}, сообщений дошло до ИИ — ${groupSummary.messagesReachingAi} из ${groupSummary.messagesWithHit}. <em>Срабатывания правил могут пересекаться: одно сообщение может подходить сразу под несколько правил.</em></p>`;
}

// Detection-only, same "surface it, never auto-fix it" convention already
// established for the Sources page's cross-account duplicate badge
// (sources-view.js's duplicateBadge) -- groups rules within ONE rule group
// by (match_type, pattern) and returns only the groups with more than one
// member. Never merges, disables, or deletes anything.
function findDuplicatePatterns(rules) {
  const seen = new Map();
  for (const r of rules) {
    const key = `${r.match_type}::${r.pattern}`;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(r);
  }
  return [...seen.values()].filter((group) => group.length > 1);
}

function duplicateRulesWarning(duplicateGroups) {
  if (!duplicateGroups.length) return '';
  const items = duplicateGroups
    .map((group) => `<li><code>${escapeHtml(group[0].pattern)}</code> — одинаковый шаблон встречается в правилах ${group.map((r) => `#${r.id}`).join(', ')}</li>`)
    .join('');
  return `<div class="banner-warning">Обнаружены повторяющиеся правила (одинаковый тип и шаблон). Ничего не удалено и не объединено автоматически — при необходимости уберите дубликат вручную.<ul>${items}</ul></div>`;
}

// Live-safety warning (spec section 12): shown above a rule group's cards
// whenever v2_intake_cutover_enabled=true, since edits here start affecting
// real traffic as soon as the draft is applied. BLACKLIST gets stronger
// wording because a bad blacklist pattern can reject real buyers with zero
// AI calls. Purely informational -- never blocks editing.
function liveSafetyWarning(groupName, cutoverEnabled) {
  if (!cutoverEnabled) return '';
  if (groupName === 'BLACKLIST') {
    return `<div class="banner-warning"><strong>Рабочий режим (Live Cutover) включён.</strong> Изменения в этой группе, после применения черновика, будут ОТКЛОНЯТЬ реальные сообщения ещё до того, как их увидит ИИ. Проверьте формулировку внимательно перед тем, как нажать «Применить конфигурацию».</div>`;
  }
  return `<div class="banner-warning">Рабочий режим (Live Cutover) включён. Изменения в этой группе повлияют на реальный трафик после применения черновика.</div>`;
}

// A <form> is not a valid direct child of <table>/<tr>/<td> spanning
// multiple cells -- this project already hit and fixed exactly that bug
// once (sources-view.js's own AUDIT item #4 comment). Each row's inputs
// instead associate with a standalone, empty `<form form-id>` placed
// BEFORE the table (hidden via CSS, position doesn't matter for the
// `form="..."` attribute) -- valid HTML5, same pattern as the Sources
// page's bulk-update checkboxes.
//
// Settings UI simplification (2026-09-27): the table's PRIMARY, always-
// visible cell is now the rule's friendly name/description/example (never
// the raw regex). Raw match type/pattern/priority/description/id/group --
// still the actual editable fields, posting to the exact same per-row form
// -- live inside a collapsed <details>/<summary> "Дополнительно" (Advanced)
// disclosure, closed by default. This changes ONLY presentation: the same
// inputs, names, and form associations as before, so editing/saving/
// deleting a rule is byte-for-byte the same request it always was.
function ruleGroupTable(rules, groupName, ruleStats = null, market = 'uae') {
  if (!rules.length) {
    return `<p class="empty">В группе «${escapeHtml(RULE_GROUP_LABELS[groupName] || groupName)}» пока нет правил.${groupName === 'SEND_TO_AI' ? ' Это ожидаемо: сейчас нет жёстко заданного аналога (см. происхождение начальных данных этапа 1).' : ''}</p>`;
  }
  const qs = marketQS(market);
  const editForms = rules
    .map((r) => `<form class="hidden-row-form" id="rule-form-${r.id}" method="post" action="/settings/rule/${r.id}${qs}"></form>`)
    .join('');
  const deleteForms = rules
    .map((r) => `<form class="hidden-row-form" id="rule-delete-form-${r.id}" method="post" action="/settings/rule/${r.id}/delete${qs}" onsubmit="return confirm('Удалить это правило из черновика?')"></form>`)
    .join('');

  const duplicateGroups = findDuplicatePatterns(rules);
  const duplicateIds = new Set(duplicateGroups.flat().map((r) => r.id));

  const rows = rules
    .map((r) => {
      const friendlyName = ruleUi.getRuleFriendlyName(r);
      const friendlyDescription = ruleUi.getRuleFriendlyDescription(r);
      const example = ruleUi.getRuleExample(r);
      const isDup = duplicateIds.has(r.id);
      return `<tr>
      <td>
        <input type="hidden" name="enabled" value="false" form="rule-form-${r.id}">
        <label><input type="checkbox" name="enabled" value="true" ${r.enabled ? 'checked' : ''} form="rule-form-${r.id}" onchange="this.form.requestSubmit()"> ${r.enabled ? 'вкл' : 'выкл'}</label>
      </td>
      <td>
        <code class="rule-id">#${escapeHtml(r.id)}</code> <strong>${escapeHtml(friendlyName)}</strong>${isDup ? ' ' + statusBadge('дубль', 'warn') : ''}
        ${friendlyDescription ? `<div class="setting-explain">${escapeHtml(friendlyDescription)}</div>` : ''}
        ${example ? `<div class="setting-explain"><em>Пример: ${escapeHtml(example)}</em></div>` : ''}
        ${renderRuleCardStats(r, ruleStats)}
        <details>
          <summary>Дополнительно</summary>
          <div class="setting-row" style="margin-top:6px;">
            <label>Тип: <select name="match_type" form="rule-form-${r.id}">${ruleTypeOptions(r.match_type)}</select></label>
            <label>Шаблон: <input name="pattern" value="${escapeHtml(r.pattern)}" style="width:260px;" form="rule-form-${r.id}"></label>
            <label>Приоритет: <input name="priority" type="number" value="${escapeHtml(r.priority)}" style="width:70px;" form="rule-form-${r.id}"></label>
            <label>Описание: <input name="description" value="${escapeHtml(r.description || '')}" style="width:220px;" placeholder="источник / примечания" form="rule-form-${r.id}"></label>
            <p class="empty setting-explain">ID правила: ${escapeHtml(r.id)} &middot; группа (backend): <code>${escapeHtml(r.rule_group || groupName)}</code></p>
          </div>
        </details>
      </td>
      <td><button class="small" type="submit" form="rule-form-${r.id}">Сохранить</button></td>
      <td><button class="small" type="submit" form="rule-delete-form-${r.id}">Удалить</button></td>
    </tr>`;
    })
    .join('');
  return `${editForms}${deleteForms}${duplicateRulesWarning(duplicateGroups)}<div class="table-wrap"><table>
    <thead><tr><th>Вкл.</th><th>Правило</th><th></th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function addRuleForm(groupName, market = 'uae') {
  return `<form class="filters" method="post" action="/settings/rule${marketQS(market)}">
    <input type="hidden" name="rule_group" value="${escapeHtml(groupName)}">
    <input name="pattern" placeholder="Например: looking for, ищу…" required style="width:220px;" title="Пример фразы, которую нужно распознавать">
    <input name="description" placeholder="Название / описание правила" style="width:200px;">
    <label class="empty">Тип: <select name="match_type">${ruleTypeOptions('PHRASE')}</select></label>
    <input name="priority" type="number" value="100" style="width:70px;" title="Приоритет">
    <button type="submit">Добавить правило</button>
    <p class="empty setting-explain">«${MATCH_TYPE_LABELS.PHRASE}» ищет указанный текст как есть — подходит для большинства случаев. «${MATCH_TYPE_LABELS.REGEX}» — для тех, кто понимает синтаксис регулярных выражений; ошибка в шаблоне может пропустить или случайно заблокировать сообщения.</p>
  </form>`;
}

function renderRuleSection(index, groupName, title, explanation, rules, cutoverEnabled = false, ruleStats = null, groupSummary = null, { market = 'uae' } = {}) {
  const groupUi = ruleUi.getRuleGroupUi(groupName);
  const groupRules = rules[groupName] || [];
  return `${sectionHeading(index, title)}
    ${groupUi.subtitle ? `<p class="empty"><em>${escapeHtml(groupUi.subtitle)}</em></p>` : ''}
    <p class="empty">${groupUi.explanation ? escapeHtml(groupUi.explanation) : explanation}</p>
    ${liveSafetyWarning(groupName, cutoverEnabled)}
    ${ruleStats ? renderRuleGroupSummary(groupSummary, ruleStats.period) : ''}
    ${ruleGroupTable(groupRules, groupName, ruleStats, market)}
    ${addRuleForm(groupName, market)}`;
}

// ---- Phase 4: closed-enum dropdown (currently only buyer_signal_policy) --
function settingSelectRow(settings, key, label, explanation, options, market = 'uae') {
  const s = settings[key];
  if (!s) return `<p class="empty">Отсутствует настройка «${escapeHtml(key)}». Применена ли миграция 0023?</p>`;
  const optionsHtml = options
    .map(([value, optLabel]) => `<option value="${escapeHtml(value)}" ${s.value === value ? 'selected' : ''}>${escapeHtml(optLabel)}</option>`)
    .join('');
  return `<div class="setting-row">
    <form class="inline" method="post" action="/settings/setting${marketQS(market)}">
      <input type="hidden" name="key" value="${escapeHtml(key)}">
      <input type="hidden" name="enabled" value="true">
      <label><strong>${escapeHtml(label)}</strong>
        <select name="valueText" onchange="this.form.requestSubmit()">${optionsHtml}</select>
      </label>
    </form>
    <p class="empty setting-explain">${explanation}</p>
  </div>`;
}

// ---- Phase 4 (AGENTS_NIKA_MATCHING_V2.md section 26, Phase 4, requirement
// 3). Deliberately its OWN section, clearly separated from "Buyer
// Candidate Gate" above -- this is the ONE place that can make the V2
// gate authoritative for real traffic, so it gets its own heading and its
// own, more severe banner language rather than being folded into the
// gate's threshold/rule settings. Still Draft -> Apply only, same as
// every other control on this page -- no direct instant toggle.
function renderCutoverSection(settings, { market = 'uae' } = {}) {
  const cutoverEnabled = settings.v2_intake_cutover_enabled?.value === true;
  const policy = settings.buyer_signal_policy?.value;

  const cutoverBanner = cutoverEnabled
    ? `<div class="banner-warning"><strong>Шлюз V2 управляет допуском сообщений к ИИ.</strong> Предыдущий путь через локальный анализатор и предварительный отбор не участвует в решении о допуске к ИИ; он остаётся в кодовой базе только как автоматический резерв на случай сбоя оценки шлюза.</div>`
    : `<div class="banner-ok">Рабочий режим выключен — предыдущая система приёма остаётся основной, как на этапе 3. Шлюз V2 работает только в ТЕНЕВОМ режиме (см. <a href="/shadow-gate">«Теневой шлюз»</a>) и не влияет на реальные сообщения.</div>`;

  const policyWarning = policy === 'REQUIRE_ANY'
    ? `<p class="banner-warning">Аварийный разрешающий режим: снижает риск пропустить покупателя, но допускает в ИИ больше нерелевантного трафика. См. docs/MATCHING_V2_PHASE35_GATE_CALIBRATION.md — это временная калибровка, а не постоянная политика.</p>`
    : '';

  return `${sectionHeading(7, 'V2 Intake Gate — Live Cutover')}
    ${cutoverBanner}
    ${settingToggleRow(settings, 'v2_intake_cutover_enabled', 'Рабочий режим',
      'ВКЛ.: детерминированный шлюз V2 управляет допуском к ИИ; решение «Отклонить» означает ноль вызовов ИИ для сообщения. ВЫКЛ. (по умолчанию после каждого развёртывания): только теневой режим этапа 3.', market)}
    ${settingSelectRow(settings, 'buyer_signal_policy', 'Правило принятия решения',
      `Определяет, как сочетаются сигналы «${ruleUi.RULE_GROUP_UI.WHITELIST.title}» и «${ruleUi.RULE_GROUP_UI.PROPERTY_SIGNAL.title}», независимо от рабочего или теневого режима шлюза. «${ruleUi.BUYER_SIGNAL_POLICY_UI.REQUIRE_ANY.label}» — ${ruleUi.BUYER_SIGNAL_POLICY_UI.REQUIRE_ANY.description} «${ruleUi.BUYER_SIGNAL_POLICY_UI.REQUIRE_BOTH.label}» — ${ruleUi.BUYER_SIGNAL_POLICY_UI.REQUIRE_BOTH.description}`,
      [['REQUIRE_BOTH', ruleUi.BUYER_SIGNAL_POLICY_UI.REQUIRE_BOTH.label], ['REQUIRE_ANY', ruleUi.BUYER_SIGNAL_POLICY_UI.REQUIRE_ANY.label]], market)}
    ${policyWarning}
    <p class="empty">Перед включением рабочего режима для реального трафика проверьте в разделе <a href="/shadow-gate">«Теневой шлюз»</a> прогнозируемое и фактическое влияние на ИИ, а также структуру расхождений. Отказ по чёрному списку и явное срабатывание правила «Отправить в ИИ» всегда имеют приоритет над этой политикой в обоих режимах.</p>`;
}

// ---- F. Buyer Candidate Gate --------------------------------------------
// Static visual flow (spec section 9): explains the real evaluation order
// without changing it -- evaluateV2IntakeGate() in the matching service is
// the actual source of truth; this is presentation only.
function renderIntakeFlowDiagram() {
  return `<div class="channel-card">
    <h3>Как принимается решение о допуске в ИИ</h3>
    <p class="empty setting-explain">Порядок ниже — это реальный порядок проверки, показанный простыми словами. Он не меняется этой страницей.</p>
    <pre style="white-space:pre-wrap;font-size:12px;color:#9aa4b2;">1. Заблокированные сообщения (${RULE_GROUP_LABELS.BLACKLIST})?
   &rarr; ДА: отклонить, в ИИ не отправлять
2. Правило «${RULE_GROUP_LABELS.SEND_TO_AI}» сработало?
   &rarr; ДА: отправить в ИИ (независимо от порогов ниже)
3. Намерение купить и детали объекта &mdash; проверка по текущей политике
   (см. «${SECTION_LABELS['V2 Intake Gate — Live Cutover']}» ниже)
   &rarr; ДОСТАТОЧНО: отправить в ИИ
   &rarr; НЕДОСТАТОЧНО: отклонить, в ИИ не отправлять</pre>
  </div>`;
}

function renderBuyerGateSection(settings, rules, ruleStats = null, groupSummary = null, { market = 'uae' } = {}) {
  const propertySignalExplanation = market === 'moscow'
    ? moscowReference.RUNTIME_SETTINGS_DECISION.reasoning
    : 'Сколько срабатываний правил из группы «Детали объекта» нужно, чтобы отправить сообщение в ИИ.';
  return `${sectionHeading(6, 'Buyer Candidate Gate')}
    <p class="empty">Пороги ниже определяют, сколько сигналов должно сработать, прежде чем детерминированный шлюз сочтёт сообщение достаточно похожим на запрос покупателя, чтобы отправить его в ИИ.</p>
    ${settingNumberRow(settings, 'whitelist_threshold', `Минимум сигналов «${ruleUi.RULE_GROUP_UI.WHITELIST.title}»`,
      'Сколько срабатываний правил из группы «Намерение купить» нужно, чтобы отправить сообщение в ИИ.', { min: 0, step: 1 }, market)}
    ${settingNumberRow(settings, 'property_signal_threshold', `Минимум сигналов «${ruleUi.RULE_GROUP_UI.PROPERTY_SIGNAL.title}»`,
      escapeHtml(propertySignalExplanation), { min: 0, step: 1 }, market)}
    ${settingToggleRow(settings, 'ai_intake_gate_enabled', 'Шлюз допуска к ИИ',
      'Главный переключатель детерминированного шлюза ниже. На этапе 2 он не влияет на рабочий процесс.', market)}
    ${renderIntakeFlowDiagram()}
    <p class="empty">Правила «${ruleUi.RULE_GROUP_UI.SEND_TO_AI.title}» ниже — явные исключения оператора, которые всегда направляются в ИИ независимо от порогов выше.</p>
    ${ruleStats ? renderRuleGroupSummary(groupSummary, ruleStats.period) : ''}
    ${ruleGroupTable(rules.SEND_TO_AI || [], 'SEND_TO_AI', ruleStats, market)}
    ${addRuleForm('SEND_TO_AI', market)}`;
}

// ---- G. AI ---------------------------------------------------------------
function renderAiSection(settings, { market = 'uae' } = {}) {
  const cacheEnabled = settings.ai_cache_enabled?.value;
  const cacheTtl = settings.ai_cache_ttl_days?.value;
  const gateEnabled = settings.ai_intake_gate_enabled?.value;
  const moscowParserNote = market === 'moscow'
    ? `<div class="channel-card"><strong>ИИ-парсер (Москва)</strong>
        <p class="empty">${escapeHtml(moscowReference.AI_PARSER_DECISION.summary)}</p>
        <p class="empty setting-explain">${escapeHtml(moscowReference.AI_PARSER_DECISION.reasoning)}</p>
      </div>`
    : '';
  return `${sectionHeading(8, 'AI')}
    ${runtimeNotLiveBanner()}
    <p class="empty">Кэш ИИ: <strong>${cacheEnabled ? 'включён' : 'выключен'}</strong> (срок хранения: ${escapeHtml(cacheTtl)} дн.) — изменяется выше, в разделе <a href="#deduplication">«Удаление дубликатов»</a>.
    Шлюз допуска: <strong>${gateEnabled ? 'включён' : 'выключен'}</strong> — изменяется выше, в разделе <a href="#buyer-candidate-gate">«${escapeHtml(SECTION_LABELS['Buyer Candidate Gate'])}»</a>.</p>
    <p class="empty">Настройки модели, поставщика, запроса и повторов не входят в эту панель управления: они по-прежнему задаются через окружение в <code>src/config/index.js</code> и на этом этапе не меняются.</p>
    ${moscowParserNote}`;
}

// ---- H. Matching -----------------------------------------------------
// UAE and Moscow show genuinely DIFFERENT content here (2026-09-29) -- an
// earlier pass showed the generic 5-dimension UAE toggles on BOTH pages
// plus the Joker criteria table tacked onto Moscow's, which the user
// pointed out was confusing duplication and, worse, actively wrong: "Сопоставление
// по спальням" implies bedrooms is the one relevant field, but Moscow's
// real, finalized model (docs/PER_MARKET_SERVICE_INDEPENDENCE_PLAN.md
// section 5.1.1) treats комнаты (rooms) and спальни (bedrooms) as two
// DISTINCT fields. Migration 0030 removed the UAE-copied
// transaction/bedrooms/property_type/budget_matching_enabled and
// budget_tolerance_pct rows from matching_moscow.runtime_settings
// entirely -- Moscow's section 9 now shows ONLY the real 11-field Joker
// criteria table, never the UAE-shaped placeholder.
//
// Abu Dhabi (added 2026-10-05) is Dubai-shaped, NOT Moscow-shaped: it has
// no joker_*_enabled rows at all (it's a direct hard-filter matcher, ported
// BY ANALOGY from Dubai, not a Joker-criteria-toggle one) -- a bug found
// 2026-10-06 (user noticed the Moscow page's stale banner and asked about
// bots, which led to checking this page too): the old `market !== 'uae'`
// check silently routed Abu Dhabi into Moscow's Joker-criteria branch,
// rendering 15 "Отсутствует настройка «joker_*_enabled»" error rows. Fixed
// by checking `market === 'moscow'` explicitly instead -- Abu Dhabi now
// falls through to the same always-on hard-filter explanation as Dubai.
function renderMatchingSection(settings, { market = 'uae' } = {}) {
  if (market === 'moscow') {
    return `${sectionHeading(9, 'Matching')}${renderJokerCriteriaReference(settings, market)}`;
  }
  // The transaction/bedrooms/property_type/budget_matching_enabled toggles
  // and budget_tolerance_pct number field were removed from this page
  // (2026-09-30, audit finding): they existed in the Draft->Apply settings
  // schema and rendered as if editable, but no code in src/matching/**,
  // src/gates/**, or src/services/** ever read them -- hard-filters.js
  // always applies these criteria unconditionally when the request states
  // them, and the real price tolerance comes from the env var
  // MATCH_PRICE_TOLERANCE_PCT, never this DB row. Showing controls that
  // silently do nothing is worse than showing none; the underlying
  // runtime_settings rows are left untouched (harmless, just unreachable
  // from this UI) in case this gets wired into the real matcher later,
  // the way Moscow's own joker_*_enabled toggles were (see
  // renderJokerCriteriaReference below).
  return `${sectionHeading(9, 'Matching')}
    <div class="setting-row">
      <strong>Сопоставление по местоположению</strong> ${statusBadge('ОБЯЗАТЕЛЬНО / ВСЕГДА ВКЛЮЧЕНО', 'ok')}
      <p class="empty setting-explain">Местоположение нельзя отключить: это структурно обеспечено базой данных (ключ настройки <code>location_*</code> не может существовать) и проверкой приложения. Переключатель намеренно отсутствует.</p>
    </div>
    <p class="empty">Остальные критерии (тип сделки, спальни, тип недвижимости, бюджет и его допуск) сейчас всегда применяются в реальном матчере, когда заявка их указывает, и не настраиваются через эту панель — соответствующие переключатели убраны отсюда, чтобы не создавать впечатление управляемости там, где её нет.</p>`;
}

// Real, individually toggleable settings (2026-09-29, migration 0031) --
// each criterion is now its own matching_moscow.runtime_settings row
// (joker_*_enabled), saved via the SAME Draft->Apply mechanism as every
// other control on this page (settingToggleRow). Previously this was a
// static read-only badge table with no way to actually change anything --
// the user asked for section 9 to be "optionally configurable" like UAE's.
// Unlike UAE's now-removed toggles above, these ARE genuinely live
// (2026-09-29, ADR-038): rf-lead-matching-service's real matcher
// (hard-filters.js/candidate-query.js) reads every one of these values
// from runtime_settings on each request -- flipping a toggle here and
// clicking Apply really does change what the Moscow matcher does.
function renderJokerCriteriaReference(settings, market = 'moscow') {
  const rows = jokerCriteria.JOKER_CRITERIA
    .map((c) => settingToggleRow(settings, c.key, c.field, c.note || 'Критерий сопоставления Joker.', market))
    .join('');
  const notes = jokerCriteria.NORMALIZATION_NOTES.map((n) => `<li>${escapeHtml(n)}</li>`).join('');
  return `<div class="channel-card">
    <h3>Критерии Joker (Москва/РФ) — согласовано 2026-09-28</h3>
    <p class="empty setting-explain">Реальный сопоставитель для рынков Joker ещё не построен (docs/PER_MARKET_SERVICE_INDEPENDENCE_PLAN.md §5.2) — переключатели ниже сохраняются как обычная настройка и начнут действовать, как только он появится. Сток по этим рынкам уже можно посмотреть на странице <a href="/stock">«Объекты»</a>.</p>
    ${rows}
    <p class="empty setting-explain" style="margin-top:12px;"><strong>Нормализация (проверено на реальных данных):</strong></p>
    <ul>${notes}</ul>
  </div>`;
}

// ---- Moscow settings page banner (2026-09-28) --------------------------
// Moscow's /settings?market=moscow page reuses the SAME section renderers
// as UAE's page below (Dedup/Blacklist/Whitelist/Property Signals/Buyer
// Gate/Cutover/AI/Matching/History), backed by matching_moscow's own real,
// editable runtime_settings/intake_rules (migration 0029) -- the user
// explicitly asked for "the same as /settings, with the same parameters",
// not a separate read-only reference page (an earlier pass in this session
// had built one instead; this replaces it). Only this top banner and two
// small per-row explanation notes below differ, carrying the
// already-decided reasoning from docs/PER_MARKET_SERVICE_INDEPENDENCE_PLAN.md
// (dashboard/moscow-settings-reference.js).
function renderMoscowNotLiveBanner() {
  return `<p class="banner-warning">${escapeHtml(moscowReference.STILL_OPEN_NOTE)}</p>`;
}

// ---- Configuration History ----------------------------------------------
function historyTable(versions, market = 'uae') {
  if (!versions.length) return '<p class="empty">Версий конфигурации пока нет.</p>';
  const currentVersion = Math.max(...versions.map((v) => v.version_number));
  const qs = marketQS(market);
  const rows = versions
    .map((v) => `<tr>
      <td>${v.version_number}${v.version_number === currentVersion ? ' ' + statusBadge('текущая', 'ok') : ''}</td>
      <td>${escapeHtml(new Date(v.created_at).toLocaleString('ru-RU'))}</td>
      <td>${escapeHtml(v.created_by || '—')}</td>
      <td>${escapeHtml(v.note || '—')}</td>
      <td><a href="/settings/history/${v.version_number}${qs}">Открыть</a></td>
      <td>${v.version_number === currentVersion ? '' : `<form class="inline" method="post" action="/settings/history/${v.version_number}/rollback${qs}" onsubmit="return confirm('Откатиться к версии ${v.version_number}? Будет создана НОВАЯ версия, история не перезаписывается.')"><button class="small" type="submit">Откатиться к этой версии</button></form>`}</td>
    </tr>`)
    .join('');
  return `<div class="table-wrap"><table>
    <thead><tr><th>Версия</th><th>Создана</th><th>Автор</th><th>Примечание</th><th></th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function renderHistorySection(versions, { market = 'uae' } = {}) {
  return `${sectionHeading(10, 'Configuration History')}
    <p class="empty">Каждое применение или откат создаёт новую версию только для добавления: старые версии не изменяются и не удаляются. <a href="/settings/history${marketQS(market)}">Полная история &rarr;</a></p>
    ${historyTable(versions.slice(0, 5), market)}`;
}

// Full standalone history page (more detail than the summary embedded in
// the main Settings page).
function renderHistoryPage(versions, { market = 'uae' } = {}) {
  return `<h2>История конфигурации</h2>
    <p><a href="/settings${marketQS(market)}">&larr; назад к настройкам</a></p>
    <p class="empty">История только дополняется: откат к старой версии создаёт НОВУЮ версию, а не перезаписывает историю.</p>
    ${historyTable(versions, market)}`;
}

function diffSummary(diff) {
  const parts = [];
  if (diff.settingsChanged.length) {
    parts.push(`<h4>Изменённые настройки (${diff.settingsChanged.length})</h4><ul>${diff.settingsChanged
      .map((c) => `<li><code>${escapeHtml(c.key)}</code>: ${escapeHtml(c.before ? formatSettingValue(c.before.value_text) : '(новая)')} &rarr; ${escapeHtml(formatSettingValue(c.after.value_text))}${c.before && c.before.enabled !== c.after.enabled ? ` (включено: ${formatBoolean(c.before.enabled)} &rarr; ${formatBoolean(c.after.enabled)})` : ''}</li>`)
      .join('')}</ul>`);
  }
  if (diff.rulesAdded.length) {
    parts.push(`<h4>Добавленные правила (${diff.rulesAdded.length})</h4><ul>${diff.rulesAdded
      .map((r) => `<li>[${escapeHtml(RULE_GROUP_LABELS[r.rule_group] || r.rule_group)}] ${escapeHtml(MATCH_TYPE_LABELS[r.match_type] || r.match_type)}: <code>${escapeHtml(r.pattern)}</code></li>`)
      .join('')}</ul>`);
  }
  if (diff.rulesRemoved.length) {
    parts.push(`<h4>Удалённые правила (${diff.rulesRemoved.length})</h4><ul>${diff.rulesRemoved
      .map((r) => `<li>[${escapeHtml(RULE_GROUP_LABELS[r.rule_group] || r.rule_group)}] ${escapeHtml(MATCH_TYPE_LABELS[r.match_type] || r.match_type)}: <code>${escapeHtml(r.pattern)}</code></li>`)
      .join('')}</ul>`);
  }
  if (diff.rulesToggled.length) {
    parts.push(`<h4>Включённые или выключенные правила (${diff.rulesToggled.length})</h4><ul>${diff.rulesToggled
      .map((t) => `<li>[${escapeHtml(RULE_GROUP_LABELS[t.after.rule_group] || t.after.rule_group)}] <code>${escapeHtml(t.after.pattern)}</code>: ${formatBoolean(t.before.enabled)} &rarr; ${formatBoolean(t.after.enabled)}</li>`)
      .join('')}</ul>`);
  }
  if (!parts.length) return '<p class="empty">Отличий от предыдущей версии нет.</p>';
  return parts.join('');
}

function renderVersionDetailPage(version, diff, previousVersionNumber, { market = 'uae' } = {}) {
  const settingsTable = `<div class="table-wrap"><table><thead><tr><th>Ключ</th><th>Значение</th><th>Включено</th></tr></thead><tbody>
    ${version.snapshot.runtime_settings.map((s) => `<tr><td>${escapeHtml(s.key)}</td><td>${escapeHtml(formatSettingValue(s.value_text))}</td><td>${formatBoolean(s.enabled)}</td></tr>`).join('')}
  </tbody></table></div>`;

  const rulesByGroup = RULE_GROUPS.map((group) => {
    const rules = version.snapshot.intake_rules.filter((r) => r.rule_group === group);
    return `<h4>${escapeHtml(RULE_GROUP_LABELS[group] || group)} (${rules.length})</h4>${ruleGroupTable(rules.map((r, i) => ({ ...r, id: `v${version.version_number}-${group}-${i}` })), group)}`;
  }).join('');

  return `<h2>Версия конфигурации ${version.version_number}</h2>
    <p><a href="/settings/history${marketQS(market)}">&larr; назад к истории</a></p>
    <dl><dt>Создана</dt><dd>${escapeHtml(new Date(version.created_at).toLocaleString('ru-RU'))}</dd>
        <dt>Автор</dt><dd>${escapeHtml(version.created_by || '—')}</dd>
        <dt>Примечание</dt><dd>${escapeHtml(version.note || '—')}</dd></dl>
    ${previousVersionNumber ? `<h3>Отличия от версии ${previousVersionNumber}</h3>${diffSummary(diff)}` : '<p class="empty">Это первая версия, поэтому сравнивать её не с чем.</p>'}
    <h3>Полный снимок</h3>
    <h4>Настройки (${version.snapshot.runtime_settings.length})</h4>
    ${settingsTable}
    ${rulesByGroup}`;
}

module.exports = {
  PIPELINE_SECTIONS,
  sectionNav,
  renderDraftBanner,
  renderActiveModeBanner,
  renderRuleStatsPeriodSelector,
  renderRuleGroupSummary,
  runtimeNotLiveBanner,
  renderSourcesIntakeSection,
  renderDedupSection,
  renderRuleSection,
  renderBuyerGateSection,
  renderCutoverSection,
  renderAiSection,
  renderMatchingSection,
  renderJokerCriteriaReference,
  renderMoscowNotLiveBanner,
  renderHistorySection,
  renderHistoryPage,
  renderVersionDetailPage,
  diffSummary,
};
