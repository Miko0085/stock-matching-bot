'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhoneDigits } = require('../../src/core/phone-normalize');

test('strips spaces and plus sign to bare digits', () => {
  assert.equal(normalizePhoneDigits('+971 50 687 3050'), '971506873050');
});

test('a already-bare-digits number is unchanged', () => {
  assert.equal(normalizePhoneDigits('+971522245787'), '971522245787');
});

test('two differently-formatted strings for the same phone normalize identically', () => {
  assert.equal(normalizePhoneDigits('+971 50 687 3050'), normalizePhoneDigits('971506873050'));
});

test('a wa.me URL is reduced to its digits', () => {
  assert.equal(normalizePhoneDigits('https://wa.me/971503611218'), '971503611218');
});

test('a display name with no digits at all normalizes to null', () => {
  assert.equal(normalizePhoneDigits('Pavel Goss'), null);
});

test('null/undefined/empty input never throws, yields null', () => {
  assert.equal(normalizePhoneDigits(null), null);
  assert.equal(normalizePhoneDigits(undefined), null);
  assert.equal(normalizePhoneDigits(''), null);
});

test('a name that happens to contain a digit does not pass through as a phone', () => {
  // Deliberately NOT a phone-shape assertion here -- normalizePhoneDigits
  // itself only strips non-digits, so "Room 50" -> "50". Callers needing a
  // minimum-length/phone-shape check (e.g. resolveBrokerContact-style logic)
  // must apply that separately; this function's only job is normalization.
  assert.equal(normalizePhoneDigits('Room 50'), '50');
});
