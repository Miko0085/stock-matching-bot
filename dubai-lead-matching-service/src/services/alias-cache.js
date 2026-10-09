'use strict';

// A safe, TTL-bounded alias cache (TZ 102: "Alias cache допустим только с
// безопасным TTL/invalidation"). Concurrent requests during a refresh share
// the same in-flight promise instead of each triggering their own DB
// round-trip (no thundering herd), and nothing here is process-wide mutable
// state that a request could race incorrectly -- a stale read is bounded
// by `ttlMs`, never unbounded.
function createAliasCache({ loader, ttlMs = 60_000, now = () => Date.now() }) {
  let cached = null;
  let cachedAt = 0;
  let inFlight = null;

  async function get() {
    if (cached && now() - cachedAt < ttlMs) return cached;
    if (inFlight) return inFlight;

    inFlight = loader()
      .then((value) => {
        cached = value;
        cachedAt = now();
        return value;
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  }

  function invalidate() {
    cached = null;
    cachedAt = 0;
  }

  return { get, invalidate };
}

module.exports = { createAliasCache };
