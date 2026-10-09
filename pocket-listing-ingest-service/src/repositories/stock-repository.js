'use strict';

// Thin wrapper over the EXISTING src/db/stockRepository.js -- no stock-
// write logic is duplicated here. This service is just another caller of
// it, same as scripts/dubai-pocket-stock-import-run.js already is.
const { upsertStockRows } = require('../../../src/db/stockRepository');

module.exports = { upsertStockRows };
