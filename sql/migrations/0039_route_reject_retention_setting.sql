-- Adds an operator-configurable retention window for pure route-gate
-- "noise" rows in match_runs (2026-10-06 finding: RF's match_runs had
-- accumulated 119k REJECTED rows in one week, 99.99% of them just the
-- shared fan-out ingress's other-market traffic being correctly rejected
-- by RF's own source-routing gate -- zero debugging value once confirmed,
-- see src/db/route-reject-cleanup.js for the full explanation and the
-- actual cleanup logic this setting drives).
--
-- Same value/shape in all three live contours' runtime_settings so the
-- Settings UI can expose one consistent control per market
-- (/settings?market=uae|moscow|abu_dhabi) -- NOT a shared table (each
-- schema gets its own row), per AGENTS.md section 0.
--
-- Default 7 days (user's explicit choice). 0 (or any non-positive value)
-- disables automatic cleanup entirely -- the cleanup job
-- (scheduleRouteRejectCleanup) treats that as "do nothing", never as "no
-- retention, delete everything every run".

INSERT INTO matching_dubai.runtime_settings (key, value_type, value_text, updated_by)
VALUES ('route_reject_retention_days', 'integer', '7', 'migration:0039')
ON CONFLICT (key) DO NOTHING;

INSERT INTO matching_moscow.runtime_settings (key, value_type, value_text, updated_by)
VALUES ('route_reject_retention_days', 'integer', '7', 'migration:0039')
ON CONFLICT (key) DO NOTHING;

INSERT INTO matching_abu_dhabi.runtime_settings (key, value_type, value_text, updated_by)
VALUES ('route_reject_retention_days', 'integer', '7', 'migration:0039')
ON CONFLICT (key) DO NOTHING;
