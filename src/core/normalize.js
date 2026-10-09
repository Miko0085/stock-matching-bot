'use strict';

// Deterministic text normalization shared by alias lookup and stock/request
// comparison. Kept dependency-free so it can be inlined verbatim into an n8n
// Code node.

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

// Alias keys strip punctuation that carries no meaning ("M.J.L" / "M-J-L" /
// "m_j_l" must all resolve to the same alias key) while leaving letters and
// digits untouched so "P4" stays distinguishable from "P 4".
function normalizeAliasKey(value) {
  const text = normalizeText(value);
  return text.replace(/[.\-_]/g, '').replace(/\s+/g, '');
}

function normalizeBedrooms(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const text = normalizeText(value);
  if (text === 'studio' || text === '0' || text === 'st') return 0;
  const match = text.match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

function bedroomsLabel(bedrooms) {
  if (bedrooms === null || bedrooms === undefined) return null;
  if (bedrooms === 0) return 'Studio';
  return `${bedrooms} BR`;
}

module.exports = {
  normalizeText,
  normalizeAliasKey,
  normalizeBedrooms,
  bedroomsLabel,
};
