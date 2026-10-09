'use strict';

// A cheap, real-estate-specific pre-screen run BEFORE the AI parser call (in
// our own additive branch only — never touches the production classifier).
// The upstream `rawFilterV2` buyer-intent signal is too broad: its
// "explicit_buyer_demand" pattern matches bare "ищу"/"looking for" with no
// property context at all, so job ads, casting calls, and services posts
// ("Ищу к себе в команду...", "Ищу модель для съёмки...") pass it and burn
// an OpenAI call before the AI parser correctly rejects them
// (buying_intent: false). This requires an explicit property-domain
// keyword hit in addition to that signal.

const PROPERTY_KEYWORDS = [
  // English
  /\bstudio\b/i,
  /\bapartment\b/i,
  /\bflat\b/i,
  /\bvilla\b/i,
  /\btownhouse\b/i,
  /\bpenthouse\b/i,
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
  // Russian
  /студи[яию]/u, // студия/студии/студию
  /квартир[аы]/u, // квартира/квартиры
  /апартамент/u,
  /вилл[аы]/u, // вилла/виллы
  /таунхаус/u,
  /пентхаус/u,
  /недвижимость/u,
  /\d+\s*спальн(?:я|и|ю)/u, // N спальня/спальни/спальню
  /кв\.?\s*м\b/iu, // кв.м / кв м
  /м²/u,
];

function looksLikePropertyRequest(text) {
  const value = String(text || '');
  if (!value.trim()) return false;
  return PROPERTY_KEYWORDS.some((pattern) => pattern.test(value));
}

module.exports = { looksLikePropertyRequest };
