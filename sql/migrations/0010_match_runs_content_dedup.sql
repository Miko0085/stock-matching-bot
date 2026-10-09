-- Content-based dedup for the matching pilot's own webhook, independent of
-- production monitoring's dedup (which lives on a parallel branch that
-- Explode Raw Leads for Matching Pilot never goes through — see
-- docs/DECISIONS.md ADR-021). The same buyer post cross-posted to several
-- groups, or reposted within one group, previously ran the full AI-parse +
-- match + Telegram pipeline again for every repost.
ALTER TABLE matching.match_runs ADD COLUMN IF NOT EXISTS content_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_match_runs_content_hash_created_at
  ON matching.match_runs (content_hash, created_at DESC);
