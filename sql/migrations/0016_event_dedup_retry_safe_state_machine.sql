-- P0.3 release blocker fix (additive, backward-compatible): the previous
-- matching.processed_events design (migration 0015) was a single atomic
-- INSERT ... ON CONFLICT DO NOTHING with no notion of outcome. That is
-- correct for "have we ever seen this event" but dangerous for "did we
-- ever actually FINISH it": if the pipeline recorded the event and then
-- failed (AI timeout, DB error, process crash) before a durable business
-- outcome (a match_runs row) existed, a worker retry of the identical
-- webhook would be treated as an already-processed duplicate and the
-- message would be silently lost forever.
--
-- Adds a lease/state-machine: PROCESSING (claimed, in flight) ->
-- COMPLETED (a durable outcome exists) or FAILED_RETRYABLE (processing
-- raised, safe to retry immediately). A stale PROCESSING claim (the
-- process died mid-request, no FAILED_RETRYABLE was ever written) is
-- reclaimable once its lease expires, so a crash can never permanently
-- consume an event either.
ALTER TABLE matching.processed_events ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'COMPLETED';
ALTER TABLE matching.processed_events ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE matching.processed_events ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE matching.processed_events ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'processed_events_status_check'
  ) THEN
    ALTER TABLE matching.processed_events
      ADD CONSTRAINT processed_events_status_check
      CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED_RETRYABLE'));
  END IF;
END $$;

-- Pre-existing rows (from before this migration) predate the state
-- machine entirely -- they were only ever written after successful
-- processing under the old design, so backfilling them as COMPLETED
-- (the column default above) is accurate, not a guess.
