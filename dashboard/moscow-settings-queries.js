'use strict';

// Thin re-export of rf-lead-matching-service's config-repository.js
// (matching_moscow.*) -- same "no config logic of its own" pattern as
// dashboard/settings-queries.js's own re-export of dubai-lead-matching-service's
// UAE config-repository.js. See that module's header and
// rf-lead-matching-service/src/repositories/config-repository.js's header
// for why this is one shared implementation bound to a different schema,
// not a second copy of the draft/Apply/rollback logic.
const configRepo = require('../rf-lead-matching-service/src/repositories/config-repository');
const configValidation = require('../dubai-lead-matching-service/src/config/config-validation');

module.exports = { ...configRepo, ...configValidation };
