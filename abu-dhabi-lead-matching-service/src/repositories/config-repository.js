'use strict';

// Abu Dhabi's own settings/intake-rules/config-versions repository
// (migration 0036: matching_abu_dhabi.runtime_settings/intake_rules/
// config_versions/config_draft). This is a thin binding, not a second
// implementation: it reuses dubai-lead-matching-service's
// config-repository.js (already schema-parameterized for exactly this
// purpose) with `schema: 'matching_abu_dhabi'` on every call, instead of
// copy-pasting ~350 lines of draft/Apply/rollback/validation logic a
// second time -- same pattern rf-lead-matching-service's own
// config-repository.js already uses for matching_moscow.
//
// This does NOT violate AGENTS.md section 0's "No shared runtime_settings/
// intake_rules table across markets, ever" -- the TABLE is never shared
// (matching_abu_dhabi.* is a completely separate schema from
// matching_dubai.*, created by its own migration); only the query/
// validation CODE is shared. dashboard/abu-dhabi-settings-queries.js is
// the dashboard-facing re-export of this module.
const dubaiConfigRepo = require('../../../dubai-lead-matching-service/src/repositories/config-repository');

const SCHEMA = 'matching_abu_dhabi';

module.exports = {
  coerceSettingValue: dubaiConfigRepo.coerceSettingValue,
  diffConfigVersions: dubaiConfigRepo.diffConfigVersions,
  getActiveRuntimeSettings: (pool) => dubaiConfigRepo.getActiveRuntimeSettings(pool, { schema: SCHEMA }),
  getEnabledIntakeRules: (pool) => dubaiConfigRepo.getEnabledIntakeRules(pool, { schema: SCHEMA }),
  getAllIntakeRulesGrouped: (pool) => dubaiConfigRepo.getAllIntakeRulesGrouped(pool, { schema: SCHEMA }),
  getCurrentConfigVersion: (pool) => dubaiConfigRepo.getCurrentConfigVersion(pool, { schema: SCHEMA }),
  getConfigVersionHistory: (pool) => dubaiConfigRepo.getConfigVersionHistory(pool, { schema: SCHEMA }),
  getConfigVersionDetail: (pool, versionNumber) => dubaiConfigRepo.getConfigVersionDetail(pool, versionNumber, { schema: SCHEMA }),
  loadActiveV2Config: (pool) => dubaiConfigRepo.loadActiveV2Config(pool, { schema: SCHEMA }),
  getOrInitDraft: (pool) => dubaiConfigRepo.getOrInitDraft(pool, { schema: SCHEMA }),
  discardDraft: (pool) => dubaiConfigRepo.discardDraft(pool, { schema: SCHEMA }),
  updateDraftSetting: (pool, key, opts) => dubaiConfigRepo.updateDraftSetting(pool, key, opts, { schema: SCHEMA }),
  addDraftRule: (pool, fields) => dubaiConfigRepo.addDraftRule(pool, fields, { schema: SCHEMA }),
  updateDraftRule: (pool, id, patch) => dubaiConfigRepo.updateDraftRule(pool, id, patch, { schema: SCHEMA }),
  deleteDraftRule: (pool, id) => dubaiConfigRepo.deleteDraftRule(pool, id, { schema: SCHEMA }),
  applyDraft: (pool, opts) => dubaiConfigRepo.applyDraft(pool, opts, { schema: SCHEMA }),
  rollbackToVersion: (pool, versionNumber, opts) => dubaiConfigRepo.rollbackToVersion(pool, versionNumber, opts, { schema: SCHEMA }),
};
