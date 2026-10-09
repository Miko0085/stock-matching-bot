'use strict';

const crypto = require('crypto');

const DEFAULT_TTL_MINUTES = 30;

// Single-use, expiring connection token for the
// https://t.me/<bot>?start=<connection_token> handshake
// (docs/TELEGRAM_BOT_AND_USER_MANAGEMENT.md). Pure/testable: does not touch
// the database itself — the caller persists { token, expiresAt } onto a
// pending matching_dubai.broker_telegram_accounts row and later resolves it
// against the bot's /start webhook payload via resolveConnectionToken().
function generateConnectionToken({ now = new Date(), ttlMinutes = DEFAULT_TTL_MINUTES } = {}) {
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);
  return { token, expiresAt };
}

// Given the set of pending/connected broker_telegram_accounts rows and the
// token presented in a /start payload, finds the one row it resolves to (or
// null). A token is single-use: once a row has already been verified
// (is_verified true), presenting its token again must not re-resolve —
// callers should generate a fresh token for reconnects (see
// generateConnectionToken above), not reuse an old one.
function resolveConnectionToken(accounts, presentedToken, now = new Date()) {
  if (!presentedToken) return null;
  const match = accounts.find((a) => a.connection_token === presentedToken);
  if (!match) return null;
  if (match.is_verified) return null; // already consumed
  if (!match.connection_token_expires_at) return null;
  if (new Date(match.connection_token_expires_at).getTime() < now.getTime()) return null;
  return match;
}

module.exports = { DEFAULT_TTL_MINUTES, generateConnectionToken, resolveConnectionToken };
