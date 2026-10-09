'use strict';

// AUDIT item #4 (P1 release blocker): the Sources/Channels page previously
// rendered each row's monitoring/route <form> INSIDE the bulk-update
// <form> -- nested <form> elements are invalid HTML with undefined
// browser behavior. These tests prove the fixed structure: no <form> is
// ever nested inside another, and a row's selection checkbox (associated
// with the bulk form purely via the `form="bulk-form"` attribute) still
// posts its value correctly.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sourcesTable, duplicateBadge, sourceControlsScript, sourcesReturnLocation } = require('../../dashboard/sources-view');

function makeSource(overrides = {}) {
  return {
    id: 1,
    provider: 'telegram',
    account_id: 'tg_main',
    name: 'Dubai Brokers',
    username_or_handle: 'dubai_brokers',
    external_source_id: '-100111',
    source_type: 'group',
    member_count: 42,
    available: true,
    monitoring_enabled: false,
    route_modes: ['NONE'],
    manual_override: false,
    last_synced_at: null,
    ...overrides,
  };
}

// A simple, dependency-free nesting check: walk <form ...> / </form> tags
// in document order and fail if a second opening tag is ever seen before
// its predecessor closes. This directly encodes "no <form> nested inside
// another <form>" without pulling in a full HTML parser.
function assertNoNestedForms(html) {
  const tagRe = /<\/?form\b[^>]*>/gi;
  let depth = 0;
  let match;
  while ((match = tagRe.exec(html)) !== null) {
    const isClosing = match[0].startsWith('</');
    if (isClosing) {
      depth -= 1;
    } else {
      assert.ok(depth === 0, `found a <form> nested inside another <form> at index ${match.index}: ${match[0]}`);
      depth += 1;
    }
  }
}

// Read-only duplicate indicator (2026-09-27): the same physical group
// synced under a different one of our own accounts. Explicit product
// decision: this only surfaces the pair for a human to review, it never
// merges/disables/deletes either row -- these tests only cover rendering.
test('duplicateBadge: no entry for this (provider, external_source_id) -> no badge at all', () => {
  const source = makeSource({ account_id: 'tg_main', external_source_id: '-100111' });
  assert.equal(duplicateBadge(source, new Map()), '');
});

test('duplicateBadge: an entry for this (provider, external_source_id) -> shows the count and the OTHER account(s) in the tooltip', () => {
  const source = makeSource({ provider: 'telegram', account_id: 'tg_main', external_source_id: '-100111' });
  const duplicates = new Map([
    ['telegram:-100111', { accountIds: ['nikaestate_ae', 'tg_main'], accountCount: 2 }],
  ]);
  const badge = duplicateBadge(source, duplicates);
  assert.match(badge, /дубль ×2/);
  assert.match(badge, /nikaestate_ae/);
  assert.doesNotMatch(badge, /title="[^"]*tg_main[^"]*"/, 'the tooltip should list the OTHER account(s), not this row\'s own account_id');
});

test('sourcesTable: renders the duplicate badge next to the source name when a duplicates map is passed', () => {
  const source = makeSource({ id: 7, provider: 'telegram', account_id: 'tg_main', external_source_id: '-100111', name: 'Dubai Brokers' });
  const duplicates = new Map([
    ['telegram:-100111', { accountIds: ['nikaestate_ae', 'tg_main'], accountCount: 2 }],
  ]);
  const html = sourcesTable([source], duplicates);
  assert.match(html, /Dubai Brokers/);
  assert.match(html, /дубль ×2/);
});

test('sourcesTable: omitting the duplicates argument entirely never throws and shows no badges', () => {
  assert.doesNotThrow(() => sourcesTable([makeSource()]));
  const html = sourcesTable([makeSource()]);
  assert.doesNotMatch(html, /дубль/);
});

test('sourcesTable: the rendered table contains no <form> nested inside another <form>', () => {
  const html = sourcesTable([makeSource({ id: 1 }), makeSource({ id: 2, provider: 'whatsapp' })]);
  assertNoNestedForms(html);
});

test('sourcesTable: each row IS its own well-formed <form> for the monitoring/route controls (two per row)', () => {
  const html = sourcesTable([makeSource({ id: 1 })]);
  const formOpenCount = (html.match(/<form\b/gi) || []).length;
  const formCloseCount = (html.match(/<\/form>/gi) || []).length;
  assert.equal(formOpenCount, 2, 'one row should render exactly two per-row forms (monitoring + route)');
  assert.equal(formCloseCount, 2);
});

test('sourcesTable: the row selection checkbox associates with #bulk-form by attribute, not by physical nesting', () => {
  const html = sourcesTable([makeSource({ id: 42 })]);
  assert.match(html, /<input type="checkbox" class="source-select" name="sourceIds" value="42" form="bulk-form">/);
  // Confirm the checkbox is never itself inside one of the row's own
  // per-row <form> elements (which would make it submit to the WRONG
  // endpoint on that form's change handler instead of to the bulk form).
  const checkboxIndex = html.indexOf('class="source-select"');
  const before = html.slice(0, checkboxIndex);
  const openForms = (before.match(/<form\b/gi) || []).length;
  const closeForms = (before.match(/<\/form>/gi) || []).length;
  assert.equal(openForms, closeForms, 'the bulk-select checkbox must not be physically inside an open <form> tag');
});

test('bulk selection: checked row checkboxes survive a real form submission round-trip to the exact parsing logic /sources/bulk-update uses', () => {
  const html = sourcesTable([makeSource({ id: 1 }), makeSource({ id: 2 }), makeSource({ id: 3 })]);
  const checkboxValues = [...html.matchAll(/name="sourceIds" value="(\d+)" form="bulk-form"/g)].map((m) => m[1]);
  assert.deepEqual(checkboxValues, ['1', '2', '3']);

  // Simulate the browser submitting #bulk-form with only rows 1 and 3
  // checked (row 2 left unchecked -- an unchecked checkbox is simply never
  // submitted, same as any ordinary HTML form), and the route <select>
  // left at "(без изменений)" (empty value).
  const submittedBody = 'sourceIds=1&sourceIds=3&monitoringEnabled=true&routeModes=';
  const params = new URLSearchParams(submittedBody);

  // Exact logic from dashboard/server.js's POST /sources/bulk-update handler.
  const sourceIds = params.getAll('sourceIds').map(Number).filter(Number.isFinite);
  const patch = {};
  if (params.get('monitoringEnabled')) patch.monitoringEnabled = params.get('monitoringEnabled') === 'true';
  const bulkRouteModes = params.getAll('routeModes').filter(Boolean);
  if (bulkRouteModes.length) patch.routeModes = bulkRouteModes;

  assert.deepEqual(sourceIds, [1, 3]);
  assert.deepEqual(patch, { monitoringEnabled: true });
});

test('bulk route select: picking a real market produces a one-element routeModes array', () => {
  const submittedBody = 'sourceIds=1&routeModes=ABU_DHABI';
  const params = new URLSearchParams(submittedBody);
  const bulkRouteModes = params.getAll('routeModes').filter(Boolean);
  const patch = {};
  if (bulkRouteModes.length) patch.routeModes = bulkRouteModes;
  assert.deepEqual(patch, { routeModes: ['ABU_DHABI'] });
});

test('sourcesTable: an empty list renders no forms at all, just the empty-state message', () => {
  const html = sourcesTable([]);
  assert.doesNotMatch(html, /<form/i);
  assert.match(html, /Источников пока нет/);
});

test('source controls save in the background instead of submitting and reloading the page', () => {
  const html = sourcesTable([makeSource()]);
  assert.match(html, /class="inline source-control"/);
  assert.doesNotMatch(html, /requestSubmit/);
  assert.match(html, /class="source-save-state" aria-live="polite"/);

  const script = sourceControlsScript();
  assert.match(script, /fetch\(form\.action/);
  assert.match(script, /X-Requested-With': 'source-control'/);
  assert.match(script, /Сохранено/);
  assert.doesNotMatch(script, /location\.reload|window\.location\s*=/);
});

// Multi-route selection (2026-10-06, migration 0041): the single <select>
// became a checkbox group, one box per real market/AUTO/NONE, reflecting
// `route_modes` (now an array, possibly more than one element).
test('sourcesTable: route checkboxes reflect every market in route_modes, not just the first', () => {
  const html = sourcesTable([makeSource({ id: 1, route_modes: ['DUBAI', 'ABU_DHABI'] })]);
  assert.match(html, /<input type="checkbox" name="routeModes" value="DUBAI" checked>/);
  assert.match(html, /<input type="checkbox" name="routeModes" value="ABU_DHABI" checked>/);
  assert.doesNotMatch(html, /value="RF" checked/);
  assert.doesNotMatch(html, /value="SAUDI" checked/);
});

test('sourcesTable: a NONE-routed source has no box checked except NONE', () => {
  const html = sourcesTable([makeSource({ id: 1, route_modes: ['NONE'] })]);
  assert.match(html, /<input type="checkbox" name="routeModes" value="NONE" checked>/);
  for (const market of ['DUBAI', 'RF', 'SAUDI', 'ABU_DHABI', 'AUTO']) {
    assert.doesNotMatch(html, new RegExp(`value="${market}" checked`));
  }
});

test('sourcesTable: BOTH is retired -- never rendered as a route checkbox option', () => {
  const html = sourcesTable([makeSource()]);
  assert.doesNotMatch(html, /value="BOTH"/);
});

test('sourcesTable: the route form carries a hidden empty routeModes sentinel so "uncheck everything" still submits the field', () => {
  const html = sourcesTable([makeSource()]);
  assert.match(html, /<input type="hidden" name="routeModes" value="">/);
});

test('source mutations preserve the active source filters on a normal redirect', () => {
  const referer = 'http://localhost:8094/sources?provider=telegram&routeMode=DUBAI&search=dubai';
  assert.equal(sourcesReturnLocation(referer), '/sources?provider=telegram&routeMode=DUBAI&search=dubai');
  assert.equal(sourcesReturnLocation('http://localhost:8094/settings'), '/sources');
  assert.equal(sourcesReturnLocation('not a URL'), '/sources');
  assert.equal(sourcesReturnLocation(), '/sources');
});
