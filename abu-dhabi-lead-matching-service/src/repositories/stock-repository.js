'use strict';

// Executes the SQL that matching/candidate-query.js builds (a pure
// function) -- this is the only place in the service that actually runs a
// stock query against Postgres. Deliberately thin: the matcher decides
// WHAT to ask for, this module only knows HOW to ask Postgres for it (TZ
// 100: no "load everything, filter in Node" anti-pattern).
function makeStockRepository(pool) {
  return {
    async fetchCandidates(sql, params) {
      const { rows } = await pool.query(sql, params);
      return rows;
    },
    async checkLocationExists(sql, params) {
      const { rows } = await pool.query(sql, params);
      return rows.length > 0;
    },
    async getLatestStockSyncedAt() {
      const { rows } = await pool.query(
        `SELECT (SELECT completed_at FROM matching_abu_dhabi.stock_sync_runs WHERE status = 'SUCCESS' ORDER BY completed_at DESC LIMIT 1) AS completed_at`
      );
      return rows[0]?.completed_at || null;
    },
    async getActiveStockCount() {
      const { rows } = await pool.query(`SELECT count(*)::int AS count FROM matching_abu_dhabi.stock_inventory WHERE status = 'ACTIVE'`);
      return rows[0]?.count ?? 0;
    },
    // Feeds the canonical-registry layer of location-dictionary.js (spec
    // section 6-8). Deliberately ALL rows, not just ACTIVE -- this is a
    // naming registry ("is this a real location we know about at all"),
    // not an availability check, so a name that only ever appeared on a
    // currently-INACTIVE row must still be recognized as known.
    async getDistinctLocationRows() {
      const { rows } = await pool.query(
        `SELECT DISTINCT area, project_community, building FROM matching_abu_dhabi.stock_inventory`
      );
      return rows;
    },
  };
}

module.exports = { makeStockRepository };
