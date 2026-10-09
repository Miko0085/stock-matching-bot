'use strict';

// Nika Matching V2, Phase 2 UI/render tests (AGENTS_NIKA_MATCHING_V2.md
// section 26, Phase 2, requirement 9). Pure render-function tests -- no
// DB/HTTP, same "data-in/HTML-out" contract as sources-view.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  PIPELINE_SECTIONS,
  sectionNav,
  renderDraftBanner,
  renderActiveModeBanner,
  renderRuleStatsPeriodSelector,
  renderRuleGroupSummary,
  runtimeNotLiveBanner,
  renderDedupSection,
  renderRuleSection,
  renderBuyerGateSection,
  renderCutoverSection,
  renderMatchingSection,
  renderAiSection,
  renderJokerCriteriaReference,
  renderMoscowNotLiveBanner,
  renderHistorySection,
  renderVersionDetailPage,
} = require('../../dashboard/settings-view');

// Same dependency-free nesting check as sources-view.test.js's own
// AUDIT item #4 regression guard -- reused here since ruleGroupTable()
// follows the exact same "form associated by id, not by physical nesting"
// pattern this project already established for the Sources page.
function assertNoNestedForms(html) {
  const tagRe = /<\/?form\b[^>]*>/gi;
  let depth = 0;
  let match;
  while ((match = tagRe.exec(html)) !== null) {
    const isClosing = match[0].startsWith('</');
    if (isClosing) depth -= 1;
    else {
      assert.ok(depth === 0, `found a <form> nested inside another <form> at index ${match.index}: ${match[0]}`);
      depth += 1;
    }
  }
}

function makeSettings(overrides = {}) {
  const base = {
    event_dedup_enabled: { value: true, enabled: true },
    content_dedup_enabled: { value: true, enabled: true },
    content_dedup_ttl_hours: { value: 48, enabled: true },
    ai_cache_enabled: { value: true, enabled: true },
    ai_cache_ttl_days: { value: 14, enabled: true },
    whitelist_threshold: { value: 1, enabled: true },
    property_signal_threshold: { value: 1, enabled: true },
    transaction_matching_enabled: { value: true, enabled: true },
    bedrooms_matching_enabled: { value: true, enabled: true },
    property_type_matching_enabled: { value: true, enabled: true },
    budget_matching_enabled: { value: true, enabled: true },
    budget_tolerance_pct: { value: 10, enabled: true },
    ai_intake_gate_enabled: { value: true, enabled: true },
  };
  return { ...base, ...overrides };
}

// Moscow's real settings shape (2026-09-29, migrations 0029-0031): no
// UAE-only 5-dimension matching toggles (removed by migration 0030), plus
// the 15 individually-toggleable Joker criteria settings.
function makeMoscowSettings(overrides = {}) {
  const base = {
    event_dedup_enabled: { value: true, enabled: true },
    content_dedup_enabled: { value: true, enabled: true },
    content_dedup_ttl_hours: { value: 48, enabled: true },
    ai_cache_enabled: { value: true, enabled: true },
    ai_cache_ttl_days: { value: 14, enabled: true },
    whitelist_threshold: { value: 1, enabled: true },
    property_signal_threshold: { value: 0, enabled: true },
    ai_intake_gate_enabled: { value: true, enabled: true },
    v2_intake_cutover_enabled: { value: false, enabled: true },
    buyer_signal_policy: { value: 'REQUIRE_BOTH', enabled: true },
    joker_property_type_enabled: { value: true, enabled: true },
    joker_city_enabled: { value: true, enabled: true },
    joker_district_enabled: { value: true, enabled: true },
    joker_complex_enabled: { value: true, enabled: true },
    joker_rooms_enabled: { value: true, enabled: true },
    joker_bedrooms_enabled: { value: true, enabled: true },
    joker_area_enabled: { value: true, enabled: true },
    joker_floor_enabled: { value: true, enabled: true },
    joker_floors_total_enabled: { value: true, enabled: true },
    joker_price_enabled: { value: true, enabled: true },
    joker_readiness_enabled: { value: true, enabled: true },
    joker_layout_enabled: { value: false, enabled: true },
    joker_euro_layout_enabled: { value: false, enabled: true },
    joker_deal_type_enabled: { value: false, enabled: true },
    joker_amenities_enabled: { value: false, enabled: true },
  };
  return { ...base, ...overrides };
}

test('PIPELINE_SECTIONS / sectionNav: sections are declared and linked in the exact pipeline order', () => {
  assert.deepEqual(PIPELINE_SECTIONS, [
    'Sources & Intake', 'Deduplication', 'Blacklist', 'Whitelist', 'Property Signals',
    'Buyer Candidate Gate', 'V2 Intake Gate — Live Cutover', 'AI', 'Matching', 'Configuration History',
  ]);
  const nav = sectionNav();
  // Every section must appear in the nav, in order. Labels are rendered
  // through escapeHtml() (e.g. "&" -> "&amp;"), so search on the anchor
  // slug instead of the raw label text.
  let lastIndex = -1;
  for (const label of PIPELINE_SECTIONS) {
    const anchor = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const idx = nav.indexOf(`#${anchor}`);
    assert.ok(idx > lastIndex, `"${label}" (#${anchor}) should appear after the previous section in the nav`);
    lastIndex = idx;
  }
});

test('renderDraftBanner: dirty draft shows the unsaved-changes warning with Apply/Discard actions', () => {
  const html = renderDraftBanner({ is_dirty: true, based_on_version: 3 });
  assert.match(html, /неприменённые изменения/i);
  assert.match(html, /action="\/settings\/apply"/);
  assert.match(html, /action="\/settings\/discard"/);
});

test('renderDraftBanner: clean draft shows "no pending changes" and the applied version number', () => {
  const html = renderDraftBanner({ is_dirty: false, based_on_version: 5 });
  assert.match(html, /нет ожидающих изменений/i);
  assert.match(html, /версии 5/);
  assert.doesNotMatch(html, /action="\/settings\/apply"/);
});

test('runtimeNotLiveBanner: states plainly that only the Live Cutover section can affect real intake decisions', () => {
  const html = runtimeNotLiveBanner();
  assert.match(html, /ТЕНЕВОЙ оценки/i);
  assert.match(html, /рабочий режим/i);
});

test('renderRuleSection: BLACKLIST/WHITELIST/PROPERTY_SIGNAL/SEND_TO_AI rules are all visible when present', () => {
  const rules = {
    BLACKLIST: [{ id: 1, rule_group: 'BLACKLIST', match_type: 'PHRASE', pattern: 'сдам', enabled: true, priority: 100, description: 'seller offer' }],
    WHITELIST: [{ id: 2, rule_group: 'WHITELIST', match_type: 'REGEX', pattern: '\\bneed\\b', enabled: true, priority: 100, description: null }],
    PROPERTY_SIGNAL: [{ id: 3, rule_group: 'PROPERTY_SIGNAL', match_type: 'REGEX', pattern: '\\bsqft\\b', enabled: false, priority: 100, description: null }],
    SEND_TO_AI: [],
  };
  for (const group of ['BLACKLIST', 'WHITELIST', 'PROPERTY_SIGNAL']) {
    const html = renderRuleSection(3, group, group, 'explanation', rules);
    assert.match(html, new RegExp(rules[group][0].pattern.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
  }
});

test('renderRuleSection: SEND_TO_AI empty state renders without crashing and explains why it is empty', () => {
  const rules = { BLACKLIST: [], WHITELIST: [], PROPERTY_SIGNAL: [], SEND_TO_AI: [] };
  const html = renderRuleSection(6, 'SEND_TO_AI', 'SEND_TO_AI', 'explanation', rules);
  assert.match(html, /В группе «Отправить в ИИ» пока нет правил/);
});

test('renderRuleSection: rule tables never produce a <form> nested inside another <form>', () => {
  const rules = {
    BLACKLIST: [
      { id: 1, rule_group: 'BLACKLIST', match_type: 'PHRASE', pattern: 'сдам', enabled: true, priority: 100, description: null },
      { id: -1, rule_group: 'BLACKLIST', match_type: 'REGEX', pattern: '\\bfor\\s+sale\\b', enabled: true, priority: 100, description: null },
    ],
  };
  const html = renderRuleSection(3, 'BLACKLIST', 'Blacklist', 'explanation', rules);
  assertNoNestedForms(html);
});

test('renderRuleSection: every ROW-level <form> (rule-form-*/rule-delete-form-*) is declared BEFORE the <table>, never spanning table cells', () => {
  const rules = {
    WHITELIST: [{ id: 5, rule_group: 'WHITELIST', match_type: 'PHRASE', pattern: 'ищу', enabled: true, priority: 100, description: null }],
  };
  const html = renderRuleSection(4, 'WHITELIST', 'Whitelist', 'explanation', rules);
  const tableIndex = html.indexOf('<table');
  assert.ok(tableIndex > -1, 'expected a <table> to be rendered');
  const beforeTable = html.slice(0, tableIndex);
  const afterTable = html.slice(tableIndex);

  // The per-row edit/delete forms are id-associated (form="rule-form-5" /
  // "rule-delete-form-5" on the inputs) and must be declared before the
  // table. The section's own "add a new rule" form is legitimately
  // rendered AFTER the table (it's a normal, non-spanning form, not a
  // per-row one) -- so this checks specifically for the row-form ids,
  // not "no form anywhere after the table".
  assert.doesNotMatch(afterTable, /id="rule-(?:form|delete-form)-5"/, 'a row-level form must not be declared after the table');
  assert.match(beforeTable, /id="rule-form-5"/);
  assert.match(beforeTable, /id="rule-delete-form-5"/);
  assertNoNestedForms(beforeTable);
});

test('renderRuleSection: draft-only rules (synthetic negative id) still produce valid, unique form associations', () => {
  const rules = { SEND_TO_AI: [{ id: -1, rule_group: 'SEND_TO_AI', match_type: 'PHRASE', pattern: 'vip exception', enabled: true, priority: 100, description: null }] };
  const html = renderRuleSection(6, 'SEND_TO_AI', 'SEND_TO_AI', 'explanation', rules);
  assert.match(html, /id="rule-form--1"/);
  assert.match(html, /form="rule-form--1"/);
});

test('renderMatchingSection: LOCATION is rendered as mandatory/locked, with no toggle input at all', () => {
  const html = renderMatchingSection(makeSettings());
  assert.match(html, /ОБЯЗАТЕЛЬНО \/ ВСЕГДА ВКЛЮЧЕНО/);
  // No checkbox/input anywhere in the location line, and no element whose
  // name attribute could represent a location setting key.
  assert.doesNotMatch(html, /name="[^"]*location[^"]*"/i);
  assert.doesNotMatch(html, /key"\s+value="location_/i);
});

test('renderMatchingSection: the four non-functional matching toggles were removed (2026-09-30 audit) -- no control for any of them exists any more', () => {
  const html = renderMatchingSection(makeSettings());
  for (const key of ['transaction_matching_enabled', 'bedrooms_matching_enabled', 'property_type_matching_enabled', 'budget_matching_enabled', 'budget_tolerance_pct']) {
    assert.doesNotMatch(html, new RegExp(`name="[^"]*${key}[^"]*"`, 'i'), `expected no editable control for ${key} -- it was never actually read by the real matcher`);
  }
  assert.match(html, /не настраиваются через эту панель/);
});

test('renderMatchingSection: metadata-only fields (bathrooms/size/furnishing/etc.) never appear as toggle inputs', () => {
  const html = renderMatchingSection(makeSettings());
  for (const metadataField of ['bathrooms', 'size', 'plot size', 'furnishing', 'view', 'cash']) {
    assert.doesNotMatch(html, new RegExp(`name="[^"]*${metadataField}[^"]*"`, 'i'));
  }
});

// REGRESSION (found 2026-09-27 while activating Live Cutover through the
// real dashboard: the DB and the draft both correctly showed
// v2_intake_cutover_enabled=true, but the rendered page still said
// "Cutover is OFF"). Every read in this file used `s.value.value`
// (double-nested) against a map whose actual shape is `{value: <primitive>,
// enabled}` (single-level) -- settings.js's own getActiveRuntimeSettings()
// and server.js's settingsMapFromDraftArray() both produce this exact
// shape, matching makeSettings()'s fixture above. `s.value.value` was
// therefore always `undefined` regardless of the real value: every
// checkbox always rendered unchecked, every number field always rendered
// empty, and no <select> option was ever marked selected -- for the ENTIRE
// page, not just Live Cutover. No prior test caught it because none of
// them asserted the actual `checked`/`value`/`selected` attribute, only
// that a control for the key existed at all.
function checkboxAttrsFor(html, key) {
  const re = new RegExp(`key" value="${key}">[\\s\\S]*?valueText" value="(true|false)">[\\s\\S]*?<input type="checkbox"([^>]*)>`);
  const match = re.exec(html);
  assert.ok(match, `expected to find a checkbox row for "${key}"`);
  return { nextValueOnClick: match[1], isChecked: match[2].includes('checked') };
}

test('REGRESSION: a checkbox setting with value=true renders as checked, and the next click would submit "false"', () => {
  const html = renderDedupSection(makeSettings({ event_dedup_enabled: { value: true, enabled: true } }));
  const { isChecked, nextValueOnClick } = checkboxAttrsFor(html, 'event_dedup_enabled');
  assert.equal(isChecked, true);
  assert.equal(nextValueOnClick, 'false');
});

test('REGRESSION: a checkbox setting with value=false renders as unchecked, and the next click would submit "true"', () => {
  const html = renderDedupSection(makeSettings({ event_dedup_enabled: { value: false, enabled: true } }));
  const { isChecked, nextValueOnClick } = checkboxAttrsFor(html, 'event_dedup_enabled');
  assert.equal(isChecked, false);
  assert.equal(nextValueOnClick, 'true');
});

test('REGRESSION: a number setting\'s current value is actually rendered in the input, not left blank', () => {
  const html = renderBuyerGateSection(makeSettings({ whitelist_threshold: { value: 3, enabled: true } }), { BLACKLIST: [], WHITELIST: [], PROPERTY_SIGNAL: [], SEND_TO_AI: [] });
  assert.match(html, /name="valueText" value="3"/);
});

test('REGRESSION: renderCutoverSection reflects a TRUE v2_intake_cutover_enabled as ON, not "Cutover is OFF"', () => {
  const html = renderCutoverSection(makeSettings({
    v2_intake_cutover_enabled: { value: true, enabled: true },
    buyer_signal_policy: { value: 'REQUIRE_ANY', enabled: true },
  }));
  assert.match(html, /Шлюз V2 управляет допуском сообщений к ИИ/);
  assert.doesNotMatch(html, /Рабочий режим выключен/);
  assert.match(html, /<option value="REQUIRE_ANY" selected>/);
});

test('REGRESSION: renderCutoverSection reflects a FALSE v2_intake_cutover_enabled as "Cutover is OFF"', () => {
  const html = renderCutoverSection(makeSettings({
    v2_intake_cutover_enabled: { value: false, enabled: true },
    buyer_signal_policy: { value: 'REQUIRE_BOTH', enabled: true },
  }));
  assert.match(html, /Рабочий режим выключен/);
  assert.doesNotMatch(html, /Шлюз V2 управляет допуском сообщений к ИИ/);
  assert.match(html, /<option value="REQUIRE_BOTH" selected>/);
});

// ---- Settings UI simplification (2026-09-27) ---------------------------

test('renderRuleSection: the friendly name is the primary visible label, and the raw regex is tucked inside an Advanced disclosure', () => {
  const rules = {
    WHITELIST: [{ id: 2, rule_group: 'WHITELIST', match_type: 'REGEX', pattern: '\\blooking\\s+for\\b', enabled: true, priority: 100, description: null }],
  };
  const html = renderRuleSection(4, 'WHITELIST', 'Whitelist', 'explanation', rules);
  assert.match(html, /Ищу \(looking for\)/, 'friendly name should be shown as the primary label');
  assert.match(html, /<details>/, 'raw fields should be behind a collapsible Advanced disclosure');
  assert.match(html, /<summary>Дополнительно<\/summary>/);
});

test('renderRuleSection: each rule shows its numeric id visibly in the main row, not hidden inside Advanced -- needed to cross-reference the duplicate-pattern warning ("правилах #32, #47")', () => {
  const rules = {
    WHITELIST: [
      { id: 32, rule_group: 'WHITELIST', match_type: 'PHRASE', pattern: 'ищу квартиру', enabled: true, priority: 100, description: null },
      { id: 47, rule_group: 'WHITELIST', match_type: 'PHRASE', pattern: 'ищу квартиру', enabled: true, priority: 100, description: null },
    ],
  };
  const html = renderRuleSection(4, 'WHITELIST', 'Whitelist', 'explanation', rules);
  assert.match(html, /#32/);
  assert.match(html, /#47/);
  assert.match(html, /одинаковый шаблон встречается в правилах #32, #47/);
});

test('renderRuleSection: renamed group titles use plain-language wording, not the raw backend enum name', () => {
  const rules = { BLACKLIST: [], WHITELIST: [], PROPERTY_SIGNAL: [] };
  const blacklistHtml = renderRuleSection(3, 'BLACKLIST', 'Blacklist', 'explanation', rules);
  const whitelistHtml = renderRuleSection(4, 'WHITELIST', 'Whitelist', 'explanation', rules);
  const propertyHtml = renderRuleSection(5, 'PROPERTY_SIGNAL', 'Property Signals', 'explanation', rules);
  assert.match(blacklistHtml, /Спам продавцов и объявления/);
  assert.match(whitelistHtml, /Слова и фразы, указывающие/);
  assert.match(propertyHtml, /Признаки того, что сообщение описывает недвижимость/);
});

test('renderRuleSection: two rules with the same match_type+pattern within a group trigger a duplicate warning; a single occurrence does not', () => {
  const withDup = {
    BLACKLIST: [
      { id: 1, rule_group: 'BLACKLIST', match_type: 'PHRASE', pattern: 'сдам', enabled: true, priority: 100, description: null },
      { id: 2, rule_group: 'BLACKLIST', match_type: 'PHRASE', pattern: 'сдам', enabled: true, priority: 100, description: null },
    ],
  };
  const htmlWithDup = renderRuleSection(3, 'BLACKLIST', 'Blacklist', 'explanation', withDup);
  assert.match(htmlWithDup, /повторяющиеся правила/i);
  assert.match(htmlWithDup, /#1/);
  assert.match(htmlWithDup, /#2/);

  const withoutDup = { BLACKLIST: [{ id: 1, rule_group: 'BLACKLIST', match_type: 'PHRASE', pattern: 'сдам', enabled: true, priority: 100, description: null }] };
  const htmlNoDup = renderRuleSection(3, 'BLACKLIST', 'Blacklist', 'explanation', withoutDup);
  assert.doesNotMatch(htmlNoDup, /повторяющиеся правила/i);
});

test('renderRuleSection: no live-safety warning when Live Cutover is off (default); a warning appears when it is on, and BLACKLIST gets the stronger wording', () => {
  const rules = { BLACKLIST: [{ id: 1, rule_group: 'BLACKLIST', match_type: 'PHRASE', pattern: 'сдам', enabled: true, priority: 100, description: null }] };
  const off = renderRuleSection(3, 'BLACKLIST', 'Blacklist', 'explanation', rules, false);
  assert.doesNotMatch(off, /Рабочий режим \(Live Cutover\) включён/);

  const on = renderRuleSection(3, 'BLACKLIST', 'Blacklist', 'explanation', rules, true);
  assert.match(on, /ОТКЛОНЯТЬ реальные сообщения/);

  const whitelistRules = { WHITELIST: [{ id: 1, rule_group: 'WHITELIST', match_type: 'PHRASE', pattern: 'ищу', enabled: true, priority: 100, description: null }] };
  const whitelistOn = renderRuleSection(4, 'WHITELIST', 'Whitelist', 'explanation', whitelistRules, true);
  assert.match(whitelistOn, /Рабочий режим \(Live Cutover\) включён/);
  assert.doesNotMatch(whitelistOn, /ОТКЛОНЯТЬ реальные сообщения/);
});

test('renderActiveModeBanner: Live Cutover off -> plainly states normal processing, computed from settings, not hardcoded', () => {
  const html = renderActiveModeBanner(makeSettings({ v2_intake_cutover_enabled: { value: false, enabled: true } }));
  assert.match(html, /обычная обработка/);
});

test('renderActiveModeBanner: Live Cutover on -> describes the real decision using the CURRENT threshold values and policy', () => {
  const html = renderActiveModeBanner(makeSettings({
    v2_intake_cutover_enabled: { value: true, enabled: true },
    buyer_signal_policy: { value: 'REQUIRE_BOTH', enabled: true },
    whitelist_threshold: { value: 2, enabled: true },
    property_signal_threshold: { value: 3, enabled: true },
  }));
  assert.match(html, /не менее 2 сигнал/);
  assert.match(html, /не менее 3 сигнал/);
  assert.match(html, /И не менее/, 'REQUIRE_BOTH should render as an AND connector');
});

test('renderDraftBanner: with a pending diff, shows a plain-language "what will change" summary using the existing diff renderer', () => {
  const diff = {
    settingsChanged: [{ key: 'budget_tolerance_pct', before: { value_text: '10', enabled: true }, after: { value_text: '15', enabled: true } }],
    rulesAdded: [], rulesRemoved: [], rulesToggled: [],
  };
  const html = renderDraftBanner({ is_dirty: true, based_on_version: 3 }, diff);
  assert.match(html, /Что изменится при применении/);
  assert.match(html, /budget_tolerance_pct/);
});

test('renderDraftBanner: with no pending diff provided, still renders correctly (diff is optional)', () => {
  const html = renderDraftBanner({ is_dirty: true, based_on_version: 3 }, null);
  assert.doesNotMatch(html, /Что изменится при применении/);
  assert.match(html, /неприменённые изменения/i);
});

// ---- Live rule performance statistics (2026-09-27) ----------------------

function makeRuleStats(overrides = {}) {
  return { period: '24h', error: false, byRule: new Map(), ...overrides };
}

test('rule card statistics: a rule with hits shows the stats block on the card, not just in Advanced', () => {
  const rules = { WHITELIST: [{ id: 5, rule_group: 'WHITELIST', match_type: 'PHRASE', pattern: 'ищу', enabled: true, priority: 100, description: null }] };
  const ruleStats = makeRuleStats({ byRule: new Map([['id:5', { mode: 'AUTHORITATIVE', hits: 42, v2SendToAi: 40, v2Reject: 2, hitToAiPct: 40 / 42, hitToRejectPct: 2 / 42 }]]) });
  const html = renderRuleSection(4, 'WHITELIST', 'Whitelist', 'explanation', rules, false, ruleStats);
  assert.match(html, /42 срабатываний/);
  assert.match(html, /Рабочий режим/);
  assert.match(html, /последние 24 часа/);
});

test('rule card statistics: a rule with zero hits in the period shows "no hits", not a blank or crash', () => {
  const rules = { WHITELIST: [{ id: 6, rule_group: 'WHITELIST', match_type: 'PHRASE', pattern: 'ищу', enabled: true, priority: 100, description: null }] };
  const ruleStats = makeRuleStats({ byRule: new Map() });
  const html = renderRuleSection(4, 'WHITELIST', 'Whitelist', 'explanation', rules, false, ruleStats);
  assert.match(html, /нет срабатываний/);
});

test('rule card statistics: AUTHORITATIVE data is preferred and explicitly labeled; falls back to a labeled SHADOW figure only when AUTHORITATIVE is absent', () => {
  const rules = { WHITELIST: [{ id: 7, rule_group: 'WHITELIST', match_type: 'PHRASE', pattern: 'ищу', enabled: true, priority: 100, description: null }] };
  const authoritative = makeRuleStats({ byRule: new Map([['id:7', { mode: 'AUTHORITATIVE', hits: 10, v2SendToAi: 9, v2Reject: 1, hitToAiPct: 0.9, hitToRejectPct: 0.1 }]]) });
  const shadowOnly = makeRuleStats({ byRule: new Map([['id:7', { mode: 'SHADOW', hits: 500, v2SendToAi: 400, v2Reject: 100, hitToAiPct: 0.8, hitToRejectPct: 0.2 }]]) });
  const htmlAuth = renderRuleSection(4, 'WHITELIST', 'Whitelist', 'explanation', rules, false, authoritative);
  const htmlShadow = renderRuleSection(4, 'WHITELIST', 'Whitelist', 'explanation', rules, false, shadowOnly);
  assert.match(htmlAuth, /Рабочий режим/);
  assert.doesNotMatch(htmlAuth, /Теневой режим/);
  assert.match(htmlShadow, /Теневой режим/);
  assert.doesNotMatch(htmlShadow, /Рабочий режим &middot;/);
});

test('rule card statistics: analytics failure shows "unavailable" per card, and the page still renders the rule configuration normally', () => {
  const rules = { WHITELIST: [{ id: 8, rule_group: 'WHITELIST', match_type: 'PHRASE', pattern: 'ищу', enabled: true, priority: 100, description: null }] };
  const ruleStats = { period: '24h', error: true, byRule: new Map() };
  const html = renderRuleSection(4, 'WHITELIST', 'Whitelist', 'explanation', rules, false, ruleStats);
  assert.match(html, /Статистика недоступна/);
  assert.match(html, /ищу/, 'the rule itself must still render even if analytics failed');
});

test('rule card statistics: omitting ruleStats entirely (undefined) renders the card with no statistics block at all -- fully backward compatible', () => {
  const rules = { WHITELIST: [{ id: 9, rule_group: 'WHITELIST', match_type: 'PHRASE', pattern: 'ищу', enabled: true, priority: 100, description: null }] };
  const html = renderRuleSection(4, 'WHITELIST', 'Whitelist', 'explanation', rules);
  assert.doesNotMatch(html, /срабатываний/);
  assert.doesNotMatch(html, /Статистика недоступна/);
});

test('rule card statistics: BLACKLIST cards use "заблокировано"/"дошло до ИИ" wording instead of the generic AI/reject percentages', () => {
  const rules = { BLACKLIST: [{ id: 10, rule_group: 'BLACKLIST', match_type: 'PHRASE', pattern: 'сдам', enabled: true, priority: 100, description: null }] };
  const ruleStats = makeRuleStats({ byRule: new Map([['id:10', { mode: 'AUTHORITATIVE', hits: 362, v2SendToAi: 0, v2Reject: 362, hitToAiPct: 0, hitToRejectPct: 1 }]]) });
  const html = renderRuleSection(3, 'BLACKLIST', 'Blacklist', 'explanation', rules, false, ruleStats);
  assert.match(html, /заблокировано: 362/);
  assert.match(html, /дошло до ИИ: 0/);
});

test('rule card statistics: SEND_TO_AI cards show "принудительно в ИИ" and flag an unexpected reject with a review badge', () => {
  const rules = { SEND_TO_AI: [{ id: 11, rule_group: 'SEND_TO_AI', match_type: 'PHRASE', pattern: 'vip exception', enabled: true, priority: 100, description: null }] };
  const ruleStats = makeRuleStats({ byRule: new Map([['id:11', { mode: 'AUTHORITATIVE', hits: 5, v2SendToAi: 4, v2Reject: 1, hitToAiPct: 0.8, hitToRejectPct: 0.2 }]]) });
  const html = renderBuyerGateSection(makeSettings(), { SEND_TO_AI: rules.SEND_TO_AI }, ruleStats);
  assert.match(html, /принудительно в ИИ: 4/);
  assert.match(html, /неожиданный отказ: 1/);
  assert.match(html, /Проверить/);
});

test('rule card statistics: a disabled rule still shows its historical stats, labeled "отключено"', () => {
  const rules = { WHITELIST: [{ id: 12, rule_group: 'WHITELIST', match_type: 'PHRASE', pattern: 'ищу', enabled: false, priority: 100, description: null }] };
  const ruleStats = makeRuleStats({ byRule: new Map([['id:12', { mode: 'AUTHORITATIVE', hits: 7, v2SendToAi: 6, v2Reject: 1, hitToAiPct: 6 / 7, hitToRejectPct: 1 / 7 }]]) });
  const html = renderRuleSection(4, 'WHITELIST', 'Whitelist', 'explanation', rules, false, ruleStats);
  assert.match(html, /7 срабатываний/);
  assert.match(html, /отключено/);
});

test('rule card statistics: a duplicate-pattern rule with only pattern-keyed (fallback) telemetry still shows stats, without fabricating per-id separation', () => {
  const rules = {
    BLACKLIST: [
      { id: 20, rule_group: 'BLACKLIST', match_type: 'PHRASE', pattern: 'сдам', enabled: true, priority: 100, description: null },
      { id: 21, rule_group: 'BLACKLIST', match_type: 'PHRASE', pattern: 'сдам', enabled: true, priority: 100, description: null },
    ],
  };
  // Legacy telemetry with no rule id -- both rules resolve to the SAME
  // fallback key (group::match_type::pattern), so both cards legitimately
  // show the identical shared figure. This is documented behavior, not a bug.
  const ruleStats = makeRuleStats({ byRule: new Map([['key:BLACKLIST::PHRASE::сдам', { mode: 'SHADOW', hits: 30, v2SendToAi: 0, v2Reject: 30, hitToAiPct: 0, hitToRejectPct: 1 }]]) });
  const html = renderRuleSection(3, 'BLACKLIST', 'Blacklist', 'explanation', rules, false, ruleStats);
  const occurrences = (html.match(/30 срабатываний/g) || []).length;
  assert.equal(occurrences, 2, 'both duplicate-pattern rules should show the same shared fallback-keyed stats');
  const sharedLabelOccurrences = (html.match(/общая статистика для повторяющегося шаблона/g) || []).length;
  assert.equal(sharedLabelOccurrences, 2, 'both cards must explicitly label the stats as shared, never silently fabricate a per-id split');
});

test('renderRuleStatsPeriodSelector: highlights the current period and links to the other two, without altering config state', () => {
  const html = renderRuleStatsPeriodSelector('7d');
  assert.match(html, /<strong>последние 7 дней<\/strong>/);
  assert.match(html, /rule_stats_period=24h/);
  assert.match(html, /rule_stats_period=30d/);
  assert.doesNotMatch(html, /method="post"/);
});

test('renderRuleGroupSummary: shows the overlap disclaimer and aggregate counts; a group with zero hits shows "no hits" instead', () => {
  const withHits = renderRuleGroupSummary({ mode: 'AUTHORITATIVE', messagesWithHit: 100, messagesReachingAi: 63, totalRuleHits: 140, distinctRuleIds: 8 }, '24h');
  assert.match(withHits, /сработавших правил — 8/);
  assert.match(withHits, /могут пересекаться/);

  const noHits = renderRuleGroupSummary({ mode: null, messagesWithHit: 0, messagesReachingAi: 0, totalRuleHits: 0, distinctRuleIds: 0 }, '24h');
  assert.match(noHits, /срабатываний пока нет/);

  assert.equal(renderRuleGroupSummary(null, '24h'), '', 'omitting groupSummary entirely must never throw');
});

// ---- Joker matching-criteria reference (2026-09-28, read-only) ----------

test('renderJokerCriteriaReference: each criterion is a REAL toggle bound to its own matching_moscow.runtime_settings key, not a static badge (2026-09-29, migration 0031)', () => {
  const html = renderJokerCriteriaReference(makeMoscowSettings());
  assert.match(html, /Критерии Joker/);
  for (const field of ['Тип объекта', 'Город', 'Округ/Район', 'ЖК/Комплекс', 'Комнаты', 'Спальни', 'Площадь (м²)', 'Этаж', 'Этажей в доме', 'Цена (руб)', 'Готовность/Год постройки']) {
    assert.match(html, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `expected to find the criterion "${field}"`);
  }
  assert.match(html, /р-н.*р-он/);
  // A real toggle posts to /settings/setting, same as every other control.
  assert.match(html, /action="\/settings\/setting\?market=moscow"/);
  assert.match(html, /name="key" value="joker_property_type_enabled"/);
});

test('renderJokerCriteriaReference: an OFF-by-default criterion (e.g. Планировка) renders unchecked, matching its seeded value', () => {
  const html = renderJokerCriteriaReference(makeMoscowSettings());
  const layoutRowMatch = html.match(/name="key" value="joker_layout_enabled">[\s\S]*?<\/div>/);
  assert.ok(layoutRowMatch, 'expected to find the joker_layout_enabled row');
  assert.doesNotMatch(layoutRowMatch[0], /checked/);
});

test('renderMatchingSection: UAE (default/omitted market) never shows the Joker criteria reference -- that only belongs on a Joker-fed market\'s own page', () => {
  const html = renderMatchingSection(makeSettings());
  assert.doesNotMatch(html, /Критерии Joker/);
});

test('renderMatchingSection: market="moscow" shows ONLY the real, toggleable Joker criteria -- never the UAE-shaped placeholder toggles (2026-09-29: they conflicted with Moscow\'s real field model and duplicated the same information)', () => {
  const html = renderMatchingSection(makeMoscowSettings(), { market: 'moscow' });
  assert.doesNotMatch(html, /Сопоставление по типу сделки/);
  assert.doesNotMatch(html, /Сопоставление по спальням/, 'must never show a "bedrooms" toggle that conflicts with Moscow\'s distinct rooms-vs-bedrooms fields');
  assert.doesNotMatch(html, /Сопоставление по бюджету/);
  assert.match(html, /Критерии Joker/);
  assert.match(html, /name="key" value="joker_rooms_enabled"/, 'criteria are real toggles, not a static badge table');
});

test('renderBuyerGateSection: market="moscow" swaps in the property_signal_threshold=0 reasoning; UAE keeps its generic explanation', () => {
  const uaeHtml = renderBuyerGateSection(makeSettings(), { SEND_TO_AI: [] });
  assert.doesNotMatch(uaeHtml, /У ОАЭ порог 1 предполагает/);

  const moscowHtml = renderBuyerGateSection(makeSettings(), { SEND_TO_AI: [] }, null, null, { market: 'moscow' });
  assert.match(moscowHtml, /У ОАЭ порог 1 предполагает/);
});

test('renderAiSection: market="moscow" appends its own AI-parser decision note; UAE does not show it', () => {
  const uaeHtml = renderAiSection(makeSettings());
  assert.doesNotMatch(uaeHtml, /ИИ-парсер \(Москва\)/);

  const moscowHtml = renderAiSection(makeSettings(), { market: 'moscow' });
  assert.match(moscowHtml, /ИИ-парсер \(Москва\)/);
  assert.match(moscowHtml, /собственный системный промпт/);
});

test('renderMoscowNotLiveBanner: explicitly states real Moscow scoring weights are still undecided, so edits here have no live effect yet', () => {
  const html = renderMoscowNotLiveBanner();
  assert.match(html, /веса скоринга/i);
});

test('renderHistorySection: shows a link to the full history page', () => {
  const html = renderHistorySection([{ version_number: 1, created_at: new Date().toISOString(), created_by: 'seed', note: 'initial' }]);
  assert.match(html, /\/settings\/history/);
});

test('renderVersionDetailPage: renders a diff summary section when a previous version exists', () => {
  const version = {
    version_number: 2,
    created_at: new Date().toISOString(),
    created_by: 'operator',
    note: 'test',
    snapshot: { runtime_settings: [{ key: 'budget_tolerance_pct', value_text: '15', enabled: true }], intake_rules: [] },
  };
  const diff = { settingsChanged: [{ key: 'budget_tolerance_pct', before: { value_text: '10', enabled: true }, after: { value_text: '15', enabled: true } }], rulesAdded: [], rulesRemoved: [], rulesToggled: [] };
  const html = renderVersionDetailPage(version, diff, 1);
  assert.match(html, /Отличия от версии 1/);
  assert.match(html, /budget_tolerance_pct/);
});

test('renderVersionDetailPage: version 1 (no predecessor) shows no diff, not a crash', () => {
  const version = { version_number: 1, created_at: new Date().toISOString(), created_by: 'seed', note: 'initial', snapshot: { runtime_settings: [], intake_rules: [] } };
  const html = renderVersionDetailPage(version, null, null);
  assert.match(html, /первая версия/i);
});
