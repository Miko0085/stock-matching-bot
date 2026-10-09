'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeText,
  normalizeAliasKey,
  normalizeBedrooms,
  bedroomsLabel,
} = require('../../src/core/normalize');

test('normalizeText lowercases, trims, and collapses whitespace', () => {
  assert.equal(normalizeText('  Business   Bay  '), 'business bay');
  assert.equal(normalizeText('BB'), 'bb');
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeText(undefined), '');
});

test('normalizeAliasKey strips dots, dashes, and underscores', () => {
  assert.equal(normalizeAliasKey('M.J.L'), 'mjl');
  assert.equal(normalizeAliasKey('M-J-L'), 'mjl');
  assert.equal(normalizeAliasKey('m_j_l'), 'mjl');
  assert.equal(normalizeAliasKey('P4'), 'p4');
  assert.equal(normalizeAliasKey('  Business Bay '), 'businessbay');
});

test('normalizeBedrooms handles numbers, studio, and text', () => {
  assert.equal(normalizeBedrooms(2), 2);
  assert.equal(normalizeBedrooms('2'), 2);
  assert.equal(normalizeBedrooms('Studio'), 0);
  assert.equal(normalizeBedrooms('STUDIO'), 0);
  assert.equal(normalizeBedrooms(0), 0);
  assert.equal(normalizeBedrooms(null), null);
  assert.equal(normalizeBedrooms(''), null);
  assert.equal(normalizeBedrooms('unknown'), null);
});

test('bedroomsLabel formats studio and numeric bedrooms', () => {
  assert.equal(bedroomsLabel(0), 'Studio');
  assert.equal(bedroomsLabel(2), '2 BR');
  assert.equal(bedroomsLabel(null), null);
});
