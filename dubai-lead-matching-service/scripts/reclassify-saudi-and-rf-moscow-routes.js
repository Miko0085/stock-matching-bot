'use strict';

// One-time reclassification (2026-09-27), per explicit operator decision:
//   1. Real Saudi Arabia sources, previously folded into route_mode='UAE'
//      for lack of any other bucket, move to the new 'SAUDI' label
//      (migration 0024). Never a saudi-lead-matching-service decision --
//      just a correct catalog label, exactly like RF's own bootstrap.
//   2. Real Moscow-region residential/classifieds sources (found on
//      nikaestate_ae after it joined ~340 groups) move to 'RF' -- there is
//      still no live RF matcher, so this only tags them correctly for
//      whenever one exists; it does not turn on any processing today
//      (src/gates/source-routing.js already rejects RF/SAUDI routes).
//
// Only ever touches a row that is NOT already manual_override=true with a
// DIFFERENT route than the one being assigned here -- never silently
// overwrites a distinct operator decision made after this script's own
// keyword match was written.
//
// Usage:
//   node scripts/reclassify-saudi-and-rf-moscow-routes.js           (dry run)
//   node scripts/reclassify-saudi-and-rf-moscow-routes.js --apply

require('dotenv').config();
const { Pool } = require('pg');

const SAUDI_RE = /саудов|saudi|эр-?рияд|riyadh|джидда|jeddah|мекк|mecca|медин|medina|дамма?м|dammam/i;

// Deliberately NOT using generic signals like "барахолк" (flea-market/
// classifieds groups exist for every city, not just Moscow -- caught a
// literal "Барахолка Дубай" group in dry-run testing), "школ" (schools,
// not real estate), or "г.о." (too generic an abbreviation, caught a cat
// shelter's "г. Балашиха" by accident). "ЖК " (жилой комплекс / residential
// complex) is the strongest real-estate-specific signal and carries most
// of the match volume on its own; the rest is explicit Moscow-region place
// names actually observed in the real catalog.
const RF_MOSCOW_RE = /жк\s|москв|подольск|мытищ|балашиха|домодедов|люберц|жуков[а-я]*ий\b|лобн[яа]|пушкин[оа]|краснодар|\bсочи\b|салар|коломна|щ[её]лково|звенигород|\bдубна\b|раменск|химки|красногорск|одинцово|долгопрудн|ивантеевк|королёв|королев\b/i;

async function reclassify(pool, { label, regex, targetRoute, apply, excludeRegex }) {
  const { rows } = await pool.query(
    `SELECT s.id, s.account_id, s.name, sr.route_mode, sr.manual_override
     FROM ingest.sources s
     JOIN ingest.source_routes sr ON sr.source_id = s.id
     WHERE s.provider = 'telegram'`
  );
  const matches = rows.filter((r) => regex.test(r.name || '') && !(excludeRegex && excludeRegex.test(r.name || '')));
  const toChange = matches.filter((r) => r.route_mode !== targetRoute);

  console.log(`\n[${label}] ${matches.length} name matches, ${toChange.length} need route -> ${targetRoute}`);
  for (const r of toChange) {
    console.log(`  - ${apply ? 'SET' : 'WOULD SET'} [${r.account_id}] "${r.name}" (was ${r.route_mode}, manual_override=${r.manual_override}) -> ${targetRoute}`);
  }

  if (apply && toChange.length) {
    await pool.query(
      `UPDATE ingest.source_routes SET route_mode = $2, updated_by = 'reclassify-2026-09-27', notes = COALESCE(notes, '') || $3
       WHERE source_id = ANY($1)`,
      [toChange.map((r) => r.id), targetRoute, ` Reclassified ${targetRoute} by name-keyword review, 2026-09-27.`]
    );
    console.log(`[${label}] applied ${toChange.length} update(s).`);
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  await reclassify(pool, { label: 'Saudi Arabia', regex: SAUDI_RE, targetRoute: 'SAUDI', apply });
  // excludeRegex: a name matching both patterns (e.g. a Saudi-market group
  // that happens to use the word "барахолка") stays SAUDI -- the Saudi
  // pass above already handles it, this pass must not reclassify it again.
  await reclassify(pool, { label: 'Moscow region (RF)', regex: RF_MOSCOW_RE, targetRoute: 'RF', apply, excludeRegex: SAUDI_RE });

  await pool.end();
  if (!apply) console.log('\nDry run only -- re-run with --apply to write these changes.');
}

main().catch((e) => { console.error(e); process.exit(1); });
