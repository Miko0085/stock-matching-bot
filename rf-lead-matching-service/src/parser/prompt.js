'use strict';

// Moscow's own system prompt (2026-09-29) -- built BY ANALOGY with
// lead-matching-service/src/parser/prompt.js's directional-demand
// distinction (the same real incident that prompt fixes for UAE applies
// here word-for-word: a broker soliciting other agents' clients must
// never be classified as a genuine buyer request), but re-expressed over
// Moscow's own real field set (округ/район, ЖК, комнаты vs спальни,
// рубли, кв.м -- docs/MARKET_CONTOURS_AND_SOURCE_ROUTING.md section 5,
// docs/PER_MARKET_SERVICE_INDEPENDENCE_PLAN.md section 5.1.1/5.3). Never
// imported by lead-matching-service or vice versa -- the two markets'
// prompts must be free to diverge independently.
const SYSTEM_PROMPT = `Классифицируй сообщение о недвижимости в Москве и извлеки критерии покупателя. Верни JSON строго со следующими полями.

\`message_class\` — одно из:

* \`buyer_request\`: отправитель формулирует требование к покупке/аренде для себя или своего клиента.
* \`seller_request\`: отправитель ищет покупателя на объект, которым владеет он или его клиент.
* \`inventory_ad\`: отправитель рекламирует объект/сток, доступный к продаже.
* \`broker_solicitation\`: отправитель просит других агентов прислать покупателей/клиентов/заявки, например "Агентам рады", "Комиссия покупателя ваша", "Работаем с агентами". Никогда не классифицируй это как \`buyer_request\`.
* \`general_advertisement\`: реклама бизнеса/услуги/события, не конкретное требование к объекту.
* \`other\`: связано с недвижимостью, но не подходит под остальные категории.
* \`unknown\`: непонятно.

\`demand_owner\` — одно из:

* \`sender\`: у отправителя (или его клиента, которого он представляет) есть требование к объекту.
* \`recipient\`: отправитель просит читателя предоставить клиента/покупателя/заявку.
* \`unknown\`: непонятно.

Определяй владельца потребности по смыслу, а не по ключевым словам вроде "клиент", "покупатель", "ищу", "нужен", "бюджет".

Заявка пригодна для сопоставления только когда:
\`message_class = buyer_request\` И \`demand_owner = sender\`.

Примеры (не исчерпывающий список — суди по смыслу, а не по точному совпадению фраз):

* "Ищу 2-комнатную в ЮЗАО" → \`buyer_request\`, \`sender\`.
* "Ищу для клиента 3-комнатную в Хамовниках" → \`buyer_request\`, \`sender\` (отправитель представляет потребность клиента).
* "Сниму квартиру в Строгино, бюджет до 60 тысяч" → \`buyer_request\`, \`sender\`, \`transaction_type: RENT\` (съёмщик ищет объект — тоже сторона спроса, не предложения).
* "Сдам квартиру в центре" / "Продам виллу" / "Продаю" / "от собственника" → \`inventory_ad\` или \`seller_request\` (отправитель — сторона предложения, а не спроса). Никогда не классифицируй это как \`buyer_request\`.
* "Агентам рады, комиссия покупателя ваша" / "Работаем с агентами" → \`broker_solicitation\`, никогда не \`buyer_request\`.

\`promotion\` — булево. Истина, если сообщение в первую очередь рекламирует объекты/услуги/бизнес.

\`spam\` — булево. Истина для мошенничества, фишинга, нерелевантного или бесполезного контента.

Только когда \`message_class = buyer_request\` И \`demand_owner = sender\`, извлеки:

* \`transaction_type\`: \`SALE\`, \`RENT\` или null.
* \`district\`: явно указанный округ/район (например "ЮЗАО", "Хамовники", "Тверской"). Никогда не выводи район из названия ЖК. Только явно названное.
* \`complex\`: явно указанное название ЖК/жилого комплекса, или null.
* \`property_type\`: указанный тип объекта — "квартира", "новостройка", "дом", "апартаменты" или null.
* \`rooms\`: число комнат (не спальни — это другое поле ниже). Целое число, "студия" → 0 с одновременным \`rooms_sentinel="STUDIO"\`, "свободная планировка" → null с \`rooms_sentinel="FREE_PLAN"\`, иначе \`rooms_sentinel\` = null.
* \`rooms_sentinel\`: \`STUDIO\`, \`FREE_PLAN\` или null — см. правило выше.
* \`bedrooms_min\`, \`bedrooms_max\`: целые числа или null — только если явно названо количество СПАЛЕН (не комнат), что в реальных сообщениях бывает редко.
* \`budget_min\`, \`budget_max\`: суммы В РУБЛЯХ или null. "15 млн" → 15000000. Одна сумма ("до 15 млн", "бюджет 15 млн") → только \`budget_max\`. Явный минимум → \`budget_min\`. Диапазон "15-20 млн" → оба поля.
* \`area_sqm_min\`, \`area_sqm_max\`: числа (квадратные метры) или null, только если явно названа площадь.
* \`floor_min\`, \`floor_max\`: целые числа или null, только если явно назван этаж.
* \`readiness_year\`: год сдачи/постройки или null, только если явно назван.
* \`cash_buyer\`: true, false или null.
* \`confidence\`: 0-1.

Если сообщение не является \`buyer_request\` от \`sender\`, все поля извлечения должны быть null.

Никогда не додумывай значения. Используй null, если не указано явно.`;

function buildMessages(originalText) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: originalText },
  ];
}

module.exports = { SYSTEM_PROMPT, buildMessages };
