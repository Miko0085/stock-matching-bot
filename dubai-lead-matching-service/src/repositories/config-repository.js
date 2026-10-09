'use strict';

// Nika Matching V2, Phase 1 (read layer) + Phase 2 (draft/Apply/rollback
// write layer) + Phase 3 (loadActiveV2Config, read-only) --
// AGENTS_NIKA_MATCHING_V2.md section 26. Wraps
// matching_dubai.runtime_settings / matching_dubai.intake_rules / matching_dubai.config_versions
// (migration 0020) and matching_dubai.config_draft (migration 0021).
//
// STILL NOT WIRED INTO ANY LIVE DECISION (Phase 1's requirement E). As of
// Phase 3, `services/shadow-evaluator.js` DOES call `loadActiveV2Config()`
// below -- but only to compute a SHADOW decision that is persisted for
// observation and never affects `src/gates/triage.js`'s real decision or
// anything else on the live routing path.
// `lead-matching-service/src/config/index.js` (env-based) remains the only
// config source that controls actual behavior. The dashboard (a separate
// process, dashboard/server.js) is the only consumer of the write
// functions below -- it imports this module directly (relative path) and
// passes its OWN pool, since both connect to the same `matching_dubai` schema
// in the same database.
//
// Schema-parameterized (2026-09-28, matching_moscow's own editable settings,
// migration 0029): every function accepts an optional trailing
// `{ schema = 'matching_dubai' }` -- every EXISTING call site (all of UAE's
// live usage) omits it and gets byte-identical behavior against
// matching_dubai, exactly as before this change. `rf-lead-matching-service`'s
// own `config-repository.js` is a thin wrapper that calls into this same
// module with `schema: 'matching_moscow'` -- one implementation, two
// separate schemas, never a merged table (AGENTS.md section 0: "No shared
// runtime_settings/intake_rules table across markets, ever"). The schema
// name is never accepted from raw external input -- `assertValidConfigSchema`
// validates it against a fixed allow-list before it is ever interpolated
// into a query string, since Postgres has no way to bind a schema
// identifier as a query parameter (same discipline as
// src/joker/joker-stock-repository.js's assertValidSchema).
const { validateSettingValue, validateRule } = require('../config/config-validation');

const VALID_CONFIG_SCHEMAS = new Set(['matching_dubai', 'matching_moscow', 'matching_abu_dhabi']);

function assertValidConfigSchema(schema) {
  if (!VALID_CONFIG_SCHEMAS.has(schema)) {
    throw new Error(`Refusing to query unrecognized config schema "${schema}" -- not in the allow-list`);
  }
}

function coerceSettingValue(valueType, valueText) {
  if (valueText === null || valueText === undefined) return null;
  switch (valueType) {
    case 'boolean':
      return valueText === 'true';
    case 'integer': {
      const n = Number.parseInt(valueText, 10);
      return Number.isFinite(n) ? n : null;
    }
    case 'numeric': {
      const n = Number(valueText);
      return Number.isFinite(n) ? n : null;
    }
    case 'text':
    default:
      return valueText;
  }
}

// Returns { [key]: { value, enabled } } for every stored setting,
// regardless of `enabled` -- callers decide whether a disabled setting
// should fall back to a hardcoded default; this layer never hides rows.
async function getActiveRuntimeSettings(pool, { schema = 'matching_dubai' } = {}) {
  assertValidConfigSchema(schema);
  const { rows } = await pool.query(
    `SELECT key, value_type, value_text, enabled FROM ${schema}.runtime_settings ORDER BY key`
  );
  const settings = {};
  for (const row of rows) {
    settings[row.key] = { value: coerceSettingValue(row.value_type, row.value_text), enabled: row.enabled };
  }
  return settings;
}

const RULE_GROUPS = ['BLACKLIST', 'WHITELIST', 'PROPERTY_SIGNAL', 'SEND_TO_AI'];

// Returns { BLACKLIST: [...], WHITELIST: [...], PROPERTY_SIGNAL: [...],
// SEND_TO_AI: [...] } -- every group key always present (possibly empty),
// so a caller never needs a defensive `?? []` for a group with zero rows
// (e.g. SEND_TO_AI, intentionally unseeded in Phase 1).
async function getEnabledIntakeRules(pool, { schema = 'matching_dubai' } = {}) {
  assertValidConfigSchema(schema);
  const { rows } = await pool.query(
    `SELECT id, rule_group, match_type, pattern, priority, description
     FROM ${schema}.intake_rules
     WHERE enabled = true
     ORDER BY rule_group, priority, id`
  );
  const grouped = Object.fromEntries(RULE_GROUPS.map((group) => [group, []]));
  for (const row of rows) {
    grouped[row.rule_group].push(row);
  }
  return grouped;
}

// Same shape as getEnabledIntakeRules(), but includes disabled rows too --
// the Settings UI needs to display/edit disabled rules, not just the ones
// a future runtime consumer would actually apply.
async function getAllIntakeRulesGrouped(pool, { schema = 'matching_dubai' } = {}) {
  assertValidConfigSchema(schema);
  const { rows } = await pool.query(
    `SELECT id, rule_group, match_type, pattern, enabled, priority, description
     FROM ${schema}.intake_rules
     ORDER BY rule_group, priority, id`
  );
  const grouped = Object.fromEntries(RULE_GROUPS.map((group) => [group, []]));
  for (const row of rows) {
    grouped[row.rule_group].push(row);
  }
  return grouped;
}

async function getCurrentConfigVersion(pool, { schema = 'matching_dubai' } = {}) {
  assertValidConfigSchema(schema);
  const { rows } = await pool.query(
    `SELECT id, version_number, snapshot, note, created_at, created_by
     FROM ${schema}.config_versions ORDER BY version_number DESC LIMIT 1`
  );
  return rows[0] || null;
}

async function getConfigVersionHistory(pool, { schema = 'matching_dubai' } = {}) {
  assertValidConfigSchema(schema);
  const { rows } = await pool.query(
    `SELECT id, version_number, note, created_at, created_by
     FROM ${schema}.config_versions ORDER BY version_number DESC`
  );
  return rows;
}

// Phase 3: the ONE loader the shadow gate's cache (see dashboard's/
// server.js's TTL-bounded cache pattern) refreshes on -- bundles the two
// reads a gate evaluation needs (enabled rules + settings) plus which
// config_versions.id is currently active, in one round trip, so a live
// shadow evaluation never issues more than this single cached load's worth
// of queries regardless of how many rules exist (spec section 3: "Avoid a
// fresh DB roundtrip per individual rule").
//
// Phase 4 hardening (spec section 9, "config coherence"): the original
// Phase 3 version ran these three reads as independent `pool.query()`
// calls via Promise.all -- each on its own implicit autocommit
// transaction/snapshot under Postgres's default READ COMMITTED isolation.
// That left a real (if narrow) race: if an operator's Apply (a single
// transaction that DELETEs and re-INSERTs both runtime_settings AND
// intake_rules, then inserts the new config_versions row) committed
// in between two of these three queries, a caller could see settings from
// version N and rules from version N+1 -- exactly "do not load settings
// from version N and rules from version N+1," which the spec explicitly
// forbids. Running all three inside ONE REPEATABLE READ transaction
// pins every read to the SAME consistent database snapshot, so this is
// now provably impossible regardless of how an Apply lands mid-read.
async function loadActiveV2Config(pool, { schema = 'matching_dubai' } = {}) {
  assertValidConfigSchema(schema);
  const client = await pool.connect();
  // 2026-10-06 incident: this crashed rf-lead-matching-service's whole
  // process. src/db/pool.js's own `pool.on('error', ...)` only covers an
  // IDLE client sitting in the pool -- a client checked OUT via
  // pool.connect() (exactly this one, held for the duration of the
  // transaction below) is a separate EventEmitter, and pg does not proxy
  // its connection-drop errors back to the pool while it's checked out.
  // With no listener here, that 'error' event was unhandled and threw,
  // killing the process outright -- this call runs on every single
  // webhook request (loadActiveV2Config is the first thing the real
  // matching pipeline does), so any transient SSH-tunnel hiccup to
  // devi_db during this specific window took the whole service down.
  // Same fix/reasoning as pool.js's own handler: log and move on, pg
  // already discards the broken client. Named (not inline) so it can be
  // removed again on release below -- a pooled client is a physical
  // connection pg reuses across many pool.connect() calls over its
  // lifetime; leaving the listener attached after release leaked one more
  // 'error' listener onto the same client every call, eventually tripping
  // Node's MaxListenersExceededWarning (found running the test suite,
  // same incident fix, 2026-10-06).
  function onClientError(err) {
    console.error('[config-repository] checked-out client connection error (transaction will fail safely via catch below):', err.message);
  }
  client.on('error', onClientError);
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // Sequential, not Promise.all: all three still read the SAME pinned
    // REPEATABLE READ snapshot (that's what guarantees consistency, not
    // concurrency), but a single pg Client can only run one query at a
    // time -- firing them "in parallel" here just made `pg` silently queue
    // them behind the scenes, which it explicitly deprecates (2026-09-30
    // audit finding: this call site was the reason `pg` logs "Calling
    // client.query() when the client is already executing a query is
    // deprecated and will be removed in pg@9.0").
    const settings = await getActiveRuntimeSettings(client, { schema });
    const rules = await getEnabledIntakeRules(client, { schema });
    const currentVersion = await getCurrentConfigVersion(client, { schema });
    await client.query('COMMIT');
    return { settings, rules, configVersionId: currentVersion ? currentVersion.id : null };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.removeListener('error', onClientError);
    client.release();
  }
}

async function getConfigVersionDetail(pool, versionNumber, { schema = 'matching_dubai' } = {}) {
  assertValidConfigSchema(schema);
  const { rows } = await pool.query(
    `SELECT id, version_number, snapshot, note, created_at, created_by
     FROM ${schema}.config_versions WHERE version_number = $1`,
    [versionNumber]
  );
  return rows[0] || null;
}

// A rule's meaningful identity across versions is its CONTENT
// (group+type+pattern), not its DB `id` -- Apply/rollback always
// delete-and-reinsert intake_rules (see writeConfigAndSnapshot below), so
// ids are not stable across versions even for an unchanged rule.
function ruleIdentityKey(rule) {
  return `${rule.rule_group}::${rule.match_type}::${rule.pattern}`;
}

// Pure diff between two snapshots (spec section 4: "settings changed,
// rules added, rules removed, rules enabled/disabled" -- deliberately not
// a byte-level JSON diff, just the specific categories asked for).
function diffConfigVersions(oldSnapshot, newSnapshot) {
  const oldSettings = new Map((oldSnapshot?.runtime_settings || []).map((s) => [s.key, s]));
  const newSettings = new Map((newSnapshot?.runtime_settings || []).map((s) => [s.key, s]));
  const settingsChanged = [];
  for (const [key, after] of newSettings) {
    const before = oldSettings.get(key) || null;
    if (!before || before.value_text !== after.value_text || before.enabled !== after.enabled) {
      settingsChanged.push({ key, before, after });
    }
  }

  const oldRules = new Map((oldSnapshot?.intake_rules || []).map((r) => [ruleIdentityKey(r), r]));
  const newRules = new Map((newSnapshot?.intake_rules || []).map((r) => [ruleIdentityKey(r), r]));
  const rulesAdded = [];
  const rulesRemoved = [];
  const rulesToggled = [];
  for (const [key, after] of newRules) {
    const before = oldRules.get(key);
    if (!before) rulesAdded.push(after);
    else if (before.enabled !== after.enabled) rulesToggled.push({ before, after });
  }
  for (const [key, before] of oldRules) {
    if (!newRules.has(key)) rulesRemoved.push(before);
  }

  return { settingsChanged, rulesAdded, rulesRemoved, rulesToggled };
}

// ---------------------------------------------------------------------
// Phase 2: draft workspace (matching_dubai.config_draft) -- individual UI edits
// land here, never directly in runtime_settings/intake_rules. Only
// applyDraft()/rollbackToVersion() below ever write the real mutable
// tables, both inside one DB transaction each (spec section 3/6: "Apply
// changes atomically... If Apply fails: rollback transaction, do not
// partially update settings/rules").
// ---------------------------------------------------------------------

async function buildSettingsArrayFromTable(pool, schema) {
  const { rows } = await pool.query(
    `SELECT key, value_type, value_text, enabled FROM ${schema}.runtime_settings ORDER BY key`
  );
  return rows;
}

async function buildRulesArrayFromTable(pool, schema) {
  const { rows } = await pool.query(
    `SELECT id, rule_group, match_type, pattern, enabled, priority, description
     FROM ${schema}.intake_rules ORDER BY rule_group, priority, id`
  );
  return rows;
}

// Creates the singleton draft row from the CURRENT real tables the first
// time it's touched; every later call just returns the existing draft
// (which may already contain unapplied edits).
async function getOrInitDraft(pool, { schema = 'matching_dubai' } = {}) {
  assertValidConfigSchema(schema);
  const existing = await pool.query(`SELECT * FROM ${schema}.config_draft WHERE id = 1`);
  if (existing.rows.length) return existing.rows[0];

  const [settings, rules, current] = await Promise.all([
    buildSettingsArrayFromTable(pool, schema),
    buildRulesArrayFromTable(pool, schema),
    getCurrentConfigVersion(pool, { schema }),
  ]);
  const { rows } = await pool.query(
    `INSERT INTO ${schema}.config_draft (id, settings, intake_rules, based_on_version, is_dirty)
     VALUES (1, $1, $2, $3, false)
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [JSON.stringify(settings), JSON.stringify(rules), current ? current.version_number : null]
  );
  if (rows[0]) return rows[0];
  // Lost a race with a concurrent initializer -- read back what won.
  const retry = await pool.query(`SELECT * FROM ${schema}.config_draft WHERE id = 1`);
  return retry.rows[0];
}

// Resets the draft to mirror the CURRENT real tables -- used both as the
// explicit "discard my edits" action and internally right after a
// successful Apply/rollback (so the draft picks up the freshly-assigned
// real row ids instead of stale temporary ones).
async function discardDraft(pool, { schema = 'matching_dubai' } = {}) {
  assertValidConfigSchema(schema);
  const [settings, rules, current] = await Promise.all([
    buildSettingsArrayFromTable(pool, schema),
    buildRulesArrayFromTable(pool, schema),
    getCurrentConfigVersion(pool, { schema }),
  ]);
  const { rows } = await pool.query(
    `INSERT INTO ${schema}.config_draft (id, settings, intake_rules, based_on_version, is_dirty, updated_at)
     VALUES (1, $1, $2, $3, false, now())
     ON CONFLICT (id) DO UPDATE SET
       settings = EXCLUDED.settings, intake_rules = EXCLUDED.intake_rules,
       based_on_version = EXCLUDED.based_on_version, is_dirty = false, updated_at = now()
     RETURNING *`,
    [JSON.stringify(settings), JSON.stringify(rules), current ? current.version_number : null]
  );
  return rows[0];
}

async function updateDraftSetting(pool, key, { valueText, enabled } = {}, { schema = 'matching_dubai' } = {}) {
  assertValidConfigSchema(schema);
  const draft = await getOrInitDraft(pool, { schema });
  const settings = draft.settings;
  const existing = settings.find((s) => s.key === key);
  if (!existing) {
    return { ok: false, error: `Unknown setting key "${key}" -- new setting keys cannot be added through this UI.` };
  }
  const check = validateSettingValue(key, existing.value_type, valueText, enabled);
  if (!check.ok) return check;

  existing.value_text = valueText;
  existing.enabled = enabled;
  await pool.query(
    `UPDATE ${schema}.config_draft SET settings = $1, is_dirty = true, updated_at = now() WHERE id = 1`,
    [JSON.stringify(settings)]
  );
  return { ok: true };
}

// New draft-only rules get a synthetic negative id (never collides with a
// real BIGSERIAL id, which is always positive) so the UI can address them
// for edit/delete before they've ever been persisted to the real table.
function nextDraftRuleId(rules) {
  const negativeIds = rules.map((r) => Number(r.id)).filter((id) => Number.isFinite(id) && id < 0);
  return negativeIds.length ? Math.min(...negativeIds) - 1 : -1;
}

async function addDraftRule(pool, { rule_group, match_type, pattern, enabled = true, priority = 100, description = null }, { schema = 'matching_dubai' } = {}) {
  assertValidConfigSchema(schema);
  const check = validateRule({ rule_group, match_type, pattern, priority });
  if (!check.ok) return check;

  const draft = await getOrInitDraft(pool, { schema });
  const rules = draft.intake_rules;
  const id = nextDraftRuleId(rules);
  rules.push({ id, rule_group, match_type, pattern, enabled: Boolean(enabled), priority: Number(priority), description: description || null });
  await pool.query(
    `UPDATE ${schema}.config_draft SET intake_rules = $1, is_dirty = true, updated_at = now() WHERE id = 1`,
    [JSON.stringify(rules)]
  );
  return { ok: true, id };
}

async function updateDraftRule(pool, id, patch, { schema = 'matching_dubai' } = {}) {
  assertValidConfigSchema(schema);
  const draft = await getOrInitDraft(pool, { schema });
  const rules = draft.intake_rules;
  const rule = rules.find((r) => Number(r.id) === Number(id));
  if (!rule) return { ok: false, error: `Rule ${id} was not found in the current draft (it may have already been applied or removed).` };

  const merged = { ...rule, ...patch };
  const check = validateRule(merged);
  if (!check.ok) return check;

  Object.assign(rule, merged);
  await pool.query(
    `UPDATE ${schema}.config_draft SET intake_rules = $1, is_dirty = true, updated_at = now() WHERE id = 1`,
    [JSON.stringify(rules)]
  );
  return { ok: true };
}

async function deleteDraftRule(pool, id, { schema = 'matching_dubai' } = {}) {
  assertValidConfigSchema(schema);
  const draft = await getOrInitDraft(pool, { schema });
  const rules = draft.intake_rules.filter((r) => Number(r.id) !== Number(id));
  await pool.query(
    `UPDATE ${schema}.config_draft SET intake_rules = $1, is_dirty = true, updated_at = now() WHERE id = 1`,
    [JSON.stringify(rules)]
  );
  return { ok: true };
}

// Shared core of Apply and Rollback: given a full (settings, rules) pair,
// atomically replace the real mutable tables and record a new,
// full-fidelity snapshot. MUST be called with a `client` already inside a
// transaction (BEGIN already issued by the caller) -- this function itself
// never begins/commits, so both callers control the transaction boundary
// (and can each add their own note/created_by).
//
// Full delete-and-reinsert rather than a diff-based upsert: the tables are
// tiny (13 settings, ~40 rules) and this keeps the logic simple and
// obviously correct (spec's repeated "keep it simple") -- intake_rules ids
// are NOT a stable identity across versions as a result (see
// ruleIdentityKey() above, which is why diffing uses content, not id).
async function writeConfigAndSnapshot(client, { settings, rules, note, createdBy, schema = 'matching_dubai' }) {
  assertValidConfigSchema(schema);
  await client.query(`DELETE FROM ${schema}.runtime_settings`);
  for (const s of settings) {
    await client.query(
      `INSERT INTO ${schema}.runtime_settings (key, value_type, value_text, enabled, updated_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [s.key, s.value_type, s.value_text, s.enabled, createdBy || null]
    );
  }

  await client.query(`DELETE FROM ${schema}.intake_rules`);
  for (const r of rules) {
    await client.query(
      `INSERT INTO ${schema}.intake_rules (rule_group, match_type, pattern, enabled, priority, description)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [r.rule_group, r.match_type, r.pattern, r.enabled, r.priority, r.description || null]
    );
  }

  const versionResult = await client.query(`SELECT coalesce(max(version_number), 0) AS max_v FROM ${schema}.config_versions`);
  const nextVersion = versionResult.rows[0].max_v + 1;

  // Snapshot is built by re-reading the rows just written -- same
  // "aggregate from real rows, never a hand-duplicated literal" discipline
  // as migration 0020's Phase 1.1 backfill, so it can never drift.
  const settingsAgg = await client.query(
    `SELECT coalesce(jsonb_agg(jsonb_build_object(
       'key', key, 'value_type', value_type, 'value_text', value_text, 'enabled', enabled
     ) ORDER BY key), '[]'::jsonb) AS j
     FROM ${schema}.runtime_settings`
  );
  const rulesAgg = await client.query(
    `SELECT coalesce(jsonb_agg(jsonb_build_object(
       'rule_group', rule_group, 'match_type', match_type, 'pattern', pattern,
       'enabled', enabled, 'priority', priority, 'description', description
     ) ORDER BY rule_group, priority, id), '[]'::jsonb) AS j
     FROM ${schema}.intake_rules`
  );

  const snapshot = {
    schema_version: 1,
    config_version: nextVersion,
    runtime_settings: settingsAgg.rows[0].j,
    intake_rules: rulesAgg.rows[0].j,
  };

  const inserted = await client.query(
    `INSERT INTO ${schema}.config_versions (version_number, snapshot, note, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id, version_number, snapshot, note, created_at, created_by`,
    [nextVersion, JSON.stringify(snapshot), note || null, createdBy || null]
  );
  return inserted.rows[0];
}

// Validates the ENTIRE draft before touching the database at all -- an
// invalid setting/rule anywhere in the draft blocks the whole Apply (spec
// section 6: "validate all settings/rules"), never a partial write.
function validateDraft(draft) {
  for (const s of draft.settings) {
    const check = validateSettingValue(s.key, s.value_type, s.value_text, s.enabled);
    if (!check.ok) return check;
  }
  for (const r of draft.intake_rules) {
    const check = validateRule(r);
    if (!check.ok) return check;
  }
  return { ok: true };
}

async function applyDraft(pool, { note, createdBy } = {}, { schema = 'matching_dubai' } = {}) {
  assertValidConfigSchema(schema);
  const draft = await getOrInitDraft(pool, { schema });
  const validation = validateDraft(draft);
  if (!validation.ok) return validation;

  const client = await pool.connect();
  // See loadActiveV2Config's own comment (2026-10-06 incident + the
  // MaxListenersExceededWarning follow-up fix) -- a checked-out client
  // needs its own error listener, the pool's doesn't cover it, and it must
  // be removed again on release since pg reuses the same physical client
  // across many pool.connect() calls.
  function onClientError(err) {
    console.error('[config-repository] checked-out client connection error (applyDraft will fail safely via catch below):', err.message);
  }
  client.on('error', onClientError);
  try {
    await client.query('BEGIN');
    const version = await writeConfigAndSnapshot(client, {
      settings: draft.settings,
      rules: draft.intake_rules,
      note: note || 'Manual apply from Settings UI',
      createdBy,
      schema,
    });
    await client.query('COMMIT');
    // Re-sync the draft against the just-applied state (new real ids,
    // is_dirty reset) -- the operator's NEXT edit starts from a clean base.
    await discardDraft(pool, { schema });
    return { ok: true, version };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, error: `Apply failed: ${err.message}` };
  } finally {
    client.removeListener('error', onClientError);
    client.release();
  }
}

async function rollbackToVersion(pool, versionNumber, { createdBy } = {}, { schema = 'matching_dubai' } = {}) {
  assertValidConfigSchema(schema);
  const target = await getConfigVersionDetail(pool, versionNumber, { schema });
  if (!target) return { ok: false, error: `Version ${versionNumber} not found.` };

  // Rollback still runs through the SAME validation as Apply -- an old
  // snapshot is trusted data (it was valid when created), but this keeps
  // the two write paths from ever silently diverging.
  const validation = validateDraft({ settings: target.snapshot.runtime_settings, intake_rules: target.snapshot.intake_rules });
  if (!validation.ok) return validation;

  const client = await pool.connect();
  // See loadActiveV2Config's own comment (2026-10-06 incident + the
  // MaxListenersExceededWarning follow-up fix) -- a checked-out client
  // needs its own error listener, the pool's doesn't cover it, and it must
  // be removed again on release since pg reuses the same physical client
  // across many pool.connect() calls.
  function onClientError(err) {
    console.error('[config-repository] checked-out client connection error (rollbackToVersion will fail safely via catch below):', err.message);
  }
  client.on('error', onClientError);
  try {
    await client.query('BEGIN');
    const version = await writeConfigAndSnapshot(client, {
      settings: target.snapshot.runtime_settings,
      rules: target.snapshot.intake_rules,
      note: `Rollback to version ${versionNumber}`,
      createdBy,
      schema,
    });
    await client.query('COMMIT');
    await discardDraft(pool, { schema });
    return { ok: true, version };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, error: `Rollback failed: ${err.message}` };
  } finally {
    client.removeListener('error', onClientError);
    client.release();
  }
}

module.exports = {
  VALID_CONFIG_SCHEMAS,
  coerceSettingValue,
  getActiveRuntimeSettings,
  getEnabledIntakeRules,
  getAllIntakeRulesGrouped,
  getCurrentConfigVersion,
  getConfigVersionHistory,
  getConfigVersionDetail,
  loadActiveV2Config,
  diffConfigVersions,
  getOrInitDraft,
  discardDraft,
  updateDraftSetting,
  addDraftRule,
  updateDraftRule,
  deleteDraftRule,
  applyDraft,
  rollbackToVersion,
};
