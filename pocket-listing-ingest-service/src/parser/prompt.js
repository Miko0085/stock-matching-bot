'use strict';

// System prompt for the single OpenAI call that classifies+extracts ONE
// WhatsApp message from the "Secondary Nika Estate" pocket-listing group.
// This is the SUPPLY side (a property being offered for sale/rent), the
// opposite direction from dubai-lead-matching-service's own buyer-request
// prompt -- built independently, not reused, since the classification
// question itself is different: not "who has the demand" but "does this
// message describe a specific, identifiable property being offered."
// Real Dubai areas used in examples (ADR-047's lesson: never leave another
// market's city/area names in a prompt built for a different one).
const SYSTEM_PROMPT = `Classify a WhatsApp message from a Dubai real-estate "pocket listings" group and extract property details, if any. Return JSON with exactly these fields.

\`is_listing\` — true only when the message describes a SPECIFIC, identifiable property being offered for sale or rent, with at least one concrete, verifiable detail (an area/building name, a property type, a price, a size, or a bedroom count). false for everything else: personal chat between colleagues, questions, scheduling, general commentary, or a vague "I have options available, DM me" with no actual property described.

Directional examples (not exhaustive -- judge by meaning):

* "3BR + maid in Business Bay, Ohana - Jacob & Co, mid floor, AED 7.75M, handover 2028" → \`is_listing\`: true.
* "Distress deal, Al Barari villa, 6BR, AED 78M, vacant" → \`is_listing\`: true.
* "Кто-нибудь видел ключи от переговорки?" → \`is_listing\`: false (office chat, no property).
* "Добавьте меня в группу по новостройкам, пожалуйста" → \`is_listing\`: false (no property described).
* "Have some good off-market deals, message me for details" → \`is_listing\`: false (no actual property named or specified -- a vague pitch with zero verifiable details is not a listing).
* "Коллеги, созвон в 15:00 по текущим сделкам" → \`is_listing\`: false (scheduling, not a listing).

Only when \`is_listing\` is true, extract:

* \`city\`: the city the property is in (e.g. "Dubai", "Abu Dhabi", "Sharjah"), explicitly stated or unambiguously implied by a named Dubai-only area/building. null if genuinely unclear.
* \`area\`: the district/community (e.g. "Business Bay", "Dubai Creek Harbour", "Al Barari"), explicitly stated only, never inferred from a building name you don't recognize.
* \`building\`: the building/tower/project name, explicitly stated only.
* \`property_type\`: one of Apartment, Villa, Townhouse, Penthouse, Studio, Duplex, Office, Retail, Land, Building, or null.
* \`bedrooms\`: integer, or null. "Studio" → 0. "3BR" → 3.
* \`bathrooms\`: number, or null.
* \`selling_price\`: AED number, sale price, or null. Never guess from a rent figure.
* \`annual_rent\`: AED number, yearly rent, or null. Never guess from a sale price.
* \`size_sqft\`: number, or null.
* \`plot_size_sqft\`: number, or null (villas/townhouses/land only).
* \`furnishing\`: "Furnished", "Unfurnished", "Semi-Furnished", or null.
* \`view\`: a stated view description (e.g. "Full Sea & Sunset View"), or null.
* \`distress\`: true only when the message explicitly signals a distressed/below-market/urgent-sale deal (e.g. "distress", "urgent sale", "below OP", "price reduced"). false otherwise.
* \`confidence\`: 0-1, your confidence that \`is_listing\` and the extracted fields are correct.

If \`is_listing\` is false, every other field must be null/false.

Never infer a value that is not stated or unambiguously implied. When in doubt about whether something is a genuine listing, prefer false.`;

function buildMessages(originalText) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: originalText },
  ];
}

module.exports = { SYSTEM_PROMPT, buildMessages };
