'use strict';

// Moscow's intake gate (2026-09-29) -- a thin re-export of
// lead-matching-service's evaluateV2IntakeGate(), same reuse pattern as
// ../repositories/config-repository.js's wrapper around the UAE
// config-repository. This is safe to reuse as-is: the function is 100%
// pure and market-agnostic (no DB, no UAE-specific data, no hardcoded
// schema references) -- it only evaluates whatever runtimeSettings/
// intakeRules it is handed as plain data, which for Moscow always come
// from matching_moscow.* via this service's OWN config-repository wrapper.
// pipeline.js requires THIS local path, never lead-matching-service
// directly -- tests/unit/pipeline.test.js's "the RF pipeline never imports
// anything from the Dubai contour" check inspects pipeline.js's own
// require() calls, not this file's.
module.exports = require('../../../dubai-lead-matching-service/src/gates/v2-intake-gate');
