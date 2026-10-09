'use strict';

const { resolveAlias } = require('./aliases');
const { computeScore, classifyScore, sameKey, isBudgetWithinTolerance, isBedroomsAcceptable, isPropertyTypeAcceptable } = require('./scoring');
const { determineNoMatchReason, isStale } = require('./no-match-reason');

function normalizeRequestForMatching(parsedRequest, aliasIndex) {
  const area = resolveAlias('area', parsedRequest.area, aliasIndex);
  const building = resolveAlias('building', parsedRequest.building, aliasIndex);
  const propertyType = resolveAlias('property_type', parsedRequest.property_type, aliasIndex);

  return {
    transactionType: parsedRequest.transaction_type,
    area: area.value,
    areaRaw: parsedRequest.area,
    areaResolved: area.resolved,
    building: building.value,
    buildingRaw: parsedRequest.building,
    buildingResolved: building.resolved,
    bedrooms: parsedRequest.bedrooms,
    propertyType: propertyType.value,
    propertyTypeRaw: parsedRequest.property_type,
    propertyTypeResolved: propertyType.resolved,
    budgetMin: parsedRequest.budget_min,
    budgetMax: parsedRequest.budget_max,
    furnishing: parsedRequest.furnishing,
    cashBuyer: parsedRequest.cash_buyer,
    confidence: parsedRequest.confidence,
  };
}

function sortCandidates(a, b) {
  if (b.score.total !== a.score.total) return b.score.total - a.score.total;
  return String(a.stock.stock_id).localeCompare(String(b.stock.stock_id));
}

// A request is only "viable" against stock in its own resolved (or literal)
// area. Bedrooms/property type/budget/furnishing are scored, not filtered,
// so a wrong-area listing can never accumulate enough points from the other
// four criteria alone to look like a match.
function filterViableCandidates(normalizedRequest, stockCandidates) {
  if (!normalizedRequest.area) return stockCandidates;
  return stockCandidates.filter((stock) => sameKey(normalizedRequest.area, stock.area));
}

// Pure deterministic matching. Takes an already-validated parsed request and
// a plain array of ACTIVE/SALE stock candidates (already loaded from
// PostgreSQL by the caller) and returns every scored candidate plus the
// subset that qualifies as a successful match. Never truncates successes.
function matchRequest({
  parsedRequest,
  parserWarnings = [],
  aliasIndex = {},
  stockCandidates = [],
  config,
  stockSyncedAt = null,
  now = new Date(),
}) {
  const normalizedRequest = normalizeRequestForMatching(parsedRequest, aliasIndex);

  const viableCandidates = filterViableCandidates(normalizedRequest, stockCandidates);

  const scored = viableCandidates
    .map((stock) => {
      const score = computeScore(normalizedRequest, stock, config);
      const priceOutOfRange = !isBudgetWithinTolerance(normalizedRequest, stock, config);
      const bedroomsOutOfRange = !isBedroomsAcceptable(normalizedRequest, stock);
      const propertyTypeOutOfRange = !isPropertyTypeAcceptable(normalizedRequest, stock);
      // A price beyond the tolerance band, a bedroom count that doesn't
      // match a stated requirement, or a property type that doesn't match
      // a stated requirement (Villa/Townhouse vs Apartment, etc.) is a hard
      // NO_MATCH regardless of total score — otherwise the other criteria
      // alone (up to 85/100) could still clear the STRONG_MATCH threshold
      // on a listing that scored 0 on one of these three (ADR-018, ADR-019,
      // ADR-025).
      const status =
        priceOutOfRange || bedroomsOutOfRange || propertyTypeOutOfRange
          ? 'NO_MATCH'
          : classifyScore(score.total, config);
      return { stock, score, status, priceOutOfRange, bedroomsOutOfRange, propertyTypeOutOfRange };
    })
    .sort(sortCandidates)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));

  // Four independent AI classification labels (ADR-017, replacing the old
  // single is_request boolean — see docs/DEVI_CHANNEL_MONITORING_RESEARCH.md
  // for the design this mirrors). Any of them wins regardless of what
  // individual criteria fields the parser still extracted (e.g. a
  // roommate-wanted post naming a real area still has buying_intent: false,
  // but "area" alone was previously enough to skip the parser_missing_fields
  // gate and score it against real stock — ADR-016's original incident).
  const notBuyingIntent = parsedRequest.buying_intent === false;
  const isSeekingInfo = parsedRequest.seeking_info === true;
  const isPromotion = parsedRequest.promotion === true;
  const isSpam = parsedRequest.spam === true;
  const missingParserFields = parserWarnings.includes('parser_missing_fields');
  const staleStock = isStale(stockSyncedAt, config.stockStaleHours, now);
  const allowedTransactionTypes = config.matchAllowedTransactionTypes || [];
  const transactionTypeMismatch = Boolean(
    parsedRequest.transaction_type && !allowedTransactionTypes.includes(parsedRequest.transaction_type)
  );

  const naturalSuccessful = scored.filter((entry) => entry.status !== 'NO_MATCH');
  const blocked =
    notBuyingIntent ||
    isSeekingInfo ||
    isPromotion ||
    isSpam ||
    missingParserFields ||
    staleStock ||
    transactionTypeMismatch;

  const successfulMatches = blocked ? [] : naturalSuccessful;
  const resultStatus = successfulMatches.length === 0
    ? 'NO_MATCH'
    : successfulMatches.some((entry) => entry.status === 'STRONG_MATCH')
      ? 'STRONG_MATCH'
      : 'MATCH';

  let noMatchReason = null;
  if (resultStatus === 'NO_MATCH') {
    noMatchReason = determineNoMatchReason({
      parserWarnings,
      notBuyingIntent,
      isSeekingInfo,
      isPromotion,
      isSpam,
      transactionTypeMismatch,
      areaProvided: Boolean(parsedRequest.area),
      areaResolved: normalizedRequest.areaResolved,
      areaRawValue: parsedRequest.area,
      buildingProvided: Boolean(parsedRequest.building),
      buildingResolved: normalizedRequest.buildingResolved,
      buildingRawValue: parsedRequest.building,
      stockSyncedAt,
      staleHours: config.stockStaleHours,
      now,
      candidates: stockCandidates,
      scored,
    });
  }

  return {
    normalizedRequest,
    scored,
    successfulMatches,
    resultStatus,
    noMatchReason,
    bestScore: scored.length ? scored[0].score.total : null,
    activeStockCount: stockCandidates.length,
    candidatesCount: viableCandidates.length,
    matchesCount: successfulMatches.length,
  };
}

module.exports = { normalizeRequestForMatching, matchRequest };
