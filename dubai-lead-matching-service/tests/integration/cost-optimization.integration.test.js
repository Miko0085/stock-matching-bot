'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const eventDedupRepo = require('../../src/repositories/event-dedup-repository');
const interpretationCacheRepo = require('../../src/repositories/interpretation-cache-repository');

let pool;

before(() => {
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
});

after(async () => {
  await pool.query(`DELETE FROM matching_dubai.processed_events WHERE event_key LIKE 'lms-cost-it:%'`);
  await pool.query(`DELETE FROM matching_dubai.message_interpretation_cache WHERE text_hash LIKE 'lms-cost-it-%'`);
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM matching_dubai.processed_events WHERE event_key LIKE 'lms-cost-it:%'`);
  await pool.query(`DELETE FROM matching_dubai.message_interpretation_cache WHERE text_hash LIKE 'lms-cost-it-%'`);
});

test('recordEventIfNew: first insert is new, an identical event_key afterward is a duplicate', async () => {
  const first = await eventDedupRepo.recordEventIfNew(pool, {
    eventKey: 'lms-cost-it:telegram:acc1:-100:1', provider: 'telegram', accountId: 'acc1', chatId: '-100', messageId: '1',
  });
  const second = await eventDedupRepo.recordEventIfNew(pool, {
    eventKey: 'lms-cost-it:telegram:acc1:-100:1', provider: 'telegram', accountId: 'acc1', chatId: '-100', messageId: '1',
  });
  assert.equal(first.isNew, true);
  assert.equal(second.isNew, false);
});

test('recordEventIfNew: concurrent identical inserts -- exactly one wins (no race duplicate)', async () => {
  const args = { eventKey: 'lms-cost-it:telegram:acc1:-100:race', provider: 'telegram', accountId: 'acc1', chatId: '-100', messageId: 'race' };
  const [a, b] = await Promise.all([
    eventDedupRepo.recordEventIfNew(pool, args),
    eventDedupRepo.recordEventIfNew(pool, args),
  ]);
  const newCount = [a.isNew, b.isNew].filter(Boolean).length;
  assert.equal(newCount, 1);
});

test('P0.3 RELEASE BLOCKER: a completed event can never be reclaimed (retry after success is a true duplicate)', async () => {
  const args = { eventKey: 'lms-cost-it:telegram:acc1:-100:completed', provider: 'telegram', accountId: 'acc1', chatId: '-100', messageId: 'completed' };
  const first = await eventDedupRepo.claimEvent(pool, args);
  assert.equal(first.claimed, true);
  await eventDedupRepo.completeEvent(pool, args.eventKey);

  const retry = await eventDedupRepo.claimEvent(pool, args);
  assert.equal(retry.claimed, false);
  assert.equal(retry.reason, 'completed');
});

test('P0.3 RELEASE BLOCKER: a FAILED_RETRYABLE event (crash/timeout mid-processing) can be reclaimed on the next delivery', async () => {
  const args = { eventKey: 'lms-cost-it:telegram:acc1:-100:crashed', provider: 'telegram', accountId: 'acc1', chatId: '-100', messageId: 'crashed' };
  const first = await eventDedupRepo.claimEvent(pool, args);
  assert.equal(first.claimed, true);

  // Simulates the process crashing/erroring before completeEvent() ever ran.
  await eventDedupRepo.failEvent(pool, args.eventKey);

  const retry = await eventDedupRepo.claimEvent(pool, args);
  assert.equal(retry.claimed, true, 'a failed attempt must never permanently consume the event');
  assert.equal(retry.attempts, 2);
});

test('P0.3 RELEASE BLOCKER: a stale PROCESSING claim (process died, no failEvent ever ran) is reclaimable once its lease expires', async () => {
  const eventKey = 'lms-cost-it:telegram:acc1:-100:stale-lease';
  // Simulate a claim whose lease already expired in the past -- inserted
  // directly since a real claim always sets a future lease.
  await pool.query(
    `INSERT INTO matching_dubai.processed_events (event_key, provider, account_id, chat_id, message_id, status, lease_expires_at, attempts)
     VALUES ($1, 'telegram', 'acc1', '-100', 'stale-lease', 'PROCESSING', now() - interval '10 minutes', 1)`,
    [eventKey]
  );

  const reclaim = await eventDedupRepo.claimEvent(pool, { eventKey, provider: 'telegram', accountId: 'acc1', chatId: '-100', messageId: 'stale-lease' });
  assert.equal(reclaim.claimed, true, 'an expired lease from a dead process must be reclaimable, not a permanent lock');
});

test('P0.3 RELEASE BLOCKER: two concurrent claims for the same event -- exactly one wins, the other sees it as leased', async () => {
  const args = { eventKey: 'lms-cost-it:telegram:acc1:-100:concurrent', provider: 'telegram', accountId: 'acc1', chatId: '-100', messageId: 'concurrent' };
  const [a, b] = await Promise.all([eventDedupRepo.claimEvent(pool, args), eventDedupRepo.claimEvent(pool, args)]);
  const claimedCount = [a.claimed, b.claimed].filter(Boolean).length;
  assert.equal(claimedCount, 1);
});

test('interpretation cache: a fresh (text_hash, interpreter_version) pair is a miss, then a hit after recording', async () => {
  const miss = await interpretationCacheRepo.findInterpretation(pool, {
    textHash: 'lms-cost-it-hash-1', interpreterVersion: 'v1', ttlDays: 14,
  });
  assert.equal(miss, null);

  await interpretationCacheRepo.recordInterpretation(pool, {
    textHash: 'lms-cost-it-hash-1',
    interpreterVersion: 'v1',
    normalizedText: 'need 2br business bay',
    interpretationSource: 'local',
    messageClass: 'buyer_request',
    demandOwner: 'sender',
    promotion: false,
    spam: false,
    parsedRequest: { area: 'Business Bay', bedrooms_min: 2 },
  });

  const hit = await interpretationCacheRepo.findInterpretation(pool, {
    textHash: 'lms-cost-it-hash-1', interpreterVersion: 'v1', ttlDays: 14,
  });
  assert.ok(hit);
  assert.equal(hit.interpretation_source, 'local');
  assert.equal(hit.message_class, 'buyer_request');
  assert.equal(hit.parsed_request.area, 'Business Bay');
});

test('interpretation cache: bumping interpreter_version invalidates the old cached entry (a lookup for the new version is a miss)', async () => {
  await interpretationCacheRepo.recordInterpretation(pool, {
    textHash: 'lms-cost-it-hash-2',
    interpreterVersion: 'v1',
    normalizedText: 'text',
    interpretationSource: 'ai',
    messageClass: 'buyer_request',
    demandOwner: 'sender',
    promotion: false,
    spam: false,
    parsedRequest: {},
  });

  const missOnNewVersion = await interpretationCacheRepo.findInterpretation(pool, {
    textHash: 'lms-cost-it-hash-2', interpreterVersion: 'v2', ttlDays: 14,
  });
  assert.equal(missOnNewVersion, null);
});

test('interpretation cache: an entry older than the TTL is treated as a miss', async () => {
  await pool.query(
    `INSERT INTO matching_dubai.message_interpretation_cache
       (text_hash, interpreter_version, normalized_text, interpretation_source, message_class, demand_owner, promotion, spam, parsed_request, last_seen_at)
     VALUES ('lms-cost-it-hash-3', 'v1', 'old text', 'ai', 'buyer_request', 'sender', false, false, '{}'::jsonb, now() - interval '30 days')`
  );

  const result = await interpretationCacheRepo.findInterpretation(pool, {
    textHash: 'lms-cost-it-hash-3', interpreterVersion: 'v1', ttlDays: 14,
  });
  assert.equal(result, null);
});
