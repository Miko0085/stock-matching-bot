'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const summaryView = require('../../dashboard/summary-view');

test('formatPct: null/undefined render as an em dash, never "NaN%"', () => {
  assert.equal(summaryView.formatPct(null), '—');
  assert.equal(summaryView.formatPct(undefined), '—');
  assert.equal(summaryView.formatPct(0.4), '40%');
  assert.equal(summaryView.formatPct(0), '0%');
  assert.equal(summaryView.formatPct(1), '100%');
});

test('renderRequestFlow: shows a PASS badge and includes every bucket when reconciled', () => {
  const html = summaryView.renderRequestFlow({
    processed: 10, duplicates: 3, rejected: 2, insufficientCriteria: 1, errors: 1,
    other: 0, matchEligible: 3, matched: 2, noMatch: 1, matchRate: 2 / 3, reconciled: true,
  });
  assert.match(html, /сверка: успешно/);
  assert.doesNotMatch(html, /сверка: ошибка/);
  assert.match(html, />10</);
  assert.match(html, /Готово к сопоставлению/);
});

test('renderRequestFlow: shows a FAIL badge when reconciled is false (never hides a real discrepancy)', () => {
  const html = summaryView.renderRequestFlow({
    processed: 10, duplicates: 3, rejected: 2, insufficientCriteria: 1, errors: 1,
    other: 0, matchEligible: 2, matched: 1, noMatch: 1, matchRate: 0.5, reconciled: false,
  });
  assert.match(html, /сверка: ошибка/);
});

test('renderRequestFlow: the Other row only appears when its count is greater than zero', () => {
  const withoutOther = summaryView.renderRequestFlow({
    processed: 5, duplicates: 5, rejected: 0, insufficientCriteria: 0, errors: 0,
    other: 0, matchEligible: 0, matched: 0, noMatch: 0, matchRate: null, reconciled: true,
  });
  assert.doesNotMatch(withoutOther, /Прочее \/ не классифицировано/);

  const withOther = summaryView.renderRequestFlow({
    processed: 6, duplicates: 5, rejected: 0, insufficientCriteria: 0, errors: 0,
    other: 1, matchEligible: 0, matched: 0, noMatch: 0, matchRate: null, reconciled: true,
  });
  assert.match(withOther, /Прочее \/ не классифицировано/);
});

test('renderExecutiveKpis: shows the current-matcher badge and the 5 required KPIs', () => {
  const html = summaryView.renderExecutiveKpis({
    activeStock: 94,
    requestFlow: { matchEligible: 10, matched: 4, matchRate: 0.4, errors: 1 },
  });
  assert.match(html, /lead-matching-service-v1/);
  assert.match(html, /Активные объекты/);
  assert.match(html, /Заявки, готовые к сопоставлению/);
  assert.match(html, /Заявки с совпадениями/);
  assert.match(html, /Доля совпадений/);
  assert.match(html, /Ошибки обработки/);
  assert.match(html, />40%</);
});

test('renderNoMatchReasons: renders reason/count/share rows and an empty state when there is nothing', () => {
  const html = summaryView.renderNoMatchReasons({
    total: 8,
    reasons: [
      { reason: 'location_not_found', count: 5, share: 0.625 },
      { reason: 'other', count: 3, share: 0.375 },
    ],
  });
  assert.match(html, /location_not_found/);
  assert.match(html, /63%|62%/); // Math.round(0.625*100) = 63
  assert.match(html, /other/);

  const empty = summaryView.renderNoMatchReasons({ total: 0, reasons: [] });
  assert.match(empty, /нет заявок без совпадений или отклонённых заявок/);
});

test('renderProviderBreakdown: renders one row per provider with independent match rates', () => {
  const html = summaryView.renderProviderBreakdown([
    { provider: 'telegram', processed: 10, matchEligible: 8, matched: 4, matchRate: 0.5 },
    { provider: 'whatsapp', processed: 5, matchEligible: 2, matched: 0, matchRate: 0 },
  ]);
  assert.match(html, /telegram/);
  assert.match(html, /whatsapp/);
  assert.match(html, />50%</);
  assert.match(html, />0%</);
});

test('renderInterpretation: shows the documented denominator note so the rate is never ambiguous', () => {
  const html = summaryView.renderInterpretation({
    triage: { PARSED_LOCALLY: 1, AI_REVIEW: 2, REJECT: 1 },
    triageTotal: 4,
    aiReviewRate: 0.5,
    interpretation: { local: 1, cache_local: 0, ai: 1, cache_ai: 1 },
    localTotal: 1,
    aiTotal: 2,
    cacheTotal: 1,
    interpretationTotal: 3,
    aiCacheHitRate: 1 / 3,
  });
  assert.match(html, /из 4 заявок, дошедших до предварительного отбора/);
  assert.match(html, /Доля проверок ИИ: 50%/);
});

test('periodProviderFilterForm: marks the current period/provider as selected', () => {
  const html = summaryView.periodProviderFilterForm({ period: '30d', provider: 'whatsapp' });
  assert.match(html, /<option value="30d" selected>/);
  assert.match(html, /<option value="whatsapp" selected>/);
});
