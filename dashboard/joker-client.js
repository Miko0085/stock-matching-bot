'use strict';

// Thin read-only client for the Joker CRM API. /api/objects (stock) is now
// confirmed working — it just requires limit/offset inside a JSON-encoded
// `params` query value, not as flat query params (see
// docs/JOKER_API_DISCOVERY.md). listJokerObjects() is not yet wired into
// the canonical stock_inventory mapper (JokerMapper) — this only fetches
// and returns raw pages.

const JOKER_API_BASE_URL = process.env.JOKER_API_BASE_URL || 'https://moscow.nikaestate.ru/api';
const JOKER_API_TOKEN = process.env.JOKER_API_TOKEN || '';

async function fetchJson(path, { timeoutMs = 10000 } = {}) {
  if (!JOKER_API_TOKEN) return { ok: false, error: 'JOKER_API_TOKEN is not configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${JOKER_API_BASE_URL}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(JOKER_API_TOKEN)}`;
    const res = await fetch(url, { signal: controller.signal });
    const json = await res.json();
    if (!res.ok || json.code >= 400) {
      return { ok: false, error: json.error || res.statusText };
    }
    return { ok: true, data: json.data || [] };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'превышено время ожидания' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Returns the raw agent rows: { manager_id, manager_name, manager_phone,
// manager_email, manager_position }. Real staff PII — never write this
// verbatim into a committed file (see docs/JOKER_API_DISCOVERY.md), only
// render it in the (private) dashboard UI.
async function listJokerAgents() {
  return fetchJson('/agents');
}

// One page of raw objects (stock listings). `data` in the raw response is
// a dict keyed by object id normally, but flips to `[]` when the page is
// empty (confirmed live, offset past the end of the catalog) — normalized
// to a plain array here either way.
async function listJokerObjectsPage({ limit = 200, offset = 0, full = true, filter = null } = {}) {
  const params = { limit, offset };
  if (filter) params.filter = filter;
  const query = `?full=${full ? 1 : 0}&params=${encodeURIComponent(JSON.stringify(params))}`;
  const result = await fetchJson(`/objects${query}`, { timeoutMs: 20000 });
  if (!result.ok) return result;
  const raw = result.data;
  const objects = Array.isArray(raw) ? raw : Object.values(raw || {});
  return { ok: true, data: objects };
}

module.exports = { listJokerAgents, listJokerObjectsPage };
