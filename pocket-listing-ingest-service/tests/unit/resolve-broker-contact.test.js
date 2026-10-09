'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveBrokerContact } = require('../../src/normalize/resolve-broker-contact');

test('resolveBrokerContact: a plain phone-number sender_id (no @lid) is used directly', () => {
  assert.equal(resolveBrokerContact('971501234567@s.whatsapp.net', null), 'https://wa.me/971501234567');
});

test('resolveBrokerContact: sender_id is a LID but sender_id_alt resolves to a real phone -- prefers the resolved alt', () => {
  assert.equal(resolveBrokerContact('65842268078304@lid', '971501234567@s.whatsapp.net'), 'https://wa.me/971501234567');
});

test('resolveBrokerContact: an unresolved LID with no alt phone number yields no contact -- never a placeholder', () => {
  assert.equal(resolveBrokerContact('65842268078304@lid', null), null);
  assert.equal(resolveBrokerContact('65842268078304@lid', undefined), null);
});

test('resolveBrokerContact: a LID-shaped sender_id_alt is never mistaken for a phone number, even though it is all digits', () => {
  assert.equal(resolveBrokerContact(null, '65842268078304@lid'), null);
});

test('resolveBrokerContact: both missing yields null', () => {
  assert.equal(resolveBrokerContact(null, null), null);
  assert.equal(resolveBrokerContact(undefined, undefined), null);
});

test('resolveBrokerContact: a too-short numeric id is never treated as a phone number', () => {
  assert.equal(resolveBrokerContact('12345@s.whatsapp.net', null), null);
});
