'use strict';

// Primary Lead Gate (TZ 15-19) -- a cheap, deterministic pre-filter that
// runs BEFORE the OpenAI call. Its only job is to keep obvious non-property
// junk and obvious spam from burning an AI call; it must NOT attempt to
// decide buyer intent, advertisement-vs-request, or demand direction --
// that is explicitly reserved for the AI classifier (TZ 19).
//
// This is a deliberate architectural fix over the old production
// `Raw Monitor Primary Lead Gate`/`classifyIntentV2`, whose weighted
// "hasDemand && positiveScore>=5 -> ACCEPT" rule used words like `client`,
// `looking`, `buyer`, `requirements` as ACCEPT signals with no notion of
// which party the demand belongs to (TZ 16-17) -- a real production
// incident: a broker-solicitation ad phrased as "Have a client looking to
// buy? Send us your client's requirements" tripped exactly those signals
// and got accepted as a genuine buyer request. The fix here is not a
// smarter regex -- it's to stop asking regex to make that call at all.

const NON_PROPERTY_REQUEST_PATTERNS = [
  // Roommate / room-sharing posts frequently reuse "looking for"/"need" in
  // ways that otherwise resemble a property request.
  /\b(?:roommate|room\s*mate|flatmate|flat\s*mate|share\s+(?:an?\s+)?(?:apartment|flat|room))\b/i,
  /(?:сосед(?:ку|а|ей|у|ка|ями|ки)?|подселени\w*|шеринг\s*комнат\w*)/u,
  // Unrelated services that happen to be common in the same broker groups.
  /\b(?:nail\s+(?:artist|salon)|dance\s+(?:class|studio)|beauty\s+salon)\b/i,
  /(?:мастер(?:а|у)?\s+по\s+ногт|ногт(?:и|ей|ям)|препода(?:ют|ватель)|хай\s*хилз|танцевальн(?:ая|ую)\s+студи|салон\s+красоты|хоум\s+сервис)/u,
];

const PROPERTY_DOMAIN_KEYWORDS = [
  // English
  /\bstudio\b/i,
  /\bapartment\b/i,
  /\bflat\b/i,
  /\bvilla\b/i,
  /\btownhouse\b/i,
  /\bpenthouse\b/i,
  /\bduplex\b/i,
  /\bproperty\b/i,
  /\bplot\b/i,
  /\bunit\b/i,
  /\d+\s*br\b/i,
  /\d+\s*bed(?:room)?s?\b/i,
  /\bsq\.?\s*ft\b/i,
  /\bfurnished\b/i,
  /\bunfurnished\b/i,
  /\boff[\s-]plan\b/i,
  /\bready\s+to\s+move\b/i,
  /\brent(?:al)?\b/i,
  /\bsale\b/i,
  /\bmortgage\b/i,
  /\bbudget\b/i,
  // Russian
  /студи[яию]/u,
  /квартир[аы]/u,
  /апартамент/u,
  /вилл[аы]/u,
  /таунхаус/u,
  /пентхаус/u,
  /недвижимость/u,
  /\d+\s*спальн(?:я|и|ю)/u,
  /кв\.?\s*м\b/iu,
  /м²/u,
  /бюджет/u,
  /аренд/u,
  /продаж/u,
];

function normalize(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .trim();
}

function matchedPatternNames(text, patterns) {
  return patterns.filter((p) => p.test(text)).map((p) => p.source.slice(0, 40));
}

// Returns { passed, decision, positive_signals, negative_signals, reason }
// (TZ 18). `decision` is either 'review_with_ai' (goes to OpenAI next) or
// 'rejected' (never reaches OpenAI, TZ 15/18).
function evaluatePrimaryLeadGate(originalText) {
  const text = normalize(originalText);

  if (!text) {
    return { passed: false, decision: 'rejected', positive_signals: [], negative_signals: [], reason: 'empty_text' };
  }

  const nonPropertyHits = matchedPatternNames(text, NON_PROPERTY_REQUEST_PATTERNS);
  if (nonPropertyHits.length) {
    return {
      passed: false,
      decision: 'rejected',
      positive_signals: [],
      negative_signals: ['non_property_request'],
      reason: 'non_property_request',
    };
  }

  // Deliberately does NOT require a property-domain keyword to pass, and
  // does NOT attempt buyer-vs-seller-vs-solicitation classification --
  // TZ 15 scopes this gate to "obvious junk and obvious advertising" only,
  // final classification belongs entirely to the AI (TZ 19, 26). A bare
  // area name in a buyer-request group (TZ 91's "Business Bay" example)
  // must still reach the AI/matcher so the INSUFFICIENT_CRITERIA gate --
  // not this cheap pre-filter -- is what reports it as underspecified.
  const propertyHits = matchedPatternNames(text, PROPERTY_DOMAIN_KEYWORDS);
  return {
    passed: true,
    decision: 'review_with_ai',
    positive_signals: propertyHits.length ? ['property_domain_keyword'] : [],
    negative_signals: [],
    reason: null,
  };
}

module.exports = { evaluatePrimaryLeadGate };
