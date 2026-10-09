-- Nika Matching V2 simplification, Phase 2 (AGENTS_NIKA_MATCHING_V2.md
-- section 26, Phase 2): a single-row draft workspace for the Settings UI's
-- draft -> Apply workflow. Additive only -- does not touch
-- matching.runtime_settings / matching.intake_rules / matching.config_versions
-- (migration 0020), and nothing in the runtime pipeline reads this table
-- either.
--
-- Design: individual UI edits (toggle a setting, add/edit/delete a rule)
-- write ONLY to this draft row's JSONB columns -- never directly to
-- matching.runtime_settings/intake_rules. Only "Apply Configuration"
-- atomically writes the real mutable tables and creates a new
-- matching.config_versions snapshot (see config-repository.js's
-- applyDraft()). This is what makes "operator makes several edits, sees
-- them as unsaved, then Applies" possible with a plain server-rendered
-- page and no client-side state management.
--
-- Singleton by design (id is always 1, enforced by the CHECK below) --
-- this is a single-operator internal control plane, not a multi-user
-- editor; a real multi-draft/multi-user model is out of scope for Phase 2.
CREATE TABLE IF NOT EXISTS matching.config_draft (
  id INTEGER PRIMARY KEY DEFAULT 1,
  settings JSONB NOT NULL DEFAULT '[]'::jsonb,
  intake_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
  based_on_version INTEGER,
  is_dirty BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT config_draft_singleton CHECK (id = 1)
);
