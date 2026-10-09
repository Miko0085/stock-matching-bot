'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateTriage, detectMultiListingAd, detectBrokerSolicitation, detectSingleListingAd, detectRoommateOrRoomShareRequest, needsLocationAmbiguityEscalation } = require('../../src/gates/triage');

const BUSINESS_BAY_ALIAS_INDEX = { area: new Map([['businessbay', { canonical: 'Business Bay' }]]) };

const MULTI_LISTING_AD = [
  '3BR Apartment for Sale | The Isle, Dubai Harbour',
  '✨ Premium 3-bedroom residence with stunning Palm views, featuring a unique design and high-end finishes throughout.',
  '📍 Dubai Harbour',
  '📐 173.82 sqm',
  '🌅 Palm View',
  '🏡 Premium Materials & Contemporary Design',
  '💰 Sale Price: AED 10.5 Millions',
  '',
  '---',
  '',
  '📍JVT | Maya Residences 5 | 2BR | Store | Community View',
  '1226 sqft',
  'Handover: Ready',
  'Price AED 1.82M',
  '',
  '---',
  '',
  'for sale',
  '📍Business Bay',
  'The Paragon',
  'Mid Floor',
  '2BR',
  '1600 sqft',
  '3M',
  '',
  '---',
  '',
  'Binghatti Crest',
  '🗺 Location:  JVC',
  '🛏 Bedrooms: 2 BD',
  '🔑 Handover: Ready',
  '📐 Area m2: (89) 959 sq.ft',
  'Price: 1.425 M AED Unfinished',
  '1.44 M AED Furnished',
  'View : Community',
].join('\n');

test('TZ cost-plan: the exact multi-listing fixture is detected as a multi-listing inventory ad', () => {
  const result = detectMultiListingAd(MULTI_LISTING_AD);
  assert.equal(result.matched, true);
  assert.ok(result.listingBlockCount >= 2);
});

test('evaluateTriage: the exact multi-listing fixture -> REJECT / multi_listing_inventory_ad', () => {
  const result = evaluateTriage(MULTI_LISTING_AD, { aliasIndex: {} });
  assert.equal(result.decision, 'REJECT');
  assert.equal(result.reason, 'multi_listing_inventory_ad');
});

test('a single genuine buyer request is never flagged as a multi-listing ad', () => {
  const result = detectMultiListingAd('My client needs a 2BR in Business Bay, budget up to 2.5M AED, cash buyer.');
  assert.equal(result.matched, false);
});

test('detectBrokerSolicitation: recipient-owned phrasings are caught', () => {
  assert.equal(detectBrokerSolicitation('Do you have a buyer for this unit?'), true);
  assert.equal(detectBrokerSolicitation('Have a client looking to buy? Send us your client\'s requirements.'), true);
  assert.equal(detectBrokerSolicitation('Send me your clients, agents are always welcome!'), true);
  assert.equal(detectBrokerSolicitation('Do you have a client looking for a 2BR?'), true);
});

test('detectBrokerSolicitation: sender-owned phrasing is NEVER flagged (critical direction test)', () => {
  assert.equal(detectBrokerSolicitation('My client is looking for a 2BR in Business Bay'), false);
  assert.equal(detectBrokerSolicitation('My client needs P4 2BR up to 2.7m'), false);
});

test('evaluateTriage: Emaar-style broker solicitation is REJECTED deterministically', () => {
  const text = "Have a client looking to BUY or RENT in Emaar Beachfront?\nSend us your requirements — we'll find the right option for you.\nAGENTS ARE ALWAYS WELCOME!\nSend me your client's requirements now:";
  const result = evaluateTriage(text, { aliasIndex: {} });
  assert.equal(result.decision, 'REJECT');
  assert.equal(result.reason, 'broker_solicitation');
});

test('evaluateTriage: sender-owned "My client is looking for a 2BR" is never rejected as solicitation', () => {
  const result = evaluateTriage('My client is looking for a 2BR in Business Bay', { aliasIndex: {} });
  assert.notEqual(result.decision, 'REJECT');
});

test('detectSingleListingAd: an explicit "For Sale" heading with no first-person buyer language', () => {
  assert.equal(detectSingleListingAd('For Sale\nBusiness Bay\n2BR\nAED 2,000,000'), true);
});

test('detectSingleListingAd: never fires when first-person buyer language is present', () => {
  assert.equal(detectSingleListingAd('My client needs something for sale in Business Bay'), false);
});

// P1 release blocker (spec sections 28-31): Russian offer-side verbs
// ("Сдам"/"Сдаю"/"Продам"/"Продаю"/"от собственника") are the SUPPLY side,
// never a buyer/renter demand -- regardless of language.
test('detectSingleListingAd: Russian "Сдам" (I am renting out) is a seller/offer signal', () => {
  assert.equal(detectSingleListingAd('Сдам 2BR в Marina, срочно, 120k в год'), true);
});

test('detectSingleListingAd: Russian "Продам" (I am selling) is a seller/offer signal', () => {
  assert.equal(detectSingleListingAd('Продам виллу в Arabian Ranches, 5M AED'), true);
});

test('detectSingleListingAd: "от собственника" (from the owner) is a seller/offer signal', () => {
  assert.equal(detectSingleListingAd('2BR в Downtown, от собственника, без комиссии'), true);
});

test('detectSingleListingAd: Russian "Ищу" (I am looking for) is NEVER flagged as an offer -- opposite direction', () => {
  assert.equal(detectSingleListingAd('Ищу 2BR в Marina для клиента, бюджет 2M'), false);
});

// 2026-10-07 audit finding: 5 of 30 Dubai MATCH outcomes in the preceding
// 7 days were buyers' messages actually asking for a ROOM/BED in a shared
// apartment, not a whole unit -- the local parser saw "ищу" + a bedroom
// count + an area and happily classified these as ordinary buyer requests.
// Real production examples (verbatim, from live match_runs.original_text).
test('detectRoommateOrRoomShareRequest: catches the real false-positive messages that reached MATCH', () => {
  assert.equal(detectRoommateOrRoomShareRequest('Ищу соседку в 1 bedroom в Business Bay с 1 ноября (можно раньше заехать)'), true);
  assert.equal(detectRoommateOrRoomShareRequest('Ищу место в комнате на 2х, чтоб в квартире зал был для общего использования'), true);
  assert.equal(detectRoommateOrRoomShareRequest('Кто живет в Дубае и кому нужна соседка, напишите, пожалуйста'), true);
  assert.equal(detectRoommateOrRoomShareRequest('Ищу подселение в квартиру в Business Bay, Dubai Marina или между ними'), true);
  assert.equal(detectRoommateOrRoomShareRequest('Сниму мастер рум на JBR для 2 девушек с конца октября на длительный срок.'), true);
});

test('detectRoommateOrRoomShareRequest: "master room"/"мастер рум" (Dubai share-accommodation slang for one rentable room) is caught, but "master bedroom" as a feature of a whole unit is NOT (precision test)', () => {
  assert.equal(detectRoommateOrRoomShareRequest('Looking for a master room in Dubai Marina, long term'), true);
  assert.equal(detectRoommateOrRoomShareRequest('Сниму мастер рум в Марина'), true);
  assert.equal(detectRoommateOrRoomShareRequest('Looking for 2BR with master bedroom ensuite, Marina'), false);
});

test('detectRoommateOrRoomShareRequest: English roommate/flatmate/room-share/bed-space phrasing is caught', () => {
  assert.equal(detectRoommateOrRoomShareRequest('Looking for a roommate to share my 2BR in JVC'), true);
  assert.equal(detectRoommateOrRoomShareRequest('Need a flatmate for Marina apartment'), true);
  assert.equal(detectRoommateOrRoomShareRequest('Room share available in Business Bay'), true);
  assert.equal(detectRoommateOrRoomShareRequest('Looking for bed space in Deira'), true);
  assert.equal(detectRoommateOrRoomShareRequest('I am looking for a place in a room, shared apartment'), true);
});

test('detectRoommateOrRoomShareRequest: a genuine whole-unit buyer/renter request is NEVER flagged (critical precision test)', () => {
  assert.equal(detectRoommateOrRoomShareRequest('I am looking for a 2BR in Business Bay'), false);
  assert.equal(detectRoommateOrRoomShareRequest('My client is looking for a villa in Arabian Ranches'), false);
  assert.equal(detectRoommateOrRoomShareRequest('Looking for 1bed in Emaar Beachfront distress deal, cash'), false);
  assert.equal(detectRoommateOrRoomShareRequest('Ищу 2BR в Marina, бюджет 2.5M'), false);
  assert.equal(detectRoommateOrRoomShareRequest('Сниму студию в Марина, бюджет 90к в год'), false);
  // "neighborhood" must never trigger on "neighbor"-adjacent English text.
  assert.equal(detectRoommateOrRoomShareRequest('Looking for a quiet neighborhood, 2BR villa, Arabian Ranches'), false);
  assert.equal(detectRoommateOrRoomShareRequest('My client needs a townhouse near good schools and friendly neighbors'), false);
});

test('evaluateTriage: a roommate/room-share request is REJECTED before ever reaching the local parser or AI', () => {
  // This specific real example passes evaluatePrimaryLeadGate's own,
  // broader heuristics (so it reaches this new check at all) -- some of
  // the other 4 real false positives are already caught earlier, by
  // non_property_request, which is a DIFFERENT gap: the V2 Authoritative
  // Gate (the live cutover path, not this legacy evaluateTriage path) has
  // no equivalent of primary-lead-gate.js's non_property_request heuristic
  // at all, which is the real reason all 5 reached MATCH in production --
  // see ADR-049. This test only verifies the new detector's own REJECT
  // wiring in the legacy path, not the full production root cause.
  const result = evaluateTriage(
    'Ищу место в комнате на 2х, чтоб в квартире зал был для общего использования \nРайон DIFC, Business Bay, World Trade Center, Marina, Tecom\nРядом с метро',
    { aliasIndex: {} }
  );
  assert.equal(result.decision, 'REJECT');
  assert.equal(result.reason, 'roommate_or_room_share_request');
  assert.equal(result.localValue, null);
});

test('detectSingleListingAd: Russian "Сниму" (I would like to rent) is NEVER flagged as an offer -- opposite direction', () => {
  assert.equal(detectSingleListingAd('Сниму студию в JVC, бюджет 80k в год'), false);
});

// Latent bug found while fixing the above: JS's `\b` is ASCII-only and
// never matches around Cyrillic letters, so FIRST_PERSON_BUYER_RE's
// Russian buyer-exclusion patterns ("ищу"/"нужен"/"нужна") silently never
// matched ANYTHING before this fix -- confirmed by testing the old pattern
// directly. Regression-tested here since it's the exact same class of bug
// as the seller-signal one above, in a function this fix already touches.
test('FIRST_PERSON_BUYER_RE regression: Russian "нужен"/"нужна" buyer exclusions actually match (Cyrillic \\b bug)', () => {
  // "For Sale" heading + Russian buyer language present -> must NOT be
  // treated as a listing (the buyer-language exclusion must actually fire).
  assert.equal(detectSingleListingAd('For Sale\nНужен 2BR в Marina для клиента'), false);
  assert.equal(detectSingleListingAd('For Sale\nНужна вилла для клиента'), false);
});

// P1 release blocker (spec sections 28-31, 52-55): a bare "5M"/"800K" price
// with no "AED" token must also be recognized as a price signal for
// multi-listing detection -- but only the SAME combination-of-signals
// threshold as before, never price-format alone, decides REJECT.
test('detectMultiListingAd: two listing blocks priced in bare K/M (no "AED" anywhere) are still caught', () => {
  const text = [
    '3BR Villa | Arabian Ranches',
    '2400 sqft, handover ready',
    '5M',
    '',
    '---',
    '',
    '2BR Apartment | JVC',
    '1100 sqft, handover ready',
    '800K',
  ].join('\n');
  const result = detectMultiListingAd(text);
  assert.equal(result.matched, true);
});

test('detectMultiListingAd: a genuine buyer stating a bare budget ("budget 5M") is NEVER flagged as a listing', () => {
  const result = detectMultiListingAd('Looking for a villa, budget 5M, cash buyer only, 3-4BR');
  assert.equal(result.matched, false);
});

test('evaluateTriage: a genuine buyer with a bare "5M" budget and no AED token is never REJECTED as a listing', () => {
  const result = evaluateTriage('Looking for a villa, budget 5M, cash buyer only, 3-4BR', { aliasIndex: {} });
  assert.notEqual(result.decision, 'REJECT');
});

test('evaluateTriage: obvious junk (roommate wanted) is REJECTED via the underlying primary gate', () => {
  const result = evaluateTriage('Looking for a roommate to share my flat', { aliasIndex: {} });
  assert.equal(result.decision, 'REJECT');
  assert.equal(result.reason, 'non_property_request');
});

test('evaluateTriage: ambiguous/hedged content routes to AI_REVIEW, never guessed locally', () => {
  const result = evaluateTriage(
    'Client is considering something around the canal, maybe BB or Downtown, can stretch depending on the payment plan',
    { aliasIndex: { area: new Map([['businessbay', { canonical: 'Business Bay' }]]) } }
  );
  assert.equal(result.decision, 'AI_REVIEW');
});

test('evaluateTriage: a confident, unambiguous buyer request with alias-resolvable location -> PARSED_LOCALLY', () => {
  const aliasIndex = { area: new Map([['businessbay', { canonical: 'Business Bay' }]]) };
  const result = evaluateTriage('Need 2BR Business Bay max 2.5M cash', { aliasIndex });
  assert.equal(result.decision, 'PARSED_LOCALLY');
  assert.equal(result.localValue.area, 'Business Bay');
});

test('evaluateTriage: no location resolvable locally -> AI_REVIEW (never guessed, never INSUFFICIENT_CRITERIA at this stage)', () => {
  const result = evaluateTriage('Need 2BR max 2.5M cash', { aliasIndex: {} });
  assert.equal(result.decision, 'AI_REVIEW');
});

// ---- AUDIT item #2: unresolved-specific-location escalation ----
// "The Edge" is not a known building alias here (same as production
// reality until it is added), so the local parser resolves only
// area="Business Bay". Rather than trust that as PARSED_LOCALLY and let
// the matcher silently broaden to the whole area, this must escalate to
// AI_REVIEW so OpenAI gets a chance to recognize "The Edge" as a project.

test('evaluateTriage: "Need 1BR The Edge Business Bay max 1.3M" escalates to AI_REVIEW instead of PARSED_LOCALLY (The Edge unresolved)', () => {
  const result = evaluateTriage('Need 1BR The Edge Business Bay max 1.3M', { aliasIndex: BUSINESS_BAY_ALIAS_INDEX });
  assert.equal(result.decision, 'AI_REVIEW');
  assert.equal(result.reason, 'possible_unresolved_specific_location');
  assert.equal(result.localValue, null, 'AI_REVIEW never carries a trusted local value forward');
});

test('needsLocationAmbiguityEscalation: true only when area alone resolved and a leftover capitalized run remains', () => {
  assert.equal(
    needsLocationAmbiguityEscalation('Need 1BR The Edge Business Bay max 1.3M', { area: 'Business Bay', project: null, building: null }),
    true
  );
  // A resolved project/building is already the most specific level there
  // is -- nothing left to lose to a broad area match, so no escalation.
  assert.equal(
    needsLocationAmbiguityEscalation('Need 1BR The Edge Business Bay max 1.3M', { area: 'Business Bay', project: 'The Edge', building: null }),
    false
  );
  assert.equal(needsLocationAmbiguityEscalation('Need 2BR Business Bay max 2.5M cash', { area: 'Business Bay', project: null, building: null }), false);
});

// These four are real buyer-language examples that must never be starved
// of a match just because they contain a capitalized word/phrase the
// local parser can't rule out on its own -- this documents that they are
// (correctly) treated as ambiguous-enough-to-ask-AI rather than being
// guessed locally, exactly the intended replacement for an ever-growing
// stopword list. The pipeline-level tests (pipeline.test.js) prove the
// end-to-end outcome once AI reviews them is NOT unresolved_specific_location.
for (const text of [
  'Need 2BR Business Bay Cash Buyer',
  'Need 2BR Business Bay Urgent',
  'Need 2BR Business Bay High Floor',
  'Need Apartment Business Bay Canal View',
]) {
  test(`evaluateTriage: "${text}" is escalated to AI_REVIEW rather than silently NO_MATCHed locally`, () => {
    const result = evaluateTriage(text, { aliasIndex: BUSINESS_BAY_ALIAS_INDEX });
    assert.equal(result.decision, 'AI_REVIEW');
    assert.equal(result.reason, 'possible_unresolved_specific_location');
  });
}
