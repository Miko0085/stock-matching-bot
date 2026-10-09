'use strict';

const { normalizePhoneDigits } = require('./phone-normalize');

// Groups stock_inventory rows ({stock_id, broker, broker_contact}) by the
// broker_contact's normalized phone -- the real identity key, since
// stock_inventory.broker_id is unpopulated in production and broker is
// free text (confirmed: the same phone sometimes appears under more than
// one display name, e.g. "Pavel Goss" / "Павел Nika Estate"). Rows whose
// broker_contact has no digits at all (never seen in production, but not
// assumed impossible) are returned separately as `skipped`, never silently
// dropped.
function groupStockContactsByPhone(rows) {
  const groups = new Map();
  const skipped = [];
  for (const row of rows) {
    const normalized = normalizePhoneDigits(row.broker_contact);
    if (!normalized) {
      skipped.push(row);
      continue;
    }
    if (!groups.has(normalized)) {
      groups.set(normalized, { normalizedPhone: normalized, stockIds: [], names: new Set() });
    }
    const group = groups.get(normalized);
    group.stockIds.push(row.stock_id);
    const name = (row.broker || '').trim();
    if (name) group.names.add(name);
  }
  return { groups: Array.from(groups.values()), skipped };
}

// Chooses one canonical display name from every free-text `broker` value
// seen for one phone. A name containing at least one non-digit/punctuation
// character is preferred over a bare phone-number-as-name row (production
// has both: some rows literally repeat the phone in the `broker` column);
// among real names the longest is chosen as a simple, deterministic
// tie-break. Returns null only when every row for this phone had an empty
// `broker` field -- callers should fall back to the phone itself in that
// case, not treat it as an error.
function chooseDisplayName(names) {
  const list = Array.from(names);
  if (list.length === 0) return null;
  const real = list.filter((n) => /[^\d\s+().-]/.test(n));
  const pool = real.length > 0 ? real : list;
  return pool.reduce((best, n) => (n.length > best.length ? n : best), pool[0]);
}

module.exports = { groupStockContactsByPhone, chooseDisplayName };
