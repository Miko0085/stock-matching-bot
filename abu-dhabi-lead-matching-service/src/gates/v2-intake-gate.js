'use strict';

// Abu Dhabi's intake gate -- a thin re-export of dubai-lead-matching-
// service's evaluateV2IntakeGate(), same reuse pattern as
// ../repositories/config-repository.js's wrapper around Dubai's
// config-repository. This is safe to reuse as-is: the function is 100%
// pure and market-agnostic (no DB, no Dubai-specific data, no hardcoded
// schema references) -- it only evaluates whatever runtimeSettings/
// intakeRules it is handed as plain data, which here always come from
// matching_abu_dhabi.* via this service's OWN config-repository wrapper.
// pipeline.js requires THIS local path, never dubai-lead-matching-service
// directly -- tests/unit/pipeline.test.js's "the pipeline never imports
// anything from the Dubai contour" check inspects pipeline.js's own
// require() calls, not this file's.
module.exports = require('../../../dubai-lead-matching-service/src/gates/v2-intake-gate');
