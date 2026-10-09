-- Per-request OpenAI token/cost tracking for the dashboard's "AI Usage"
-- view. OpenAI exposes no API for a project's remaining $ balance, so this
-- tracks actual spend incurred by our own pipeline instead: every
-- chat/completions response already carries a `usage` object, priced here
-- against a hand-maintained rate table (src/core/ai-usage.js) since OpenAI
-- doesn't expose its own pricing via API either.
CREATE TABLE IF NOT EXISTS matching.ai_usage_log (
  id BIGSERIAL PRIMARY KEY,
  source_message_id TEXT,
  model TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  estimated_cost_usd NUMERIC(12, 6),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_usage_log_created_at_idx ON matching.ai_usage_log (created_at);
