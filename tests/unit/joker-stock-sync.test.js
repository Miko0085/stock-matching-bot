'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { syncAllMarkets } = require('../../src/joker/joker-stock-sync');

function makeFakeRepo() {
  const stock = new Map(); // schema -> Map(joker_object_id -> row)
  const runs = []; // { schema, status, ... }

  function tableFor(schema) {
    if (!stock.has(schema)) stock.set(schema, new Map());
    return stock.get(schema);
  }

  return {
    stock,
    runs,
    async startSyncRun(pool, schema) {
      const id = runs.length + 1;
      runs.push({ id, schema, status: 'RUNNING' });
      return id;
    },
    async completeSyncRun(pool, schema, runId, summary) {
      Object.assign(runs[runId - 1], { status: 'SUCCESS', ...summary });
    },
    async failSyncRun(pool, schema, runId, err) {
      Object.assign(runs[runId - 1], { status: 'FAILED', error: String(err && err.message ? err.message : err) });
    },
    async upsertStockRow(pool, schema, row) {
      const table = tableFor(schema);
      const inserted = !table.has(row.jokerObjectId);
      table.set(row.jokerObjectId, { ...row, available: true });
      return { id: row.jokerObjectId, inserted };
    },
    async markMissingUnavailable(pool, schema, seenIds) {
      const table = tableFor(schema);
      let count = 0;
      for (const [id, row] of table.entries()) {
        if (row.available && !seenIds.includes(id)) {
          row.available = false;
          count += 1;
        }
      }
      return count;
    },
  };
}

function fakeObject({ id, region, type = 'Квартиры - вторичное жильё', agentId = 1 }) {
  return {
    id,
    url: `https://moscow.nikaestate.ru/catalog/sale/vtorichka/object/${id}`,
    type,
    deal_type: 'sale',
    region,
    city: 'Москва',
    district: null,
    microdistrict: null,
    price: '10000000',
    development: null,
    complex: null,
    agent: { id: agentId, name: 'Agent', phone: null, email: null },
    params: {},
  };
}

function makePager(pages) {
  // pages: array of arrays of objects, one per "page" of PAGE_LIMIT-sized calls.
  return async ({ offset }) => {
    const pageIndex = offset / 200;
    const objects = pages[pageIndex] || [];
    return { ok: true, data: objects };
  };
}

test('syncAllMarkets: routes objects to the correct market by region, skips UAE and no-region entirely', () => {
  const repo = makeFakeRepo();
  const objects = [
    fakeObject({ id: 1, region: 'Москва' }),
    fakeObject({ id: 2, region: 'Турция' }),
    fakeObject({ id: 3, region: 'ОАЭ' }),
    fakeObject({ id: 4, region: null }),
  ];
  return syncAllMarkets({}, { listObjectsPage: makePager([objects]), repo }).then((result) => {
    assert.equal(result.totalScanned, 4);
    assert.equal(result.totalSkipped, 2, 'ОАЭ (deliberate) and no-region (out of scope, never assumed Moscow)');
    assert.deepEqual(result.skippedBreakdown, { dubai_deliberate_skip: 1, out_of_moscow_scope: 0, no_region: 1 });
    assert.equal(result.upsertedCounts.moscow, 1); // only id 1 (exact region "Москва")
    assert.equal(result.upsertedCounts.turkey, 1);
    assert.equal(result.upsertedCounts.oman, 0);
    assert.equal(result.upsertedCounts.saudi, 0);
    assert.ok(repo.stock.get('matching_moscow').has(1));
    assert.ok(!repo.stock.get('matching_moscow').has(4), 'a null-region object is never absorbed into moscow');
    assert.ok(repo.stock.get('matching_turkey').has(2));
    assert.equal(repo.stock.get('matching_oman').size, 0, 'no object routed to oman, so nothing was ever upserted there');
  });
});

test('syncAllMarkets: STRICT scope -- Moscow OBLAST (not the city) and other real regions are skipped, never absorbed into moscow', async () => {
  const repo = makeFakeRepo();
  const objects = [
    fakeObject({ id: 10, region: 'Москва' }),
    fakeObject({ id: 11, region: 'Московская область' }),
    fakeObject({ id: 12, region: 'Санкт-Петербург' }),
    fakeObject({ id: 13, region: 'Узбекистан' }),
  ];
  const result = await syncAllMarkets({}, { listObjectsPage: makePager([objects]), repo });
  assert.equal(result.upsertedCounts.moscow, 1);
  assert.equal(result.totalSkipped, 3);
  assert.equal(result.skippedBreakdown.out_of_moscow_scope, 3);
  assert.ok(repo.stock.get('matching_moscow').has(10));
  assert.ok(!repo.stock.get('matching_moscow').has(11), 'Moscow OBLAST is not the city -- out of scope');
  assert.ok(!repo.stock.get('matching_moscow').has(12));
  assert.ok(!repo.stock.get('matching_moscow').has(13));
});

test('syncAllMarkets: paginates across multiple pages until an empty page is returned', async () => {
  const repo = makeFakeRepo();
  const page1 = Array.from({ length: 200 }, (_, i) => fakeObject({ id: i + 1, region: 'Москва' }));
  const page2 = [fakeObject({ id: 201, region: 'Москва' })];
  const result = await syncAllMarkets({}, { listObjectsPage: makePager([page1, page2]), repo });
  assert.equal(result.totalScanned, 201);
  assert.equal(result.upsertedCounts.moscow, 201);
});

test('syncAllMarkets: a previously-synced object missing from this run is marked unavailable, never deleted', async () => {
  const repo = makeFakeRepo();
  await syncAllMarkets({}, { listObjectsPage: makePager([[fakeObject({ id: 1, region: 'Москва' }), fakeObject({ id: 2, region: 'Москва' })]]), repo });
  const result = await syncAllMarkets({}, { listObjectsPage: makePager([[fakeObject({ id: 1, region: 'Москва' })]]), repo });

  assert.equal(result.markedUnavailable.moscow, 1);
  assert.equal(repo.stock.get('matching_moscow').get(1).available, true);
  assert.equal(repo.stock.get('matching_moscow').get(2).available, false, 'never deleted, only marked unavailable');
});

test('syncAllMarkets: a region that has fallen out of scope (e.g. previously synced, now excluded) is marked unavailable, never deleted', async () => {
  const repo = makeFakeRepo();
  // Simulate a row that was synced under the old broad catch-all (still present in the fake table)
  // but whose region is no longer in scope under the strict router -- the NEXT sync simply never
  // "sees" it again, so it must be marked unavailable exactly like any other missing row.
  await syncAllMarkets({}, { listObjectsPage: makePager([[fakeObject({ id: 5, region: 'Москва' })]]), repo });
  repo.stock.get('matching_moscow').set(999, { available: true }); // pre-existing out-of-scope row
  const result = await syncAllMarkets({}, { listObjectsPage: makePager([[fakeObject({ id: 5, region: 'Москва' })]]), repo });
  assert.equal(result.markedUnavailable.moscow, 1);
  assert.equal(repo.stock.get('matching_moscow').get(999).available, false);
});

test('syncAllMarkets: dry run scans and counts but calls no write functions at all', async () => {
  const repo = makeFakeRepo();
  let writeCalls = 0;
  const trackedRepo = new Proxy(repo, {
    get(target, prop) {
      if (['upsertStockRow', 'markMissingUnavailable', 'startSyncRun', 'completeSyncRun', 'failSyncRun'].includes(prop)) {
        return async (...args) => { writeCalls += 1; return target[prop](...args); };
      }
      return target[prop];
    },
  });
  const result = await syncAllMarkets({}, { listObjectsPage: makePager([[fakeObject({ id: 1, region: 'Москва' })]]), repo: trackedRepo, dryRun: true });
  assert.equal(writeCalls, 0, 'dry run must never call any write function');
  assert.equal(result.dryRun, true);
  assert.equal(result.upsertedCounts.moscow, 1, 'counts are still reported for review');
});

test('syncAllMarkets: a fetch failure marks all in-progress sync runs as FAILED and rethrows', async () => {
  const repo = makeFakeRepo();
  const failingPager = async () => ({ ok: false, error: 'Joker 504' });
  await assert.rejects(
    () => syncAllMarkets({}, { listObjectsPage: failingPager, repo }),
    /Joker 504/
  );
  assert.ok(repo.runs.every((r) => r.status === 'FAILED'));
  assert.equal(repo.runs.length, 4, 'one run per market schema, all started before the fetch failed');
});

test('syncAllMarkets: an empty first page (nothing in the catalog) completes cleanly with all-zero counts', async () => {
  const repo = makeFakeRepo();
  const result = await syncAllMarkets({}, { listObjectsPage: makePager([[]]), repo });
  assert.equal(result.totalScanned, 0);
  for (const market of ['moscow', 'oman', 'saudi', 'turkey']) {
    assert.equal(result.upsertedCounts[market], 0);
  }
});
