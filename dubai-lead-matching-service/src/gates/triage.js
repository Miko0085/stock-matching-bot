'use strict';

// Deterministic three-way triage (cost-optimization plan, part A.2).
// Replaces the old binary Primary Lead Gate's "everything not obvious
// junk goes to AI" behavior with three outcomes:
//
//   REJECT          -- strong deterministic evidence (multi-listing ad,
//                       clear broker solicitation, obvious junk). OpenAI
//                       is never called, the matcher never runs.
//   PARSED_LOCALLY  -- a confident, unambiguous, sender-owned buyer
//                       request the deterministic parser fully handled.
//                       OpenAI is never called.
//   AI_REVIEW       -- plausible buyer-related content whose direction,
//                       meaning, or criteria are genuinely ambiguous.
//                       OpenAI is the fallback, not the default.
//
// Precision over recall: a REJECT must be backed by strong, explicit
// signals. Anything genuinely uncertain falls through to AI_REVIEW rather
// than being guessed at -- false REJECTs (silently dropping a real buyer)
// are worse than one extra AI call, but false buyer-matches from a
// misclassified ad are worse still, which is why REJECT patterns here are
// deliberately narrow and explicit (the Emaar incident must never repeat).

const { evaluatePrimaryLeadGate } = require('./primary-lead-gate');
const { parseLocally } = require('../parser/local-parser');
const { detectUnresolvedSpecificLocationHint } = require('../matching/unresolved-location');

// P1 release blocker (spec sections 28-31, 52-55): a bare "5M"/"800K" with
// no "AED" token anywhere nearby used to not count as a price signal at
// all, under-detecting multi-listing ads written in that shorthand. Widened
// to also recognize a bare amount+M/K suffix on its own -- but this alone
// can NEVER cause a REJECT: detectMultiListingAd (below) still requires
// this to co-occur with >=2 bedroom signals (and, in the whole-text
// fallback, >=2 listing words too), so a genuine buyer stating a bare
// budget ("budget 5M, looking for 2BR villa") stays exactly one price
// signal and one bedroom signal -- below the ">=2" threshold that would be
// needed to ever flag it as a listing. Combination-of-signals, never
// price-format alone, is what gates REJECT here.
const PRICE_SIGNAL_RE = /\baed\s*[\d.,]+\s*(?:m|mln|million|k)?\b|\b\d+(?:\.\d+)?\s*m\s*aed\b|\bsale\s*price\b|\bprice\s*:?\s*aed\b|\bprice\s*aed\b|\b\d+(?:\.\d+)?\s*m\b.{0,10}\baed\b|\b\d+(?:\.\d+)?\s*(?:m|k)\b/i;
const BEDROOM_SIGNAL_RE = /\b\d+\s*br\b|\b\d+\s*bd\b|\bbedrooms?\s*:/i;
const LISTING_WORD_RE = /\bsqft\b|\bsq\.?\s*ft\b|\bsqm\b|\bsq\.?\s*m\b|\bhandover\b|\bfor\s+sale\b|\bfloor\b|\bview\s*:/i;

// Splits on explicit "---"-style separators first (the common repost
// format), falling back to blank-line paragraph breaks so a multi-listing
// ad pasted without separators is still caught.
function splitIntoBlocks(text) {
  const bySeparator = text.split(/\n\s*-{3,}\s*\n/);
  if (bySeparator.length > 1) return bySeparator;
  return text.split(/\n{2,}/);
}

function isListingBlock(block) {
  return PRICE_SIGNAL_RE.test(block) && BEDROOM_SIGNAL_RE.test(block);
}

// TZ cost-plan item 2 "Multi-listing inventory advertisement": two or more
// self-contained blocks that each carry both a price AND a bedroom count
// is the strong, explicit signal -- a single listing (even a detailed one)
// never has more than one of each, so this cannot fire on a genuine
// individual buyer or seller post.
function detectMultiListingAd(originalText) {
  const blocks = splitIntoBlocks(originalText);
  const listingBlocks = blocks.filter(isListingBlock);
  if (listingBlocks.length >= 2) {
    return { matched: true, listingBlockCount: listingBlocks.length };
  }
  // No clean block boundaries, but the whole text still reads as several
  // listings run together (e.g. no blank lines at all): fall back to a
  // whole-text count of distinct price and bedroom signals.
  const priceCount = (originalText.match(new RegExp(PRICE_SIGNAL_RE, 'gi')) || []).length;
  const bedroomCount = (originalText.match(new RegExp(BEDROOM_SIGNAL_RE, 'gi')) || []).length;
  const listingWordCount = (originalText.match(new RegExp(LISTING_WORD_RE, 'gi')) || []).length;
  if (priceCount >= 2 && bedroomCount >= 2 && listingWordCount >= 2) {
    return { matched: true, listingBlockCount: Math.max(priceCount, bedroomCount) };
  }
  return { matched: false };
}

// Recipient-owned solicitation phrasing only -- deliberately does NOT
// match sender-owned phrasing like "my client is looking for" / "client
// needs". Direction (who has the requirement), not keyword presence, is
// what these patterns encode.
const BROKER_SOLICITATION_PATTERNS = [
  /\bdo\s+you\s+have\s+(?:a\s+)?(?:buyer|client)s?\b/i,
  /\bhave\s+a\s+client\s+looking\s+to\s+buy\b/i,
  /\bsend\s+(?:us|me)\s+your\s+client'?s?\s+requirements?\b/i,
  /\bsend\s+me\s+your\s+clients?\b/i,
  /\bagents?\s+(?:are\s+)?(?:always\s+)?welcome\b/i,
  /\bbuyer[\s-]side\s+commission\s+is\s+(?:100%\s+)?yours\b/i,
  /\bdo\s+you\s+have\s+a\s+client\s+looking\s+for\b/i,
];

function detectBrokerSolicitation(originalText) {
  return BROKER_SOLICITATION_PATTERNS.some((p) => p.test(originalText));
}

// Conservative single-listing-ad heuristic: only an explicit "for sale" /
// "for rent" heading (or its Russian offer-side equivalent -- see below)
// with no first-person buyer language anywhere in the message. Deliberately
// narrow -- ambiguous single posts fall through to AI_REVIEW instead (item
// 2's "prefer false-negative REJECT avoidance").
const FOR_SALE_HEADING_RE = /^\s*(?:🏠\s*)?for\s+(?:sale|rent)\b/i;
// P1 release blocker (spec sections 28-31): "Сдам"/"Сдаю"/"Сдаётся" (I am
// renting out / being rented out) and "Продам"/"Продаю"/"Продаётся" (I am
// selling / being sold), plus "от собственника" (from the owner), are
// SELLER/OFFER-side signals in Russian -- the exact opposite of "Ищу"/
// "Сниму" (I am looking for / I would like to rent), which remain genuine
// buyer/renter signals via FIRST_PERSON_BUYER_RE below. This is a
// DIRECTIONAL classification word list (who has the requirement), not
// RF-market numeric/currency parsing -- it does not extract RUB/млн/кв.м or
// any other RF-contour concept, so it does not violate the UAE/RF
// isolation boundary (AGENTS.md) that local-parser.js's comment documents;
// it only recognizes that Russian is a language used within UAE-market
// groups too. Matches anywhere in the text (not anchored to the start,
// unlike the English heading) since these verbs are the ad's operative
// word wherever they appear, not necessarily the very first token.
// JS's `\b` is ASCII-only (a boundary between `\w` = [A-Za-z0-9_] and
// non-`\w`) -- Cyrillic letters are never `\w`, so `\bсдам\b` silently never
// matches ANYTHING (confirmed: both sides of a Cyrillic word are "non-word"
// to `\b`, so there is no boundary transition there at all). Every Russian
// token below uses this Unicode-aware boundary pair instead -- a lookaround
// against "not a letter/digit/underscore" (`\p{L}`/`\p{N}`), which works
// identically to `\b` for ASCII text too, so the same pair is used for the
// English tokens for consistency within these two mixed-language regexes.
const NB = '(?<![\\p{L}\\p{N}_])';
const NA = '(?![\\p{L}\\p{N}_])';
const RUSSIAN_OFFER_SIGNAL_RE = new RegExp(
  `${NB}сдам${NA}|${NB}сдаю${NA}|${NB}сда(?:ё|е)тся${NA}|${NB}продам${NA}|${NB}продаю${NA}|${NB}прода(?:ё|е)тся${NA}|${NB}от\\s+собственника${NA}`,
  'iu'
);
const FIRST_PERSON_BUYER_RE = new RegExp(
  `${NB}my\\s+client${NA}|${NB}i\\s+(?:need|want|am\\s+looking)${NA}|${NB}my\\s+customer${NA}|${NB}ищу${NA}|${NB}нужен${NA}|${NB}нужна${NA}|${NB}клиенту\\s+нужн|${NB}сниму${NA}`,
  'iu'
);

function detectSingleListingAd(originalText) {
  if (!FIRST_PERSON_BUYER_RE.test(originalText) && RUSSIAN_OFFER_SIGNAL_RE.test(originalText)) return true;
  return FOR_SALE_HEADING_RE.test(originalText) && !FIRST_PERSON_BUYER_RE.test(originalText);
}

// 2026-10-07 audit finding: "Ищу соседку в 1 bedroom в Business Bay" /
// "Ищу место в комнате на 2х" / "Ищу подселение в квартиру" /
// "Сниму мастер рум на JBR для 2 девушек" read, to the deterministic local
// parser, as an ordinary buyer request -- FIRST_PERSON_BUYER_RE matches
// "ищу"/"сниму", a bedroom count and an area are both present, so
// `evaluateTriage` fell straight into PARSED_LOCALLY and the matcher ran
// against full-unit stock. But the requester isn't asking to buy/rent a
// whole unit at all -- they want a ROOM/BED within a shared apartment
// (or, in the inverse direction, to fill one), something this platform has
// no stock for at any specificity level. Confirmed live: 5 of 30 total
// Dubai MATCH outcomes in the preceding 7 days were exactly this pattern,
// each one a real, unwanted Telegram alert sent to brokers (AGENTS.md
// section 6: every MATCH must be delivered, so the only fix is to never
// reach MATCH for these in the first place). Narrow, explicit keyword set
// (same "precision over recall" discipline as detectBrokerSolicitation
// above) -- a REJECT here must never catch a genuine whole-unit buyer
// request; "roommate"/"flatmate"/"сосед*"/"подсел*"/"master room" (as
// Dubai share-accommodation slang for a single rentable room, distinct
// from "master BEDROOM" describing a feature of a whole unit) essentially
// never appear in one. Checked BEFORE parseLocally runs, same priority as
// the other REJECT detectors, so this never reaches AI either.
const ROOMMATE_ROOM_SHARE_RE = new RegExp(
  `\\broommate${NA}|\\bflatmate${NA}|room[\\s-]?shar(?:e|ing)|shared\\s+room|bed\\s*[\\s-]?space|place\\s+in\\s+a\\s+room|\\bmaster\\s*room${NA}|` +
  `${NB}сосед(?:а|у|ку|ка|ей|и|ей)?${NA}|${NB}подсел(?:ение|ю|ится|иться|енец|енцы)?${NA}|место\\s+в\\s+комнате|${NB}мастер\\s*рум${NA}`,
  'iu'
);

function detectRoommateOrRoomShareRequest(originalText) {
  return ROOMMATE_ROOM_SHARE_RE.test(originalText);
}

// AUDIT item #2: the local parser only ever fills `project`/`building`
// when a phrase is an ACTUAL alias-index hit -- if only `area` resolved,
// a leftover capitalized run in the text ("The Edge") might be a real,
// unrecognized project/building name the deterministic parser simply
// doesn't know about. Rather than let the matcher's blunt heuristic
// declare NO_MATCH immediately (over-broad -- also flags plain buyer
// language like "Cash Buyer"/"Urgent"/"High Floor"/"Canal View"), treat
// this as AMBIGUITY and escalate to AI_REVIEW so OpenAI -- which actually
// understands English and real-estate context -- gets a chance to decide
// whether the phrase is a genuine project/building or ordinary descriptive
// words. This is deliberately NOT solved by growing a stopword list: a
// fixed dictionary can never anticipate every legitimate buyer adjective,
// but it also must never expand indefinitely. If AI_REVIEW also can't
// resolve the phrase into a project/building, the existing
// unresolved-project safeguard (resolveLocationLevel's "not resolved" path
// in matcher.js) still refuses to broaden to the whole area -- this only
// changes WHEN that final judgment call is made, from "before AI ever
// sees the text" to "only if AI's own extraction still leaves it
// unresolved."
function hasOnlyAreaLevelLocation(localValue) {
  return Boolean(localValue.area) && !localValue.project && !localValue.building;
}

function needsLocationAmbiguityEscalation(originalText, localValue) {
  return hasOnlyAreaLevelLocation(localValue) && detectUnresolvedSpecificLocationHint(originalText, localValue.area);
}

// Orchestrates the full triage decision. `aliasIndex` is threaded through
// to the local parser for dictionary-based location resolution (item 4).
function evaluateTriage(originalText, { aliasIndex = {} } = {}) {
  const gate = evaluatePrimaryLeadGate(originalText);
  if (!gate.passed) {
    return { decision: 'REJECT', reason: gate.reason, localValue: null };
  }

  const multiListing = detectMultiListingAd(originalText);
  if (multiListing.matched) {
    return { decision: 'REJECT', reason: 'multi_listing_inventory_ad', localValue: null };
  }

  if (detectBrokerSolicitation(originalText)) {
    return { decision: 'REJECT', reason: 'broker_solicitation', localValue: null };
  }

  if (detectSingleListingAd(originalText)) {
    return { decision: 'REJECT', reason: 'single_listing_inventory_ad', localValue: null };
  }

  if (detectRoommateOrRoomShareRequest(originalText)) {
    return { decision: 'REJECT', reason: 'roommate_or_room_share_request', localValue: null };
  }

  const local = parseLocally(originalText, { aliasIndex });

  if (local.hedge) {
    return { decision: 'AI_REVIEW', reason: 'ambiguous_hedge', localValue: null };
  }

  if (local.hasLocation && local.criteriaCount >= 1 && !local.hasBuyerIntent) {
    // P0.1 release blocker: location + criteria alone is exactly as
    // consistent with an inventory listing ("Business Bay / 2BR / AED
    // 2.5M / Furnished") as with a genuine buyer request. Without an
    // explicit sender-owned demand signal, never auto-classify as
    // buyer_request -- defer to AI_REVIEW, which can weigh direction and
    // context the deterministic parser can't.
    return { decision: 'AI_REVIEW', reason: 'criteria_without_proven_buyer_intent', localValue: null };
  }

  if (local.hasLocation && local.criteriaCount >= 1 && local.hasBuyerIntent) {
    if (needsLocationAmbiguityEscalation(originalText, local.value)) {
      return { decision: 'AI_REVIEW', reason: 'possible_unresolved_specific_location', localValue: null };
    }
    return { decision: 'PARSED_LOCALLY', reason: null, localValue: local.value };
  }

  return { decision: 'AI_REVIEW', reason: 'insufficient_local_signal', localValue: null };
}

module.exports = {
  evaluateTriage,
  detectMultiListingAd,
  detectBrokerSolicitation,
  detectSingleListingAd,
  detectRoommateOrRoomShareRequest,
  needsLocationAmbiguityEscalation,
};
