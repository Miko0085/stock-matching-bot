'use strict';

async function startRun(client) {
  const { rows } = await client.query(
    `INSERT INTO matching_dubai.stock_sync_runs (status) VALUES ('RUNNING') RETURNING id, started_at`
  );
  return rows[0];
}

async function completeRun(client, id, { status, stockRowsRead, stockRowsActive, aliasRowsRead, error = null }) {
  await client.query(
    `UPDATE matching_dubai.stock_sync_runs SET
       completed_at = now(),
       status = $2,
       stock_rows_read = $3,
       stock_rows_active = $4,
       alias_rows_read = $5,
       error = $6
     WHERE id = $1`,
    [id, status, stockRowsRead, stockRowsActive, aliasRowsRead, error]
  );
}

async function getLatestSuccessfulSync(client) {
  const { rows } = await client.query(
    `SELECT completed_at FROM matching_dubai.stock_sync_runs WHERE status = 'SUCCESS' ORDER BY completed_at DESC LIMIT 1`
  );
  return rows[0] ? rows[0].completed_at : null;
}

module.exports = { startRun, completeRun, getLatestSuccessfulSync };
