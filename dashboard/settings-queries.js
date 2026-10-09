'use strict';

// Nika Matching V2, Phase 2 (AGENTS_NIKA_MATCHING_V2.md section 26). Thin
// re-export of dubai-lead-matching-service's config-repository.js/
// config-validation.js -- the dashboard has no config logic of its own,
// it reuses the SAME read/write/validation functions Phase 3+ will
// eventually wire the real matcher up to, passing the dashboard's OWN
// `pool` (src/db/pool -- same `matching` schema, same database).
//
// This keeps read/write responsibilities in one place (spec section 7:
// "Keep configuration persistence logic out of rendering code... The
// existing config-repository.js may be expanded where appropriate") rather
// than a second, parallel implementation living under dashboard/.
const configRepo = require('../dubai-lead-matching-service/src/repositories/config-repository');
const configValidation = require('../dubai-lead-matching-service/src/config/config-validation');

module.exports = { ...configRepo, ...configValidation };
