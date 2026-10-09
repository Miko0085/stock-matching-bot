'use strict';

// Thin read-only client for telegram-worker / whatsapp-worker status. The
// API key never reaches the browser — the dashboard server calls these
// worker endpoints itself and only renders the results.

const fs = require('fs/promises');
const path = require('path');

const TELEGRAM_WORKER_URL = process.env.TELEGRAM_WORKER_URL || 'http://localhost:8091';
const WHATSAPP_WORKER_URL = process.env.WHATSAPP_WORKER_URL || 'http://localhost:8092';
const WORKER_API_KEY = process.env.WORKER_API_KEY || '';
// pocket-listing-ingest-service (ADR-050) -- a separate, independent
// service, not one of the lead-matching contours, so it gets its own base
// URL here rather than living in dashboard/queries.js's MARKETS map.
const POCKET_LISTING_INGEST_URL = process.env.POCKET_LISTING_INGEST_URL || 'http://localhost:8098';

// whatsapp-worker runs as a separate local Docker container that bind-mounts
// ../whatsapp-worker/sessions from the repo root (see docker-compose.yml one
// level up) — deleting a session dir here is visible to the container
// immediately, no restart needed.
const WHATSAPP_SESSIONS_DIR =
  process.env.WHATSAPP_SESSIONS_DIR || path.resolve(__dirname, '../../whatsapp-worker/sessions');
const SAFE_ACCOUNT_ID = /^[A-Za-z0-9_-]+$/;

async function fetchJson(url, { method = 'GET', body, timeoutMs = 5000, auth = true } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(auth ? { 'X-API-Key': WORKER_API_KEY } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      return { ok: false, error: (json && json.error) || res.statusText, status: res.status };
    }
    return { ok: true, data: json };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'превышено время ожидания' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function getTelegramStatus() {
  const health = await fetchJson(`${TELEGRAM_WORKER_URL}/health`, { auth: false });
  const accounts = await fetchJson(`${TELEGRAM_WORKER_URL}/telegram/accounts`);
  const destinations = await fetchJson(`${TELEGRAM_WORKER_URL}/telegram/destinations`);
  return {
    reachable: health.ok,
    health: health.ok ? health.data : null,
    error: health.ok ? null : health.error,
    accounts: accounts.ok ? accounts.data.accounts || [] : [],
    accountsError: accounts.ok ? null : accounts.error,
    destinationCount: destinations.ok ? destinations.data.count ?? null : null,
    destinations: destinations.ok ? destinations.data.dialogs || [] : [],
  };
}

async function getWhatsappStatus() {
  const health = await fetchJson(`${WHATSAPP_WORKER_URL}/health`, { auth: false });
  const accounts = await fetchJson(`${WHATSAPP_WORKER_URL}/whatsapp/accounts`);
  return {
    reachable: health.ok,
    health: health.ok ? health.data : null,
    error: health.ok ? null : health.error,
    accounts: accounts.ok ? accounts.data.accounts || [] : [],
    accountsError: accounts.ok ? null : accounts.error,
  };
}

// Just the connected-accounts list, for populating a WhatsApp-sending-
// account dropdown (e.g. the /notifications per-broker routes panel) --
// thin reuse of the same endpoint getWhatsappStatus() already calls.
async function listWhatsappAccounts() {
  const result = await fetchJson(`${WHATSAPP_WORKER_URL}/whatsapp/accounts`);
  return result.ok ? result.data.accounts || [] : [];
}

async function getWhatsappQr(accountId) {
  return fetchJson(`${WHATSAPP_WORKER_URL}/whatsapp/qr?account_id=${encodeURIComponent(accountId)}`);
}

async function getWhatsappGroups(accountId) {
  return fetchJson(`${WHATSAPP_WORKER_URL}/whatsapp/groups?account_id=${encodeURIComponent(accountId)}`);
}

// Per-account dialogs -- used by the Sources sync (source-sync.js expects
// a plain { dialogs: [...] } body, exactly what this endpoint returns).
async function getTelegramDialogsForAccount(accountId) {
  return fetchJson(`${TELEGRAM_WORKER_URL}/telegram/dialogs?account_id=${encodeURIComponent(accountId)}&limit=2000`);
}

async function reconnectWhatsapp(accountId) {
  return fetchJson(`${WHATSAPP_WORKER_URL}/whatsapp/accounts`, { method: 'POST', body: { account_id: accountId } });
}

// Same worker endpoint as reconnectWhatsapp() — POST /whatsapp/accounts
// already handles a brand-new account_id (it creates the entry and starts
// QR pairing), so "connect a new account" and "reconnect an existing one"
// are deliberately the same call. Kept as a separate export only so the
// dashboard's Add/Connect Account UI can call it under its own name.
async function connectWhatsapp(accountId) {
  return reconnectWhatsapp(accountId);
}

// Logs out on WhatsApp's side (unlinks the device) without touching the
// dashboard's own channels/routing/monitoring/match-history data — the
// worker has no DB access at all. Distinct from clearWhatsappSession()
// below, which deletes local session files and is only ever used after a
// logout already happened on WhatsApp's side.
async function logoutWhatsapp(accountId) {
  return fetchJson(`${WHATSAPP_WORKER_URL}/whatsapp/accounts/logout`, { method: 'POST', body: { account_id: accountId } });
}

// Pause/resume: stops/resumes event PROCESSING for this account without
// touching its connection/session at all -- distinct from logout. Effective
// immediately, persisted worker-side, survives a worker restart.
async function pauseWhatsapp(accountId) {
  return fetchJson(`${WHATSAPP_WORKER_URL}/whatsapp/accounts/pause`, { method: 'POST', body: { account_id: accountId } });
}

async function resumeWhatsapp(accountId) {
  return fetchJson(`${WHATSAPP_WORKER_URL}/whatsapp/accounts/resume`, { method: 'POST', body: { account_id: accountId } });
}

// ------------------------------------------------------------
// Telegram QR login (mirrors the WhatsApp connect/qr/logout shape above)
// ------------------------------------------------------------

async function startTelegramLogin(accountId) {
  return fetchJson(`${TELEGRAM_WORKER_URL}/telegram/accounts`, { method: 'POST', body: { account_id: accountId } });
}

async function getTelegramLoginStatus(accountId) {
  return fetchJson(`${TELEGRAM_WORKER_URL}/telegram/qr?account_id=${encodeURIComponent(accountId)}`);
}

async function submitTelegramLoginPassword(accountId, password) {
  return fetchJson(`${TELEGRAM_WORKER_URL}/telegram/accounts/password`, {
    method: 'POST',
    body: { account_id: accountId, password },
  });
}

// Invalidates the session on Telegram's side (Telethon log_out()) without
// touching this dashboard's own channels/routing/monitoring/match-history
// data — the worker has no DB access at all.
async function logoutTelegram(accountId) {
  return fetchJson(`${TELEGRAM_WORKER_URL}/telegram/accounts/logout`, { method: 'POST', body: { account_id: accountId } });
}

// Pause/resume: stops/resumes event PROCESSING for this account without
// touching its connection/session at all -- distinct from logout. Effective
// immediately, persisted worker-side, survives a worker restart.
async function pauseTelegram(accountId) {
  return fetchJson(`${TELEGRAM_WORKER_URL}/telegram/accounts/pause`, { method: 'POST', body: { account_id: accountId } });
}

async function resumeTelegram(accountId) {
  return fetchJson(`${TELEGRAM_WORKER_URL}/telegram/accounts/resume`, { method: 'POST', body: { account_id: accountId } });
}

// Only ever called for an account the caller has just confirmed is in
// 'requires_auth' (a real WhatsApp-side logout/device-removal) — plain
// reconnects/disconnects self-heal on their own and must never reach this.
async function clearWhatsappSession(accountId) {
  if (!SAFE_ACCOUNT_ID.test(accountId)) {
    return { ok: false, error: 'invalid account_id' };
  }
  const dir = path.join(WHATSAPP_SESSIONS_DIR, accountId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// /health there is deliberately unauthenticated (same convention as
// telegram-worker/whatsapp-worker's own /health) -- auth: false.
async function getPocketListingIngestStatus() {
  const health = await fetchJson(`${POCKET_LISTING_INGEST_URL}/health`, { auth: false });
  return {
    reachable: health.ok,
    health: health.ok ? health.data : null,
    error: health.ok ? null : health.error,
  };
}

module.exports = {
  getTelegramStatus,
  getWhatsappStatus,
  getPocketListingIngestStatus,
  listWhatsappAccounts,
  getWhatsappQr,
  getWhatsappGroups,
  getTelegramDialogsForAccount,
  reconnectWhatsapp,
  clearWhatsappSession,
  connectWhatsapp,
  logoutWhatsapp,
  pauseWhatsapp,
  resumeWhatsapp,
  startTelegramLogin,
  getTelegramLoginStatus,
  submitTelegramLoginPassword,
  logoutTelegram,
  pauseTelegram,
  resumeTelegram,
};
