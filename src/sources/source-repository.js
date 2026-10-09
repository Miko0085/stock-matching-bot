'use strict';

// Shared source catalog repository (ingest.sources / ingest.source_routes).
// Infrastructure-only: which chats exist, whether we listen to them, which
// market contour(s) they route to. Never touches UAE/RF domain tables.
//
// Re-sync safety (explicit release requirement): upsertSource() only ever
// writes DESCRIPTIVE columns on ingest.sources (name/username/member_count/
// joined/available/last_seen_at/last_synced_at/metadata) and never touches
// ingest.source_routes at all beyond ensuring a default row exists the
// FIRST time a source is seen -- an operator's monitoring_enabled/
// route_modes/manual_override/notes decision can never be overwritten by a
// re-sync, no matter how many times it runs.

const REAL_MARKETS = ['DUBAI', 'RF', 'SAUDI', 'ABU_DHABI'];
const ALL_ROUTE_LABELS = [...REAL_MARKETS, 'AUTO', 'NONE'];

// Multi-route selection (2026-10-06, migration 0041): a source may be
// routed to any non-empty combination of the four real market labels, OR
// to exactly one of the two sentinels (AUTO/NONE), never a mix. This is
// the APPLICATION-layer copy of the same rule the DB's own
// `source_routes_route_modes_valid` CHECK enforces -- two independent
// layers agreeing is the point (same discipline as config-validation.js's
// isLocationKey), not redundancy to trim. Never throws: an invalid/empty
// submission is normalized to the safe default (['NONE'], stop
// processing) rather than silently doing something unintended.
function validateRouteModes(modes) {
  const deduped = [...new Set((Array.isArray(modes) ? modes : [modes]).filter(Boolean))];
  const unknown = deduped.filter((m) => !ALL_ROUTE_LABELS.includes(m));
  if (unknown.length) {
    return { ok: false, error: `Unknown route label(s): ${unknown.join(', ')}` };
  }
  if (deduped.length === 0) {
    return { ok: true, routeModes: ['NONE'] };
  }
  const hasAuto = deduped.includes('AUTO');
  const hasNone = deduped.includes('NONE');
  if ((hasAuto || hasNone) && deduped.length > 1) {
    return { ok: false, error: 'AUTO/NONE cannot be combined with another route label.' };
  }
  return { ok: true, routeModes: deduped };
}

async function upsertSource(pool, {
  provider,
  accountId,
  externalSourceId,
  sourceType = null,
  name = null,
  usernameOrHandle = null,
  memberCount = null,
  joined = true,
  available = true,
  metadata = {},
}) {
  const { rows } = await pool.query(
    `INSERT INTO ingest.sources (
       provider, account_id, external_source_id, source_type, name, username_or_handle,
       member_count, joined, available, last_seen_at, last_synced_at, metadata, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), now(), $10, now())
     ON CONFLICT (provider, account_id, external_source_id) DO UPDATE SET
       source_type = EXCLUDED.source_type,
       name = EXCLUDED.name,
       username_or_handle = EXCLUDED.username_or_handle,
       member_count = EXCLUDED.member_count,
       joined = EXCLUDED.joined,
       available = EXCLUDED.available,
       last_seen_at = now(),
       last_synced_at = now(),
       metadata = EXCLUDED.metadata,
       updated_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [provider, accountId, externalSourceId, sourceType, name, usernameOrHandle, memberCount, joined, available, JSON.stringify(metadata || {})]
  );
  const { id, inserted } = rows[0];

  // Ensure a routing row exists, defaulting to fully inert (monitoring
  // off, route NONE) -- never upserted/overwritten again after this.
  await pool.query(
    `INSERT INTO ingest.source_routes (source_id, monitoring_enabled, route_modes, manual_override)
     VALUES ($1, false, ARRAY['NONE'], false)
     ON CONFLICT (source_id) DO NOTHING`,
    [id]
  );

  return { id, inserted: Boolean(inserted) };
}

// Marks any source of this (provider, account_id) NOT present in the
// current sync's seen set as unavailable -- never deletes historical
// route configuration, matching the explicit "source disappears ->
// available=false, not gone" requirement.
async function markMissingSourcesUnavailable(pool, { provider, accountId, seenExternalSourceIds }) {
  const { rows } = await pool.query(
    `UPDATE ingest.sources
     SET available = false, updated_at = now()
     WHERE provider = $1 AND account_id = $2 AND available = true
       AND NOT (external_source_id = ANY($3::text[]))
     RETURNING id`,
    [provider, accountId, seenExternalSourceIds]
  );
  return rows.length;
}

async function listSources(pool, { provider, accountId, routeMode, monitoringEnabled, search } = {}) {
  const conditions = [];
  const params = [];
  function addParam(value) {
    params.push(value);
    return `$${params.length}`;
  }
  if (provider) conditions.push(`s.provider = ${addParam(provider)}`);
  if (accountId) conditions.push(`s.account_id = ${addParam(accountId)}`);
  // Containment, not equality (2026-10-06, migration 0041): filtering by
  // "DUBAI" must still surface a source routed to e.g. [DUBAI, ABU_DHABI].
  if (routeMode) conditions.push(`${addParam(routeMode)} = ANY(r.route_modes)`);
  if (monitoringEnabled !== undefined && monitoringEnabled !== null && monitoringEnabled !== '') {
    conditions.push(`r.monitoring_enabled = ${addParam(monitoringEnabled === true || monitoringEnabled === 'true')}`);
  }
  if (search) {
    const like = `%${search}%`;
    conditions.push(`(s.name ILIKE ${addParam(like)} OR s.username_or_handle ILIKE ${addParam(like)} OR s.external_source_id ILIKE ${addParam(like)})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT s.*, r.monitoring_enabled, r.route_modes, r.manual_override, r.notes, r.updated_at AS route_updated_at, r.updated_by
     FROM ingest.sources s
     JOIN ingest.source_routes r ON r.source_id = s.id
     ${where}
     ORDER BY s.provider, s.account_id, s.name NULLS LAST`,
    params
  );
  return rows;
}

// Distinct (provider, account_id) pairs across everything ever synced --
// populates the /sources page's channel/account filter dropdown. Not
// scoped to the caller's other filters, same reasoning as
// findDuplicateExternalIds: the dropdown's own option list should not
// shrink just because some other filter is currently narrowing the table.
async function listAccounts(pool) {
  const { rows } = await pool.query(
    `SELECT DISTINCT provider, account_id FROM ingest.sources ORDER BY provider, account_id`
  );
  return rows;
}

// Cross-account duplicates: the same physical group/channel (same
// provider + external_source_id) synced under more than one of our own
// accounts (e.g. two Telegram accounts both members of the same group).
// Deliberately GLOBAL, not scoped to whatever filters the caller's current
// /sources view happens to have applied -- an operator should see the
// duplicate indicator regardless of which filtered slice they're looking
// at. Read-only: per an explicit product decision (2026-09-27), this only
// surfaces the duplicates for a human to review -- it never merges,
// disables, or deletes either side.
async function findDuplicateExternalIds(pool) {
  const { rows } = await pool.query(
    `SELECT provider, external_source_id, array_agg(DISTINCT account_id ORDER BY account_id) AS account_ids, count(DISTINCT account_id)::int AS account_count
     FROM ingest.sources
     GROUP BY provider, external_source_id
     HAVING count(DISTINCT account_id) > 1`
  );
  const map = new Map();
  for (const row of rows) {
    map.set(`${row.provider}:${row.external_source_id}`, { accountIds: row.account_ids, accountCount: row.account_count });
  }
  return map;
}

async function getSourceById(pool, sourceId) {
  const { rows } = await pool.query(
    `SELECT s.*, r.monitoring_enabled, r.route_modes, r.manual_override, r.notes
     FROM ingest.sources s JOIN ingest.source_routes r ON r.source_id = s.id
     WHERE s.id = $1`,
    [sourceId]
  );
  return rows[0] || null;
}

// PATCH-style: only fields explicitly present (not undefined) are
// updated. Setting routeModes/monitoringEnabled here always sets
// manual_override=true (this IS the operator making an explicit
// decision), unless the caller explicitly passes manualOverride itself.
// `patch.routeModes` (array, possibly multi-market -- 2026-10-06, migration
// 0041) is run through validateRouteModes() before ever reaching SQL; an
// invalid combination (e.g. AUTO mixed with a real market) is rejected
// with `{ ok: false, error }` instead of being silently written.
async function updateSourceRoute(pool, sourceId, patch) {
  const sets = [];
  const params = [sourceId];
  function addParam(value) {
    params.push(value);
    return `$${params.length}`;
  }
  if (patch.monitoringEnabled !== undefined) sets.push(`monitoring_enabled = ${addParam(patch.monitoringEnabled)}`);
  if (patch.routeModes !== undefined) {
    const check = validateRouteModes(patch.routeModes);
    if (!check.ok) return { ok: false, error: check.error };
    sets.push(`route_modes = ${addParam(check.routeModes)}::text[]`);
  }
  if (patch.notes !== undefined) sets.push(`notes = ${addParam(patch.notes)}`);
  if (patch.manualOverride !== undefined) {
    sets.push(`manual_override = ${addParam(patch.manualOverride)}`);
  } else if (patch.routeModes !== undefined || patch.monitoringEnabled !== undefined) {
    sets.push(`manual_override = true`);
  }
  if (patch.updatedBy !== undefined) sets.push(`updated_by = ${addParam(patch.updatedBy)}`);
  if (sets.length === 0) return getSourceById(pool, sourceId);

  sets.push(`updated_at = now()`);
  await pool.query(`UPDATE ingest.source_routes SET ${sets.join(', ')} WHERE source_id = $1`, params);
  return getSourceById(pool, sourceId);
}

async function bulkUpdateSourceRoutes(pool, sourceIds, patch) {
  const results = [];
  for (const sourceId of sourceIds) {
    results.push(await updateSourceRoute(pool, sourceId, patch));
  }
  return results;
}

async function startSyncRun(pool, { provider, accountId }) {
  const { rows } = await pool.query(
    `INSERT INTO ingest.source_sync_runs (provider, account_id, status) VALUES ($1, $2, 'RUNNING') RETURNING id`,
    [provider, accountId]
  );
  return rows[0].id;
}

async function completeSyncRun(pool, runId, { sourcesSeen, sourcesCreated, sourcesUpdated, sourcesMarkedUnavailable }) {
  await pool.query(
    `UPDATE ingest.source_sync_runs
     SET status = 'SUCCESS', completed_at = now(), sources_seen = $2, sources_created = $3, sources_updated = $4, sources_marked_unavailable = $5
     WHERE id = $1`,
    [runId, sourcesSeen, sourcesCreated, sourcesUpdated, sourcesMarkedUnavailable]
  );
}

async function failSyncRun(pool, runId, error) {
  await pool.query(
    `UPDATE ingest.source_sync_runs SET status = 'FAILED', completed_at = now(), error = $2 WHERE id = $1`,
    [runId, String(error?.message || error)]
  );
}

module.exports = {
  validateRouteModes,
  upsertSource,
  markMissingSourcesUnavailable,
  listSources,
  listAccounts,
  findDuplicateExternalIds,
  getSourceById,
  updateSourceRoute,
  bulkUpdateSourceRoutes,
  startSyncRun,
  completeSyncRun,
  failSyncRun,
};
