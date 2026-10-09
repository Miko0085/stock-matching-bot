'use strict';

// Moscow's own settings/intake-rules/config-versions repository (2026-09-28,
// migration 0029: matching_moscow.runtime_settings/intake_rules/
// config_versions/config_draft). This is a thin binding, not a second
// implementation: it reuses lead-matching-service's config-repository.js
// (already schema-parameterized for exactly this purpose) with
// `schema: 'matching_moscow'` on every call, instead of copy-pasting ~350
// lines of draft/Apply/rollback/validation logic a second time.
//
// This does NOT violate AGENTS.md section 0's "No shared runtime_settings/
// intake_rules table across markets, ever" -- the TABLE is never shared
// (matching_moscow.* is a completely separate schema from matching_dubai.*,
// created by its own migration); only the query/validation CODE is shared,
// exactly like src/joker/joker-stock-repository.js already shares one
// implementation across 4 separate Joker-market schemas via a `schema`
// parameter. dashboard/moscow-settings-queries.js is the dashboard-facing
// re-export of this module, mirroring dashboard/settings-queries.js's own
// "thin re-export, no config logic of its own" pattern for UAE.
const dubaiConfigRepo = require('../../../dubai-lead-matching-service/src/repositories/config-repository');

const SCHEMA = 'matching_moscow';

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
