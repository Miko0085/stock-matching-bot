'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const shadowView = require('../../dashboard/shadow-view');

test('formatPct: null/undefined render as an em dash, never "NaN%"', () => {
  assert.equal(shadowView.formatPct(null), '—');
  assert.equal(shadowView.formatPct(undefined), '—');
  assert.equal(shadowView.formatPct(0.5), '50%');
});

test('shadowNotLiveBanner: explicitly states the gate is not wired into live routing', () => {
  const html = shadowView.shadowNotLiveBanner();
  assert.match(html, /НЕ подключён к рабочей маршрутизации/);
});

test('periodTabs: marks the active period, links to the other three', () => {
  const html = shadowView.periodTabs('7d');
  assert.match(html, /href="\/shadow-gate\?period=7d" class="active"/);
  assert.match(html, /href="\/shadow-gate\?period=24h"/);
  assert.match(html, /href="\/shadow-gate\?period=30d"/);
  assert.match(html, /href="\/shadow-gate\?period=all"/);
});

test('renderShadowSummary: zero-denominator projected_ai_reduction_pct never renders as NaN%/Infinity%', () => {
  const html = shadowView.renderShadowSummary({
    evaluated: 0, oldSendToAiCount: 0, v2SendToAiCount: 0,
    projectedAiSavedCount: 0, projectedAiAddedCount: 0,
    netProjectedAiChange: 0, projectedAiReductionPct: null,
    disagreementCount: 0, agreementCount: 0, agreementRate: null,
  });
  assert.doesNotMatch(html, /NaN/);
  assert.doesNotMatch(html, /Infinity/);
  assert.match(html, /—/);
});

test('renderShadowSummary: a real reduction renders a signed percentage and signed net-change', () => {
  const html = shadowView.renderShadowSummary({
    evaluated: 100, oldSendToAiCount: 40, v2SendToAiCount: 10,
    projectedAiSavedCount: 32, projectedAiAddedCount: 2,
    netProjectedAiChange: -30, projectedAiReductionPct: 75,
    disagreementCount: 34, agreementCount: 66, agreementRate: 0.66,
  });
  assert.match(html, /\+75%/);
  assert.match(html, /-30/);
  assert.match(html, />40</);
  assert.match(html, />10</);
});

test('renderDisagreementBreakdown: renders all 7 spec-required categories', () => {
  const html = shadowView.renderDisagreementBreakdown({
    oldSendToAiV2Reject: 1, oldRejectV2SendToAi: 2, oldParsedLocallyV2SendToAi: 3,
    blacklistDisagreement: 4, missingWhitelistSignal: 5, missingPropertySignal: 6,
    sendToAiExceptionRuleHit: 7,
  });
  for (const label of ['Раньше «Отправить в ИИ» → V2 «Отклонить»', 'Раньше «Отклонить» (без ИИ) → V2 «Отправить в ИИ»', 'Раньше «Обработано локально» → V2 «Отправить в ИИ»', 'Расхождение по чёрному списку', 'Нет сигнала белого списка', 'Нет сигнала о недвижимости', 'Сработало исключение «Отправить в ИИ»']) {
    assert.match(html, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('renderRuleHitAnalytics: an empty period shows a friendly empty state, not an empty table', () => {
  const html = shadowView.renderRuleHitAnalytics([]);
  assert.match(html, /срабатываний правил пока нет/);
});

test('renderRuleHitAnalytics: renders group/pattern/hit counts for real rows and documents the deferred AI-confirmed-buyer metric', () => {
  const html = shadowView.renderRuleHitAnalytics([
    { ruleId: '17', ruleGroup: 'WHITELIST', pattern: '\\bneed\\b', description: 'local-parser.js', hitCount: 12, oldSendToAiCount: 5, v2SendToAiCount: 12 },
  ]);
  // Settings UI simplification (2026-09-27): the friendly category title
  // ("Намерение купить") is now the primary label; the raw backend enum
  // ("WHITELIST") still appears, but only inside the Advanced disclosure.
  assert.match(html, /Намерение купить/);
  assert.match(html, />12</);
  assert.match(html, /отложено/i);
});

test('renderRuleHitAnalytics: raw pattern and backend group enum are still present, tucked inside an Advanced disclosure', () => {
  const html = shadowView.renderRuleHitAnalytics([
    { ruleId: '17', ruleGroup: 'WHITELIST', pattern: '\\bneed\\b', description: 'local-parser.js', hitCount: 12, oldSendToAiCount: 5, v2SendToAiCount: 12 },
  ]);
  assert.match(html, /<details>/);
  assert.match(html, /\\bneed\\b/);
  assert.match(html, /<code>WHITELIST<\/code>/);
});

test('renderRuleHitAnalytics: a pattern with no friendly-name mapping falls back to its description, then to the raw pattern -- never crashes or shows blank', () => {
  const html = shadowView.renderRuleHitAnalytics([
    { ruleId: '99', ruleGroup: 'PROPERTY_SIGNAL', pattern: '\\bunmapped-pattern\\b', description: null, hitCount: 1, oldSendToAiCount: 0, v2SendToAiCount: 1 },
  ]);
  assert.match(html, /\\bunmapped-pattern\\b/);
});
