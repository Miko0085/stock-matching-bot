'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { groupStockContactsByPhone, chooseDisplayName } = require('../../src/core/broker-backfill');

test('groupStockContactsByPhone: groups two differently-formatted contacts for the same phone into one group', () => {
  const rows = [
    { stock_id: 'A1', broker: 'Pavel Goss', broker_contact: '+971 50 687 3050' },
    { stock_id: 'A2', broker: 'Павел Nika Estate', broker_contact: '971506873050' },
  ];
  const { groups, skipped } = groupStockContactsByPhone(rows);
  assert.equal(groups.length, 1);
  assert.equal(skipped.length, 0);
  assert.deepEqual(groups[0].stockIds.sort(), ['A1', 'A2']);
  assert.deepEqual(Array.from(groups[0].names).sort(), ['Pavel Goss', 'Павел Nika Estate']);
});

test('groupStockContactsByPhone: distinct phones land in separate groups', () => {
  const rows = [
    { stock_id: 'A1', broker: 'Anna', broker_contact: '+971501111111' },
    { stock_id: 'A2', broker: 'Boris', broker_contact: '+971502222222' },
  ];
  const { groups } = groupStockContactsByPhone(rows);
  assert.equal(groups.length, 2);
});

test('groupStockContactsByPhone: a bare-phone-as-broker-name row still contributes its name to the set', () => {
  const rows = [{ stock_id: 'A1', broker: '+971 55 183 9209', broker_contact: '+7 922 294 9983' }];
  const { groups } = groupStockContactsByPhone(rows);
  assert.equal(groups.length, 1);
  assert.deepEqual(Array.from(groups[0].names), ['+971 55 183 9209']);
});

test('groupStockContactsByPhone: a row with no digits in broker_contact is skipped, never grouped', () => {
  const rows = [{ stock_id: 'A1', broker: 'Anna', broker_contact: 'n/a' }];
  const { groups, skipped } = groupStockContactsByPhone(rows);
  assert.equal(groups.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].stock_id, 'A1');
});

test('groupStockContactsByPhone: an empty/null broker name is never added to the names set', () => {
  const rows = [
    { stock_id: 'A1', broker: '', broker_contact: '+971501111111' },
    { stock_id: 'A2', broker: null, broker_contact: '+971501111111' },
  ];
  const { groups } = groupStockContactsByPhone(rows);
  assert.equal(groups[0].names.size, 0);
});

test('chooseDisplayName: prefers a real name over a bare-phone-number name', () => {
  const name = chooseDisplayName(new Set(['+971 55 183 9209', 'Ева Новикова Nika РФ']));
  assert.equal(name, 'Ева Новикова Nika РФ');
});

test('chooseDisplayName: with two real names, picks the longer as the deterministic tie-break', () => {
  const name = chooseDisplayName(new Set(['Pavel Goss', 'Павел Nika Estate']));
  assert.equal(name, 'Павел Nika Estate');
});

test('chooseDisplayName: every name is a bare phone -- falls back to one of them rather than null', () => {
  const name = chooseDisplayName(new Set(['+971501111111']));
  assert.equal(name, '+971501111111');
});

test('chooseDisplayName: an empty set returns null, never throws', () => {
  assert.equal(chooseDisplayName(new Set()), null);
});
