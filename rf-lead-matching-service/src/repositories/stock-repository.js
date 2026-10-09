'use strict';

// Moscow's own stock-query executor -- BY ANALOGY with lead-matching-
// service/src/repositories/stock-repository.js's thin "only knows HOW to
// ask Postgres" contract: candidate-query.js decides WHAT to ask for,
// this module runs it. New code (not a wrapper) since the target
// schema/table shape differs.
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
        `SELECT (SELECT completed_at FROM matching_moscow.stock_sync_runs WHERE status = 'SUCCESS' ORDER BY completed_at DESC LIMIT 1) AS completed_at`
      );
      return rows[0]?.completed_at || null;
    },
    async getActiveStockCount() {
      const { rows } = await pool.query(`SELECT count(*)::int AS count FROM matching_moscow.stock_inventory WHERE available = true`);
      return rows[0]?.count ?? 0;
    },
  };
}

module.exports = { makeStockRepository };
