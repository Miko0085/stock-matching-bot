'use strict';

// Presentation-layer mapping ONLY (Settings UI simplification task,
// 2026-09-27) -- friendly names/descriptions/examples for intake rules and
// rule groups, keyed by the REAL pattern text seeded in
// matching_dubai.intake_rules (verified against production, 41 rows, 2026-09-27)
// and by the real backend enum values (RULE_GROUP / buyer_signal_policy).
//
// This file must never be imported by anything under src/gates/**,
// src/matching/**, or src/services/** -- it is purely how
// dashboard/settings-view.js (and shadow-view.js's rule-hit table) LABEL
// data that the backend already produces. It never changes what a pattern
// matches, never changes precedence, and is not consulted by
// evaluateV2IntakeGate() or any other business logic.
//
// A pattern with no entry here is not an error -- getRuleFriendlyName()
// falls back to the rule's own `description` column, then to the raw
// pattern itself, so a newly-added rule is always presentable even before
// anyone updates this file.

const RULE_GROUP_UI = {
  BLACKLIST: {
    title: 'Заблокированные сообщения',
    subtitle: 'Спам продавцов и объявления',
    explanation: 'Сообщения, подходящие под эти правила, отклоняются ещё до отправки в ИИ. Используйте для явных объявлений о продаже/сдаче от собственников, рассылок брокеров и нерелевантного трафика.',
  },
  WHITELIST: {
    title: 'Намерение купить',
    subtitle: null,
    explanation: 'Слова и фразы, указывающие, что человек ищет объект недвижимости.',
  },
  PROPERTY_SIGNAL: {
    title: 'Детали объекта',
    subtitle: null,
    explanation: 'Признаки того, что сообщение описывает недвижимость: цена, спальни, площадь, этаж, срок сдачи и т.д.',
  },
  SEND_TO_AI: {
    title: 'Всегда отправлять в ИИ',
    subtitle: null,
    explanation: 'Исключения, которые всегда должны проверяться ИИ, даже если обычных правил «намерение купить»/«детали объекта» недостаточно.',
  },
};

const BUYER_SIGNAL_POLICY_UI = {
  REQUIRE_ANY: {
    label: 'Достаточно любого сигнала',
    description: 'Отправлять в ИИ, если обнаружено намерение купить ИЛИ детали объекта.',
  },
  REQUIRE_BOTH: {
    label: 'Требовать оба сигнала',
    description: 'Отправлять в ИИ, только если обнаружены и намерение купить, И детали объекта.',
  },
};

// Keyed by the exact `pattern` column value -- verified against every one
// of the 41 rows actually seeded in production as of 2026-09-27 (see
// docs/SETTINGS_UI_SIMPLIFICATION.md for how to re-verify/extend this).
const RULE_PATTERN_UI = {
  // -- BLACKLIST (broker solicitation + seller-offer signals) --
  '\\bdo\\s+you\\s+have\\s+(?:a\\s+)?(?:buyer|client)s?\\b': {
    name: 'Есть ли у вас покупатель?',
    description: 'Брокер ищет чужого покупателя/клиента — не сам покупатель.',
    example: '"Do you have any buyers for a 2BR in Marina?"',
  },
  '\\bhave\\s+a\\s+client\\s+looking\\s+to\\s+buy\\b': {
    name: 'У меня есть клиент, который хочет купить',
    description: 'Классическая формулировка брокерской рассылки, а не запроса покупателя.',
    example: '"Have a client looking to buy in JVC"',
  },
  '\\bsend\\s+(?:us|me)\\s+your\\s+client\'?s?\\s+requirements?\\b': {
    name: 'Пришлите требования вашего клиента',
    description: 'Брокер собирает чужих клиентов — типичная фраза рассылки, не запрос от покупателя.',
    example: '"Send us your client\'s requirements"',
  },
  '\\bagents?\\s+(?:are\\s+)?(?:always\\s+)?welcome\\b': {
    name: 'Агенты приветствуются',
    description: 'Фраза из объявления о сотрудничестве с брокерами.',
    example: '"Agents are always welcome!"',
  },
  '\\bbuyer[\\s-]side\\s+commission\\s+is\\s+(?:100%\\s+)?yours\\b': {
    name: 'Комиссия покупателя — ваша',
    description: 'Предложение комиссии брокерам, не запрос покупателя.',
    example: '"Buyer-side commission is 100% yours"',
  },
  '\\bdo\\s+you\\s+have\\s+a\\s+client\\s+looking\\s+for\\b': {
    name: 'Есть ли клиент, который ищет?',
    description: 'Брокер ищет чужого клиента для объекта.',
    example: '"Do you have a client looking for a villa?"',
  },
  '^\\s*(?:🏠\\s*)?for\\s+(?:sale|rent)\\b': {
    name: 'Объявление начинается с «For Sale»/«For Rent»',
    description: 'Заголовок объявления о продаже/аренде объекта.',
    example: '"🏠 For Sale: 2BR in Business Bay"',
  },
  'сдам': { name: 'Сдам', description: 'Собственник сдаёт объект — предложение, не запрос.', example: '"Сдам 1-комнатную в Дубай Марине"' },
  'сдаю': { name: 'Сдаю', description: 'Собственник сдаёт объект — предложение, не запрос.', example: '"Сдаю студию возле метро"' },
  'сдаётся': { name: 'Сдаётся', description: 'Объявление о сдаче объекта.', example: '"Сдаётся 2-комнатная квартира"' },
  'сдается': { name: 'Сдается', description: 'Объявление о сдаче объекта (написание без ё).', example: '"Сдается квартира в центре"' },
  'продам': { name: 'Продам', description: 'Собственник продаёт объект — предложение, не запрос.', example: '"Продам виллу в Дубае"' },
  'продаю': { name: 'Продаю', description: 'Собственник продаёт объект — предложение, не запрос.', example: '"Продаю апартаменты с видом на море"' },
  'продаётся': { name: 'Продаётся', description: 'Объявление о продаже объекта.', example: '"Продаётся 3-комнатная квартира"' },
  'продается': { name: 'Продается', description: 'Объявление о продаже объекта (написание без ё).', example: '"Продается студия в новостройке"' },
  'от собственника': { name: 'От собственника', description: 'Прямое объявление владельца — не запрос покупателя.', example: '"Сдам от собственника, без комиссии"' },

  // -- WHITELIST (buyer intent) --
  '\\bneed(?:s|ed)?\\b': { name: 'Нужен / нужно', description: 'Слово «need/needs/needed» указывает на потребность в объекте.', example: '"I need a 2BR apartment in Dubai Marina"' },
  '\\blooking\\s+for\\b': { name: 'Ищу (looking for)', description: 'Классическая фраза поиска объекта покупателем.', example: '"Looking for a studio in Dubai Marina"' },
  '\\blooking\\s+to\\s+buy\\b': { name: 'Хочу купить (looking to buy)', description: 'Прямое намерение купить объект.', example: '"Looking to buy a villa in Arabian Ranches"' },
  '\\blooking\\s+to\\s+rent\\b': { name: 'Хочу снять (looking to rent)', description: 'Прямое намерение снять объект.', example: '"Looking to rent a 1BR near Marina Mall"' },
  '\\bmy\\s+client\\s+needs?\\b': { name: 'Моему клиенту нужно', description: 'Брокер описывает потребность СВОЕГО клиента (не рассылку в поисках чужого).', example: '"My client needs a 3BR villa with pool"' },
  '\\bmy\\s+client\\s+is\\s+looking\\s+for\\b': { name: 'Мой клиент ищет', description: 'Брокер описывает поиск СВОЕГО клиента.', example: '"My client is looking for a 2BR in Business Bay"' },
  '\\bclient\\s+requirement\\b': { name: 'Требования клиента', description: 'Описание требований конкретного клиента, а не сбор чужих клиентов.', example: '"Client requirement: 2BR, budget 1.5M"' },
  '\\bwtb\\b': { name: 'WTB (want to buy)', description: 'Сокращение «want to buy» — хочу купить.', example: '"WTB 1BR in JVC, ready unit"' },
  '\\brequired\\b': { name: 'Требуется', description: 'Слово «required» указывает на потребность в объекте.', example: '"2BR apartment required in Downtown"' },
  '\\bseeking\\b': { name: 'В поисках (seeking)', description: 'Слово «seeking» указывает на активный поиск объекта.', example: '"Seeking a family villa in Arabian Ranches"' },
  'ищу': { name: 'Ищу', description: 'Прямое указание на поиск объекта от первого лица.', example: '"Ищу 2-комнатную квартиру в Дубай Марине"' },
  'нужен': { name: 'Нужен', description: 'Потребность в объекте мужского рода (дом, объект).', example: '"Нужен дом с бассейном"' },
  'нужна': { name: 'Нужна', description: 'Потребность в объекте женского рода (квартира, студия).', example: '"Нужна квартира возле метро"' },
  'сниму': { name: 'Сниму', description: 'Намерение снять объект в аренду от первого лица.', example: '"Сниму студию в центре Дубая"' },
  'клиенту нужен': { name: 'Клиенту нужен', description: 'Брокер описывает потребность клиента (мужской род).', example: '"Клиенту нужен пентхаус с видом на море"' },
  'клиенту нужна': { name: 'Клиенту нужна', description: 'Брокер описывает потребность клиента (женский род).', example: '"Клиенту нужна вилла с садом"' },

  // -- PROPERTY_SIGNAL (real-estate details) --
  '\\b\\d+\\s*br\\b': { name: 'Спальни: 1BR / 2BR / 3BR…', description: 'Количество спален в формате «NBR».', example: '"2BR apartment"' },
  '\\b\\d+\\s*bd\\b': { name: 'Спальни: 1BD / 2BD / 3BD…', description: 'Количество спален в формате «NBD».', example: '"3BD villa"' },
  'bedrooms?\\s*:': { name: 'Поле «Bedrooms:»', description: 'Явное поле количества спален в формате объявления.', example: '"Bedrooms: 2"' },
  '\\bsqft\\b': { name: 'Площадь в sqft', description: 'Площадь объекта в квадратных футах.', example: '"1200 sqft apartment"' },
  'sq\\.?\\s*ft': { name: 'Площадь в sq ft', description: 'Площадь объекта в квадратных футах (вариант написания).', example: '"1,500 sq. ft."' },
  '\\bhandover\\b': { name: 'Срок сдачи (handover)', description: 'Упоминание срока сдачи объекта.', example: '"Handover Q4 2026"' },
  '\\bfloor\\b': { name: 'Этаж', description: 'Упоминание этажа объекта.', example: '"High floor, sea view"' },
  'view\\s*:': { name: 'Поле «View:»', description: 'Явное поле с описанием вида из окна.', example: '"View: Sea view"' },
  '\\baed\\b': { name: 'Цена в AED', description: 'Упоминание цены в дирхамах ОАЭ.', example: '"Budget up to 1,500,000 AED"' },
};

function getRuleGroupUi(ruleGroup) {
  return RULE_GROUP_UI[ruleGroup] || { title: ruleGroup, subtitle: null, explanation: '' };
}

function getBuyerSignalPolicyUi(policy) {
  return BUYER_SIGNAL_POLICY_UI[policy] || { label: policy, description: '' };
}

// Never throws, never returns an empty name -- always at least the raw
// pattern, so an unmapped/newly-added rule is still presentable.
function getRuleFriendlyName(rule) {
  const ui = RULE_PATTERN_UI[rule.pattern];
  if (ui) return ui.name;
  if (rule.description) return rule.description;
  return rule.pattern;
}

function getRuleFriendlyDescription(rule) {
  const ui = RULE_PATTERN_UI[rule.pattern];
  if (ui) return ui.description;
  return rule.description || null;
}

function getRuleExample(rule) {
  const ui = RULE_PATTERN_UI[rule.pattern];
  return ui ? ui.example : null;
}

module.exports = {
  RULE_GROUP_UI,
  BUYER_SIGNAL_POLICY_UI,
  RULE_PATTERN_UI,
  getRuleGroupUi,
  getBuyerSignalPolicyUi,
  getRuleFriendlyName,
  getRuleFriendlyDescription,
  getRuleExample,
};
