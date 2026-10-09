'use strict';

// System prompt for the single OpenAI call that does both classification
// and structured parsing (TZ 24-27). The directional-demand distinction
// (TZ 16-17, 28) is the load-bearing part of this prompt -- it is the fix
// for a real production incident where a broker-solicitation ad phrased as
// "Have a client looking to buy? Send us your client's requirements" was
// accepted as a genuine buyer request by the old regex-only gate.
const SYSTEM_PROMPT = `Classify a Dubai real-estate social message and extract buyer criteria. Return JSON with exactly these fields.

\`message_class\` — one of:

* \`buyer_request\`: sender states a buy/rent requirement for themselves or their client.
* \`seller_request\`: sender is looking for a buyer for property they/their client owns or sells.
* \`inventory_ad\`: sender advertises available property/project stock.
* \`broker_solicitation\`: sender asks other agents to send buyers/clients/leads, e.g. "Do you have a buyer?", "Send us your client's requirements", "Agents welcome". Never classify this as \`buyer_request\`.
* \`general_advertisement\`: promotion of a business/service/event/job, not a specific property requirement.
* \`other\`: real-estate related but none of the above.
* \`unknown\`: unclear.

\`demand_owner\` — one of:

* \`sender\`: the sender has the property requirement for themselves or a client they represent.
* \`recipient\`: the sender asks the reader to provide a client/buyer/lead.
* \`unknown\`: unclear.

Judge demand ownership by who actually has the requirement, not by keywords such as "client", "buyer", "looking", "requirements", "budget", or "bedrooms".

A request is matchable only when:
\`message_class = buyer_request\` AND \`demand_owner = sender\`.

Directional examples (not an exhaustive list -- judge by meaning, not by matching these exact phrases):

* "I am looking for a 2BR in Business Bay" → \`buyer_request\`, \`sender\`.
* "I have a client looking for a villa in Arabian Ranches" → \`buyer_request\`, \`sender\` (the sender represents the client's demand).
* "For sale: 2BR in Marina, 2.5M" / "For rent: studio in JVC" → \`inventory_ad\` (the sender is offering property, not requesting it).
* "Сдам 2BR в Marina" / "Сдаю квартиру в JVC" / "Продам виллу" / "Продаю" / "от собственника" → \`inventory_ad\` or \`seller_request\` (Russian for "I am renting out" / "I am selling" / "from the owner" -- the sender is the SUPPLY side, offering property, never a buyer/renter demand, regardless of language). Never classify these as \`buyer_request\`.
* "Ищу 2BR в Marina" / "Ищу клиенту виллу" → \`buyer_request\`, \`sender\` (Russian for "I am looking for" -- a genuine demand, same as the English "looking for" examples above).
* "Do you have a buyer for my listing?" / "Send us your client's requirements" → \`broker_solicitation\`, never \`buyer_request\`.

This directional judgment applies in any language the message is written in (Russian, English, or mixed) -- it is about who has the requirement, not about which language or keyword is used.

\`promotion\` — boolean. True when primarily advertising listings, inventory, services or business. Co-broke solicitations, "agents welcome", commission mentions, and volume claims such as "500+ units available" count as promotion.

\`spam\` — boolean. True for scams, phishing, unrelated or worthless content.

Only when \`message_class = buyer_request\` AND \`demand_owner = sender\`, extract:

* \`transaction_type\`: \`SALE\`, \`RENT\`, or null.
* \`area\`: explicitly stated district/community only. Never infer area from a known project/building. When more than one is named, put the FIRST one here too (for backward compatibility) but see \`areas\` below.
* \`areas\`: an array of EVERY district/community the buyer says they would accept, in the order named. A buyer often names several ("Dubai Silicon Oasis, Warsan, Al Furjan or Bur Dubai", "A or B", "any of: X, Y, Z") -- list every one of them separately, never pick just one and never merge them into a single string. A single-area buyer still gets a one-element array. Same "explicitly stated only, never inferred" rule as \`area\`.
* \`project\`: explicitly stated project/sub-development, or null.
* \`building\`: explicitly stated building/tower, or null.
* \`property_type\`: stated real-estate type such as Apartment, Villa, Townhouse, Penthouse, Studio, Duplex, Office, Retail, Land, Building, or null.
* \`bedrooms_min\`, \`bedrooms_max\`: integers or null.

  * \`2BR\` → 2,2
  * \`2-3BR\` → 2,3
  * \`3BR+\` → 3,null
  * Studio → 0,0
  * Maid room does not count.
* \`budget_min\`, \`budget_max\`: AED numbers or null.

  * Single amount, including "budget 2.5M", "max 2.5M", "up to 2.5M", or bare amount → set \`budget_max\` only.
  * Set \`budget_min\` only for explicit minimum/floor wording.
  * Range \`2-2.5M\` → both.
* \`furnishing\`: \`Furnished\`, \`Unfurnished\`, \`Semi-Furnished\`, or null.
* \`cash_buyer\`: true, false, or null.
* \`bathrooms_min\`, \`bathrooms_max\`: integers or null, same range rules as bedrooms.
* \`size_sqft_min\`, \`size_sqft_max\`: numbers or null, only when an explicit sqft figure is stated.
* \`plot_size_sqft_min\`, \`plot_size_sqft_max\`: numbers or null, only when an explicit plot-size sqft figure is stated.
* \`confidence\`: 0-1.

If the message is not a sender-owned \`buyer_request\`, all extraction fields must be null.

Never infer missing values. Use null unless explicitly stated.`;

function buildMessages(originalText) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: originalText },
  ];
}

module.exports = { SYSTEM_PROMPT, buildMessages };
