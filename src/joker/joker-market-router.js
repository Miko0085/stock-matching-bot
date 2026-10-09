'use strict';

// Buckets a raw Joker object into one of the pilot's Joker-fed markets, by
// its `region` field. Pure function, no DB/HTTP -- confirmed against a real
// full-catalog scan (2026-09-28, 14,926 objects) of actual `region` values.
//
// UAE is deliberately excluded here (returns null -- explicit skip): UAE
// keeps reading its existing matching_dubai.stock_inventory source for now (user's
// own scope boundary, docs/PER_MARKET_SERVICE_INDEPENDENCE_PLAN.md section
// 8) -- the ~90 Joker objects tagged region "ОАЭ" are also the exact batch
// JOKER_API_DISCOVERY.md flagged as data-quality-suspect (duplicate prices,
// zero-price/empty-title rows) and explicitly NOT recommended for syncing
// without a conversation with whoever administers Joker. A future Joker→UAE
// sync is separate, later work.
const MARKET_SCHEMAS = {
  moscow: 'matching_moscow',
  oman: 'matching_oman',
  saudi: 'matching_saudi',
  turkey: 'matching_turkey',
};

// STRICT scope (2026-09-28, tightened after a live audit found the original
// "everything not Turkey/UAE/Oman/Saudi" catch-all silently pulling in
// Санкт-Петербург/Краснодарский край (Сочи)/Татарстан (Казань)/Самарская
// область AND completely unrelated countries -- Узбекистан (Ташкент),
// Грузия (Батуми) -- into the "Moscow" schema just because they shared one
// Joker tenant with real Moscow listings). The user's own instruction:
// "сузить сток строго до города Москва" -- only `region === 'Москва'`
// (the city itself) routes here now. Everything else, including
// Московская область (Одинцово/Красногорск/Химки/etc -- the OBLAST, not
// the city) and no-region objects, is out of scope and skipped, not
// silently absorbed. Previously-synced non-Moscow rows already in
// matching_moscow.stock_inventory are not deleted by this change -- the
// next sync's markMissingUnavailable() marks them unavailable (never
// delete, same as every other stock table in this pilot), so they simply
// stop appearing on /stock?market=moscow.
const MOSCOW_REGION = 'Москва';

// Confirmed live (2026-09-28 full scan): zero objects with region 'Оман' or
// 'Саудовская Аравия' exist anywhere in this Joker tenant today. Their
// tables are created ready for future data, not expected to be non-empty
// immediately after a sync -- not a bug if `oman`/`saudi` counts stay 0.
function resolveMarket(regionRaw) {
  const region = (regionRaw || '').trim();
  if (!region) return null; // no region at all -- cannot confirm Moscow, so out of scope
  if (region.includes('Турция')) return 'turkey';
  if (region.includes('ОАЭ')) return null; // explicit skip, not an unresolved case
  if (region.includes('Оман')) return 'oman';
  if (region.includes('Саудовская Аравия')) return 'saudi';
  if (region === MOSCOW_REGION) return 'moscow';
  // Everything else (Московская область, Санкт-Петербург, Краснодарский
  // край, Татарстан, Самарская область, Узбекистан, Грузия, etc.) is out
  // of the strict Moscow-city scope -- skipped, not absorbed.
  return null;
}

// Distinguishes WHY an object was skipped, for sync-run diagnostics only
// (never changes routing). Kept as a separate function so resolveMarket()
// stays a single-purpose router.
function classifySkipReason(regionRaw) {
  const region = (regionRaw || '').trim();
  if (!region) return 'no_region';
  if (region.includes('ОАЭ')) return 'dubai_deliberate_skip';
  return 'out_of_moscow_scope';
}

module.exports = { MARKET_SCHEMAS, resolveMarket, classifySkipReason };
