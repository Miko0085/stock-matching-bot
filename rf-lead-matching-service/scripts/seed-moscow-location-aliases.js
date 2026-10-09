'use strict';

// Seeds matching_moscow.location_aliases (migration 0025/0032) so buyer
// shorthand resolves to the exact canonical district/complex string stored
// on matching_moscow.stock_inventory (AGENTS.md section 8: normalize ->
// exact alias lookup -> canonical -> deterministic matching, never fuzzy).
//
// Three sources, all grounded in the REAL stock actually visible at
// /stock?market=moscow (the user's own instruction, 2026-09-29) -- never a
// blind/guessed list:
//
// 1. Self-mined complex aliases: joker-normalize.js keeps a Russian
//    transliteration inline in parentheses on the canonical `complex` value
//    itself (e.g. canonical = "Wine House (Вайн Хаус)"). A buyer who types
//    only "Вайн Хаус" or only "Wine House" would NOT exact-match that
//    canonical string without an alias -- this script queries every real
//    complex_raw/complex pair with a parenthetical and derives both halves
//    as aliases pointing at the one real canonical value.
//
// 2. `district` in this schema is RAION-level, not okrug-level (a live
//    audit here found real district values like "Хамовники"/"Пресненский"/
//    "Раменки", never "ЦАО"/"САО" -- Joker does not tag stock by okrug at
//    all), so seeding the 12 okrug abbreviations as district aliases would
//    be pointless. Instead this seeds the small set of well-known raion
//    name variants that actually differ from the stored spelling (a leading
//    "р-н"/"район" a buyer might type, or a common short form) -- left
//    intentionally short; AGENTS.md section 8's own closing rule applies
//    ("unknown alias should be diagnosable from match_runs and later added
//    to the Aliases sheet"), not "guess every possible synonym up front."
//
// 3. Excel cross-reference (2026-09-29): the user supplied an independently
//    hand-verified audit of 1625 Moscow-region Telegram groups
//    (`Telegram_чаты_Москва_с_округами.xlsx`, "Москва_с_округами" sheet),
//    1521 confirmed real city-of-Moscow groups each with a canonical
//    project name ("Совпавший проект/алиас"). Cross-referencing its 514
//    unique canonical names against real `stock_inventory.complex` found
//    69 direct matches; 4 were excluded from this list after manual review:
//    "Headliner"/"Жилой квартал Lucky"/"RED7" each turned out to have TWO
//    inconsistent real stock `complex` spellings (with vs without a
//    parenthetical transliteration) for what looks like the same physical
//    building -- a genuine Joker-sync data-quality gap (not something an
//    alias can safely resolve in one direction), left unfixed and flagged
//    in docs/DECISIONS.md rather than silently guessed. "Rotterdam"'s real
//    stock value contains a leading invisible LRM character that could not
//    be reliably hand-transcribed byte-for-byte, so it was left out rather
//    than risk a canonical string that silently fails to match.
//
// Usage:
//   node scripts/seed-moscow-location-aliases.js           (dry run, prints what it would insert)
//   node scripts/seed-moscow-location-aliases.js --apply   (actually writes)

require('dotenv').config();
const { Pool } = require('pg');

// Well-known Moscow raion name variants actually confirmed against the real
// `matching_moscow.stock_inventory.district` values (2026-09-29 audit) --
// each canonical value below is the EXACT stored spelling, not a guess.
const DISTRICT_ALIASES = [
  { alias: 'Хорошево-Мневники', canonical: 'Хорошёво-Мневники' }, // ё/е spelling variant, a common typing shortcut
  { alias: 'Хорошевский', canonical: 'Хорошёвский' },
  { alias: 'Северо-Запад', canonical: 'Северо-западный' },
  // Okrug-level aliases (2026-09-29): for these 7 okrugs, Joker itself
  // sometimes tags a stock row with the WHOLE okrug's name spelled out
  // instead of a specific raion -- confirmed as a real, populated `district`
  // value in its own right (not a guess), so a 1:1 alias is safe here. The
  // other 3 okrugs (САО, ВАО, ЗелАО) have NO such okrug-level value in real
  // stock -- only individual raion names -- so an alias for them would
  // incorrectly narrow the whole okrug down to one arbitrary raion and is
  // deliberately NOT added. ТиНАО/Новая Москва is handled separately below
  // via its own two real district values.
  { alias: 'ЦАО', canonical: 'Центральный' },
  { alias: 'ЗАО', canonical: 'Западный' },
  { alias: 'ЮАО', canonical: 'Южный' },
  { alias: 'СЗАО', canonical: 'Северо-западный' },
  { alias: 'ЮЗАО', canonical: 'Юго-западный' },
  { alias: 'СВАО', canonical: 'Северо-восточный' },
  { alias: 'ЮВАО', canonical: 'Юго-восточный' },
  // ТиНАО / Новая Москва (2026-09-29, from the Excel cross-reference
  // above) -- real stock coverage is thin but genuine: 25 rows tagged
  // district='Новомосковский', 2 rows district='Троицкий'. "Коммунарка"
  // (the best-known Новая Москва settlement, per the Excel's own "Район
  // Москвы" column for most ТиНАО rows) maps to the broader Новомосковский
  // okrug value, same "okrug-level bucket" logic as ЦАО/ЗАО/etc. above.
  { alias: 'Новая Москва', canonical: 'Новомосковский' },
  { alias: 'ТиНАО', canonical: 'Новомосковский' },
  { alias: 'Коммунарка', canonical: 'Новомосковский' },
  { alias: 'Троицк', canonical: 'Троицкий' },
];

// Excel cross-reference matches (2026-09-29) -- see the header comment's
// source #3. Each canonical value below was verified to be an EXACT,
// currently-active `stock_inventory.complex` string, not a guess. The
// alias text is the Excel's own human-derived canonical project name
// ("Совпавший проект/алиас"), already stripped of Telegram-noise words
// (барахолка/чат/соседи/etc.) by that manual audit -- this script does not
// need to re-derive that stripping itself.
const EXCEL_VERIFIED_COMPLEX_ALIASES = [
  { alias: 'Сердце столицы', canonical: 'Сердце столицы' },
  { alias: 'Символ', canonical: 'СИМВОЛ' },
  { alias: 'Матвеевский парк', canonical: 'Матвеевский парк' },
  { alias: 'Династия', canonical: 'Династия' },
  { alias: 'Римского Корсакова 11', canonical: 'Римского-Корсакова 11' },
  { alias: 'Царская площадь', canonical: 'Царская площадь' },
  { alias: 'Савеловский Сити', canonical: 'Савёловский Сити' },
  { alias: 'Level Причальный', canonical: 'Level Причальный' },
  { alias: 'Level Мичуринский', canonical: 'Level Мичуринский' },
  { alias: 'Бунинские кварталы', canonical: 'Бунинские кварталы' },
  { alias: 'Событие', canonical: 'Событие' },
  { alias: 'Румянцево парк', canonical: 'Румянцево-Парк' },
  { alias: 'Wellton Towers', canonical: 'Wellton Towers' },
  { alias: 'Лица', canonical: 'Лица' },
  { alias: 'Aquatoria', canonical: 'Aquatoria' },
  { alias: 'High Life', canonical: 'HIGH LIFE' },
  { alias: 'Павелецкая Сити', canonical: 'Павелецкая Сити' },
  { alias: 'Life Варшавская', canonical: 'LIFE Варшавская' },
  { alias: 'Верейская 41', canonical: 'Верейская 41' },
  { alias: 'Поклонная 9', canonical: 'Поклонная 9' },
  { alias: 'Суббота', canonical: 'Суббота' },
  { alias: 'RiverSky', canonical: 'RiverSky' },
  { alias: 'Republic', canonical: 'Republic' },
  { alias: 'Neva Towers', canonical: 'Neva Towers' },
  { alias: 'Михалковский', canonical: 'Михалковский' },
  { alias: 'Огни', canonical: 'Огни' },
  { alias: 'Will Towers', canonical: 'WILL TOWERS' },
  { alias: 'West Garden', canonical: 'WEST GARDEN' },
  { alias: 'Pride', canonical: 'PRIDE' },
  { alias: 'Лесопарковый', canonical: 'Лесопарковый' },
  { alias: 'Алые паруса', canonical: 'Алые Паруса' },
  { alias: 'Hide', canonical: 'HIDE' },
  { alias: 'Врубеля 4', canonical: 'Врубеля 4' },
  { alias: 'Slava', canonical: 'Slava' },
  { alias: 'Настоящее', canonical: 'Настоящее' },
  { alias: 'Victory Park Residences', canonical: 'Victory Park Residences' },
  { alias: 'Квартал Триумфальный', canonical: 'Квартал Триумфальный' },
  { alias: 'Авиатика', canonical: 'Авиатика' },
  { alias: 'Sydney City', canonical: 'Sydney City' },
  { alias: 'Stories на Мосфильмовской', canonical: 'Stories на Мосфильмовской' },
  { alias: 'Лобачевский', canonical: 'Лобачевский' },
  { alias: 'Life Кутузовский', canonical: 'LIFE-Кутузовский' },
  { alias: 'Sky View', canonical: 'SKY VIEW' },
  { alias: 'Река', canonical: 'Река' },
  { alias: 'Roza Rossa', canonical: 'Roza Rossa' },
  { alias: 'Capital Towers', canonical: 'Capital Towers' },
  { alias: 'City Park', canonical: 'CITY PARK' },
  { alias: 'Зиларт', canonical: 'ЗИЛАРТ' },
  { alias: 'Фили Сити', canonical: 'Фили Сити' },
  { alias: 'Вестердам', canonical: 'Вестердам' },
  { alias: 'Донской Олимп', canonical: 'Донской Олимп' },
  { alias: 'ВТБ Арена парк', canonical: 'ВТБ Арена парк' },
  { alias: 'Фили Град', canonical: 'Фили Град' },
  { alias: 'Кутузов Град', canonical: 'Кутузов Град' },
  { alias: 'Лайнер', canonical: 'Лайнер' },
  { alias: 'Остров', canonical: 'Остров' },
  { alias: 'Триумф Палас', canonical: 'Триумф-Палас' },
  { alias: 'Новые Черемушки', canonical: 'Новые Черемушки' },
  { alias: 'Новая Пресня', canonical: 'Новая Пресня' },
  { alias: 'City Bay', canonical: 'City Bay' },
];

function extractComplexAliasCandidates(rows) {
  const seen = new Map(); // alias_normalized-ish dedupe key -> {alias, canonical}
  for (const { complex } of rows) {
    if (!complex) continue;
    const match = complex.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (!match) continue;
    const [, base, parenthetical] = match;
    const baseTrimmed = base.trim();
    const altTrimmed = parenthetical.trim();
    if (baseTrimmed && baseTrimmed.toLowerCase() !== complex.toLowerCase()) {
      seen.set(`base::${baseTrimmed.toLowerCase()}`, { alias: baseTrimmed, canonical: complex });
    }
    if (altTrimmed && altTrimmed.toLowerCase() !== complex.toLowerCase()) {
      seen.set(`alt::${altTrimmed.toLowerCase()}`, { alias: altTrimmed, canonical: complex });
    }
  }
  return [...seen.values()];
}

async function main() {
  const apply = process.argv.includes('--apply');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const { rows: complexRows } = await pool.query(
    `SELECT DISTINCT complex FROM matching_moscow.stock_inventory WHERE complex LIKE '%(%)%'`
  );
  const complexAliases = extractComplexAliasCandidates(complexRows);

  const candidates = [
    ...DISTRICT_ALIASES.map((a) => ({ ...a, alias_type: 'district' })),
    ...complexAliases.map((a) => ({ alias: a.alias, canonical: a.canonical, alias_type: 'complex' })),
    ...EXCEL_VERIFIED_COMPLEX_ALIASES.map((a) => ({ ...a, alias_type: 'complex' })),
  ];

  const { rows: existing } = await pool.query(`SELECT alias_type, alias_normalized FROM matching_moscow.location_aliases`);
  const existingKeys = new Set(existing.map((r) => `${r.alias_type}::${r.alias_normalized.toLowerCase()}`));

  const toInsert = candidates.filter((c) => !existingKeys.has(`${c.alias_type}::${c.alias.toLowerCase()}`));
  const skipped = candidates.length - toInsert.length;

  console.log(`${candidates.length} candidate alias(es) mined (${DISTRICT_ALIASES.length} hardcoded district, ${complexAliases.length} self-mined from real stock, ${EXCEL_VERIFIED_COMPLEX_ALIASES.length} from the Excel cross-reference), ${skipped} already seeded, ${toInsert.length} new.`);
  for (const c of toInsert) {
    console.log(`  - ${apply ? 'INSERT' : 'WOULD INSERT'} [${c.alias_type}] "${c.alias}" -> "${c.canonical}"`);
  }

  if (apply && toInsert.length) {
    for (const c of toInsert) {
      await pool.query(
        `INSERT INTO matching_moscow.location_aliases (alias_type, alias_normalized, canonical_value)
         VALUES ($1, $2, $3)
         ON CONFLICT (alias_type, alias_normalized) DO NOTHING`,
        [c.alias_type, c.alias, c.canonical]
      );
    }
    console.log('applied.');
  }

  await pool.end();
  if (!apply) {
    console.log('\nDry run only -- re-run with --apply to write these changes.');
  }
}

module.exports = { DISTRICT_ALIASES, EXCEL_VERIFIED_COMPLEX_ALIASES, extractComplexAliasCandidates };

// Only auto-run (and touch a real DB) when executed directly -- tests
// import this module for its data constants, which must never trigger a
// live Postgres connection as a side effect of require().
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
