-- Normalization aliases synchronized from the "Aliases" Google Sheet.
-- Exact lookup only — no fuzzy matching.
CREATE TABLE IF NOT EXISTS matching.matching_aliases (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  alias TEXT NOT NULL,
  alias_normalized TEXT NOT NULL,
  canonical TEXT NOT NULL,
  canonical_normalized TEXT,
  parent_area TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'matching_aliases_type_alias_normalized_key'
  ) THEN
    ALTER TABLE matching.matching_aliases
      ADD CONSTRAINT matching_aliases_type_alias_normalized_key UNIQUE (type, alias_normalized);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_matching_aliases_type_enabled
  ON matching.matching_aliases (type, enabled);
