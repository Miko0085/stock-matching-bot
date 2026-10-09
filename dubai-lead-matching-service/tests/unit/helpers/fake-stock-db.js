'use strict';

// A tiny in-memory interpreter for the exact, small set of SQL condition
// shapes matching/candidate-query.js produces -- lets matcher.test.js
// exercise the real orchestration logic (matcher.js) against a plain JS
// array instead of a real Postgres connection, while still going through
// the actual generated SQL/params (not a shortcut that bypasses
// candidate-query.js entirely). Intentionally narrow: if candidate-query.js
// ever emits a condition shape this doesn't recognize, these tests fail
// loudly rather than silently matching everything -- a deliberate tripwire
// against drift between the two.
const CONDITION_MATCHERS = [
  { re: /^status = 'ACTIVE'$/, apply: (row) => row.status === 'ACTIVE' },
  { re: /^transaction_type = \$(\d+)$/, apply: (row, m, params) => row.transaction_type === params[Number(m[1]) - 1] },
  { re: /^lower\(building\) = lower\(\$(\d+)\)$/, apply: (row, m, params) => String(row.building || '').toLowerCase() === String(params[Number(m[1]) - 1]).toLowerCase() },
  { re: /^lower\(project_community\) = lower\(\$(\d+)\)$/, apply: (row, m, params) => String(row.project_community || '').toLowerCase() === String(params[Number(m[1]) - 1]).toLowerCase() },
  { re: /^lower\(area\) = lower\(\$(\d+)\)$/, apply: (row, m, params) => String(row.area || '').toLowerCase() === String(params[Number(m[1]) - 1]).toLowerCase() },
  // Multi-area OR semantics (spec sections 10-17): `area = ANY(ARRAY[...])`.
  {
    re: /^lower\(area\) = ANY\(ARRAY\[(lower\(\$\d+\)(?:, lower\(\$\d+\))*)\]\)$/,
    apply: (row, m, params) => {
      const indexes = [...m[1].matchAll(/\$(\d+)/g)].map((mm) => Number(mm[1]) - 1);
      const rowArea = String(row.area || '').toLowerCase();
      return indexes.some((i) => rowArea === String(params[i]).toLowerCase());
    },
  },
  { re: /^lower\(property_type\) = lower\(\$(\d+)\)$/, apply: (row, m, params) => String(row.property_type || '').toLowerCase() === String(params[Number(m[1]) - 1]).toLowerCase() },
  { re: /^selling_price <= \$(\d+)$/, apply: (row, m, params) => Number(row.selling_price) <= params[Number(m[1]) - 1] },
  { re: /^selling_price >= \$(\d+)$/, apply: (row, m, params) => Number(row.selling_price) >= params[Number(m[1]) - 1] },
  { re: /^bedrooms >= \$(\d+)$/, apply: (row, m, params) => row.bedrooms !== null && row.bedrooms >= params[Number(m[1]) - 1] },
  { re: /^bedrooms <= \$(\d+)$/, apply: (row, m, params) => row.bedrooms !== null && row.bedrooms <= params[Number(m[1]) - 1] },
  { re: /^bathrooms >= \$(\d+)$/, apply: (row, m, params) => Number.isFinite(Number(row.bathrooms)) && Number(row.bathrooms) >= params[Number(m[1]) - 1] },
  { re: /^bathrooms <= \$(\d+)$/, apply: (row, m, params) => Number.isFinite(Number(row.bathrooms)) && Number(row.bathrooms) <= params[Number(m[1]) - 1] },
  { re: /^size_sqft >= \$(\d+)$/, apply: (row, m, params) => Number.isFinite(Number(row.size_sqft)) && Number(row.size_sqft) >= params[Number(m[1]) - 1] },
  { re: /^size_sqft <= \$(\d+)$/, apply: (row, m, params) => Number.isFinite(Number(row.size_sqft)) && Number(row.size_sqft) <= params[Number(m[1]) - 1] },
  { re: /^plot_size_sqft >= \$(\d+)$/, apply: (row, m, params) => Number.isFinite(Number(row.plot_size_sqft)) && Number(row.plot_size_sqft) >= params[Number(m[1]) - 1] },
  { re: /^plot_size_sqft <= \$(\d+)$/, apply: (row, m, params) => Number.isFinite(Number(row.plot_size_sqft)) && Number(row.plot_size_sqft) <= params[Number(m[1]) - 1] },
  { re: /^lower\(furnishing\) = lower\(\$(\d+)\)$/, apply: (row, m, params) => String(row.furnishing || '').toLowerCase() === String(params[Number(m[1]) - 1]).toLowerCase() },
];

function makeFakeStockDb(rows) {
  return {
    async fetchCandidates(sql, params) {
      const whereClause = sql.split('WHERE ')[1];
      const conditions = whereClause.split(' AND ');
      return rows.filter((row) =>
        conditions.every((cond) => {
          const matcher = CONDITION_MATCHERS.find((c) => c.re.test(cond));
          if (!matcher) throw new Error(`fake-stock-db: unrecognized SQL condition "${cond}"`);
          return matcher.apply(row, cond.match(matcher.re), params);
        })
      );
    },
    async checkLocationExists(sql, params) {
      const anyMatch = sql.match(/lower\((\w+)\) = ANY\(ARRAY\[([^\]]+)\]\)/);
      if (anyMatch) {
        const column = anyMatch[1];
        return rows.some((row) =>
          params.some((param) => String(row[column] || '').toLowerCase() === String(param).toLowerCase())
        );
      }
      const columnMatch = sql.match(/lower\((\w+)\) = lower\(\$1\)/);
      const column = columnMatch[1];
      return rows.some((row) => String(row[column] || '').toLowerCase() === String(params[0]).toLowerCase());
    },
  };
}

module.exports = { makeFakeStockDb };
