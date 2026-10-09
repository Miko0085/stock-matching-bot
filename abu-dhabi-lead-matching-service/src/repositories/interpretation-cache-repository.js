'use strict';

// Moscow's own interpretation cache -- BY ANALOGY with lead-matching-
// service/src/repositories/interpretation-cache-repository.js's (text_hash,
// interpreter_version) keying (bumping config.parserVersion naturally
// invalidates the whole cache), targeting matching_abu_dhabi.
// message_interpretation_cache (migration 0018 -- "same shape as
// matching_dubai.message_interpretation_cache", reserved from day one, never
// written to until now).

async function findInterpretation(pool, { textHash, interpreterVersion, ttlDays }) {
  const { rows } = await pool.query(
    `SELECT interpretation_source, message_class, demand_owner, promotion, spam, parsed_request
     FROM matching_abu_dhabi.message_interpretation_cache
     WHERE text_hash = $1
       AND interpreter_version = $2
       AND last_seen_at > now() - ($3 || ' days')::interval`,
    [textHash, interpreterVersion, ttlDays]
  );
  if (rows.length === 0) return null;

  try {
    await pool.query(
      `UPDATE matching_abu_dhabi.message_interpretation_cache
       SET hit_count = hit_count + 1, last_seen_at = now()
       WHERE text_hash = $1 AND interpreter_version = $2`,
      [textHash, interpreterVersion]
    );
  } catch {
    // best-effort only
  }

  return rows[0];
}

async function recordInterpretation(pool, {
  textHash,
  interpreterVersion,
  normalizedText,
  interpretationSource,
  messageClass,
  demandOwner,
  promotion,
  spam,
  parsedRequest,
}) {
  await pool.query(
    `INSERT INTO matching_abu_dhabi.message_interpretation_cache (
       text_hash, interpreter_version, normalized_text, interpretation_source,
       message_class, demand_owner, promotion, spam, parsed_request
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (text_hash, interpreter_version) DO UPDATE SET
       normalized_text = EXCLUDED.normalized_text,
       interpretation_source = EXCLUDED.interpretation_source,
       message_class = EXCLUDED.message_class,
       demand_owner = EXCLUDED.demand_owner,
       promotion = EXCLUDED.promotion,
       spam = EXCLUDED.spam,
       parsed_request = EXCLUDED.parsed_request,
       last_seen_at = now(),
       hit_count = matching_abu_dhabi.message_interpretation_cache.hit_count + 1`,
    [
      textHash,
      interpreterVersion,
      normalizedText,
      interpretationSource,
      messageClass,
      demandOwner,
      promotion,
      spam,
      JSON.stringify(parsedRequest ?? null),
    ]
  );
}

module.exports = { findInterpretation, recordInterpretation };
