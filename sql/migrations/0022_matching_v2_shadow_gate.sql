-- Nika Matching V2 simplification, Phase 3 (AGENTS_NIKA_MATCHING_V2.md
-- section 26, Phase 3): additive persistence for SHADOW evaluations of the
-- future deterministic intake gate. Purely observational -- nothing reads
-- this table to make a live routing decision, and this migration does not
-- alter any existing table's semantics.
--
-- Deliberately does NOT duplicate the raw message text: `source_message_id`
-- lets a shadow row be joined back to the real, already-durable
-- matching.match_runs row (original_text lives there); `message_text_hash`
-- (the same content-only hash content-dedup.js already computes) is stored
-- for content-level joins/dedup analysis without a second copy of PII.
CREATE TABLE IF NOT EXISTS matching.shadow_gate_evaluations (
  id BIGSERIAL PRIMARY KEY,
  source_message_id TEXT NOT NULL,
  provider TEXT,
  account_id TEXT,
  chat_id TEXT,
  sender_id TEXT,
  message_text_hash TEXT,

  -- Normalized old (CURRENT production) decision -- see
  -- shadow-evaluator.js's normalizeOldDecision() for the exact mapping.
  -- old_decision in ('SEND_TO_AI','CACHE_HIT_AI','PARSED_LOCALLY','REJECT_WITHOUT_AI','DUPLICATE','ERROR','UNKNOWN')
  old_decision TEXT NOT NULL,
  old_reason TEXT,

  -- V2 shadow gate decision (matching/gates/v2-intake-gate.js), never
  -- authoritative.
  -- v2_decision in ('SEND_TO_AI','REJECT','DUPLICATE')
  v2_decision TEXT NOT NULL,
  v2_reason TEXT,

  blacklist_hits JSONB NOT NULL DEFAULT '[]'::jsonb,
  whitelist_hits JSONB NOT NULL DEFAULT '[]'::jsonb,
  property_signal_hits JSONB NOT NULL DEFAULT '[]'::jsonb,
  send_to_ai_hits JSONB NOT NULL DEFAULT '[]'::jsonb,

  whitelist_threshold INTEGER,
  property_signal_threshold INTEGER,

  -- Attribution to the EXACT active config version at evaluation time
  -- (spec section 12) -- a later Apply must never retroactively change
  -- what an old shadow row is attributed to. Nullable: a DUPLICATE
  -- shortcut (see shadow-evaluator.js) never loads config at all, so has
  -- no version to attribute to.
  config_version_id BIGINT REFERENCES matching.config_versions(id),

  disagreement BOOLEAN NOT NULL DEFAULT false,
  projected_ai_saved BOOLEAN NOT NULL DEFAULT false,
  projected_ai_added BOOLEAN NOT NULL DEFAULT false,

  -- true only for a row produced by an explicit, deliberately-run
  -- historical backfill (spec section 16) using already-stored message
  -- text and a fixed time range -- never AI, never a rolling NOW(). false
  -- for every row produced by live shadow instrumentation.
  backfilled BOOLEAN NOT NULL DEFAULT false,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shadow_gate_created_at ON matching.shadow_gate_evaluations (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_gate_source_message ON matching.shadow_gate_evaluations (source_message_id);
CREATE INDEX IF NOT EXISTS idx_shadow_gate_disagreement ON matching.shadow_gate_evaluations (disagreement) WHERE disagreement = true;
