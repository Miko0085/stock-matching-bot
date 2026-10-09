-- One row per Stock Sync workflow run (scheduled or manual).
CREATE TABLE IF NOT EXISTS matching.stock_sync_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  stock_rows_read INTEGER,
  stock_rows_active INTEGER,
  alias_rows_read INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_stock_sync_runs_started_at
  ON matching.stock_sync_runs (started_at DESC);
