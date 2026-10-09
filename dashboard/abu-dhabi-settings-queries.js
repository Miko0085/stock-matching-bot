'use strict';

// Thin re-export of abu-dhabi-lead-matching-service's config-repository.js
// (matching_abu_dhabi.*) -- same "no config logic of its own" pattern as
// dashboard/moscow-settings-queries.js's own re-export for RF. See that
// module's header and abu-dhabi-lead-matching-service/src/repositories/
// config-repository.js's header for why this is one shared implementation
// (ultimately dubai-lead-matching-service's own draft/Apply/rollback code)
// bound to a different schema, not a second copy of that logic.
const configRepo = require('../abu-dhabi-lead-matching-service/src/repositories/config-repository');
const configValidation = require('../dubai-lead-matching-service/src/config/config-validation');

module.exports = { ...configRepo, ...configValidation };
