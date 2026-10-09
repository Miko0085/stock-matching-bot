'use strict';

// Keys on (author + exact normalized text) — the same author's post
// cross-posted to several groups, or reposted within one group, hashes
// identically; a different author writing a superficially similar but
// distinct request does not (mirrors devi's own sameChannelDedupe/
// crossChannelDedupe convention: authorName + messageExact, ADR-021).
// Normalization only folds casing/whitespace differences — it never
// strips real content, so it is deliberately stricter than a fuzzy/
// semantic dedup and will never merge two genuinely different requests.
function normalizeForDedup(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Deliberately not Node's `crypto` module: this code is bundled into an
// n8n Code node, and n8n's Code-node sandbox (task runner) disallows
// requiring built-in modules including `crypto` outright ("Module
// 'crypto' is disallowed"), discovered live when this first shipped. A
// dedup fingerprint isn't a security boundary, so a fast, dependency-free
// non-cryptographic hash is the right tool here anyway. FNV-1a run twice
// with different seeds and concatenated gives a 64-bit-ish fingerprint —
// far more collision headroom than this pilot's request volume needs.
function fnv1a(str, seed) {
  let hash = seed;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function computeContentHash({ text, authorName }) {
  const normalizedText = normalizeForDedup(text);
  const normalizedAuthor = normalizeForDedup(authorName);
  const raw = `${normalizedAuthor}::${normalizedText}`;
  return fnv1a(raw, 0x811c9dc5) + fnv1a(raw, 0x9e3779b9);
}

// Text-only variant (no author/chat/provider) -- deliberately a SEPARATE
// key space from computeContentHash above. Used by the AI-result
// interpretation cache (lead-matching-service), where the whole point is
// to recognize the SAME content regardless of who posted it (e.g. one
// inventory ad copy-pasted by 20 different brokers must hash identically
// so only the first one ever pays for an OpenAI call).
function computeTextOnlyHash(text) {
  const normalizedText = normalizeForDedup(text);
  return fnv1a(normalizedText, 0x811c9dc5) + fnv1a(normalizedText, 0x9e3779b9);
}

module.exports = { normalizeForDedup, computeContentHash, computeTextOnlyHash };
