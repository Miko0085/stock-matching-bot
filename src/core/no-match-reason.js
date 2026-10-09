'use strict';

const { normalizeAliasKey } = require('./normalize');

const REASONS = [
  'no_stock_in_location',
  'area_not_resolved',
  'building_not_resolved',
  'bedrooms_mismatch',
  'property_type_mismatch',
  'all_candidates_over_budget',
  'score_below_threshold',
  'parser_missing_fields',
  'stock_not_synced',
  'transaction_type_mismatch',
  'not_a_request',
  'spam_content',
  'promotion_listing',
  'seeking_info',
  'matching_error',
];

function isStale(stockSyncedAt, staleHours, now) {
  if (!stockSyncedAt) return true;
  const syncedMs = new Date(stockSyncedAt).getTime();
  if (!Number.isFinite(syncedMs)) return true;
  const ageHours = (now.getTime() - syncedMs) / (1000 * 60 * 60);
  return ageHours > staleHours;
}

function textualAreaHit(rawValue, candidates) {
  if (!rawValue) return false;
  const key = normalizeAliasKey(rawValue);
  return candidates.some((c) => normalizeAliasKey(c.area) === key);
}

function textualBuildingHit(rawValue, candidates) {
  if (!rawValue) return false;
  const key = normalizeAliasKey(rawValue);
  return candidates.some((c) => normalizeAliasKey(c.building) === key);
}

// Walks a fixed priority chain so the reason is deterministic and the most
// actionable diagnosis wins (e.g. an unresolved alias is more useful to know
// than a generic "score below threshold").
function determineNoMatchReason(ctx) {
  const {
    parserWarnings = [],
    notBuyingIntent = false,
    isSeekingInfo = false,
    isPromotion = false,
    isSpam = false,
    transactionTypeMismatch = false,
    areaProvided,
    areaResolved,
    areaRawValue,
    buildingProvided,
    buildingResolved,
    buildingRawValue,
    stockSyncedAt,
    staleHours,
    now = new Date(),
    candidates = [],
    scored = [],
  } = ctx;

  // Checked in this order so the most specific AI classification always
  // wins over the generic "not a request at all" fallback (ADR-017).
  if (isSpam) return 'spam_content';
  if (isPromotion) return 'promotion_listing';
  if (isSeekingInfo) return 'seeking_info';
  if (notBuyingIntent) return 'not_a_request';

  if (parserWarnings.includes('parser_missing_fields')) return 'parser_missing_fields';

  if (isStale(stockSyncedAt, staleHours, now)) return 'stock_not_synced';

  if (transactionTypeMismatch) return 'transaction_type_mismatch';

  if (candidates.length === 0) return 'no_stock_in_location';

  if (areaProvided && !areaResolved && !textualAreaHit(areaRawValue, candidates)) {
    return 'area_not_resolved';
  }

  if (buildingProvided && !buildingResolved && !textualBuildingHit(buildingRawValue, candidates)) {
    return 'building_not_resolved';
  }

  const inArea = scored.filter((entry) => entry.score.location > 0);
  if (inArea.length === 0) return 'no_stock_in_location';

  // Checked via the hard bedroomsOutOfRange gate (ADR-019), not the raw
  // bedrooms score, for the same robustness reason as the budget gate below.
  const bedroomsOk = inArea.filter((entry) => !entry.bedroomsOutOfRange);
  if (bedroomsOk.length === 0) return 'bedrooms_mismatch';

  // Checked via the hard propertyTypeOutOfRange gate (ADR-025), not the raw
  // propertyType score, for the same robustness reason as bedrooms/budget.
  const propertyTypeOk = bedroomsOk.filter((entry) => !entry.propertyTypeOutOfRange);
  if (propertyTypeOk.length === 0) return 'property_type_mismatch';

  // Checked via the hard priceOutOfRange gate (ADR-018), not the raw
  // budget score — a deployment that configures a non-zero
  // MATCH_BUDGET_SCORE_OVER_10 must still report this reason correctly.
  const budgetOk = propertyTypeOk.filter((entry) => !entry.priceOutOfRange);
  if (budgetOk.length === 0) return 'all_candidates_over_budget';

  return 'score_below_threshold';
}

module.exports = { REASONS, determineNoMatchReason, isStale };
