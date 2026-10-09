'use strict';

// Small pieces of ALREADY-DECIDED reasoning for Moscow's settings page
// (dashboard/settings-view.js's renderMoscowNotLiveBanner/renderAiSection/
// renderBuyerGateSection) -- transcribed from
// docs/PER_MARKET_SERVICE_INDEPENDENCE_PLAN.md sections 5.2/5.3/5.5.
//
// The actual BLACKLIST/WHITELIST rule content itself is NOT duplicated
// here any more (2026-09-28): it was seeded as real, editable rows in
// matching_moscow.intake_rules by migration 0029, and is now shown/edited
// on Moscow's /settings?market=moscow page exactly like UAE's own rules --
// the user explicitly asked for "the same as /settings, with the same
// parameters", not a separate static reference page. This module only
// keeps the prose reasoning that doesn't belong as a DB row.

const AI_PARSER_DECISION = {
  summary: 'Москва получит собственный системный промпт и собственную схему разобранного запроса (JSON), но не отдельную инфраструктуру ИИ-клиента.',
  reasoning: 'Схема запроса для Москвы реально отличается от ОАЭ: округ/район/ЖК/метро вместо area/building/project; рубли вместо AED; кв. м вместо кв. футов; «комнаты» — отдельное от «спален» понятие. Поэтому промпт и выходная схема должны быть собственными. При этом вызов ИИ, повторные попытки и кэширование могут использовать ту же инфраструктуру lead-matching-service, что и ОАЭ — общая только техническая часть, не содержание промпта.',
};

const RUNTIME_SETTINGS_DECISION = {
  summary: 'Стартовые значения переиспользуют текущие дефолты ОАЭ (переключатели дедупликации, срок кэша содержимого/ИИ, допуск по бюджету, политика решения) — с ОДНИМ подтверждённым исключением: property_signal_threshold = 0, а не 1, как у ОАЭ.',
  reasoning: 'У ОАЭ порог 1 предполагает, что в группе PROPERTY_SIGNAL есть затравочные правила, которые могут сработать. Для Москвы эта группа решено оставить пустой на старте — значит счётчик срабатываний PROPERTY_SIGNAL никогда не достигнет 1, и порог «1» отклонял бы вообще ВСЕ сообщения, независимо от очевидности намерения купить. Порог «0» выполняется всегда, поэтому сигнала WHITELIST одного достаточно — до тех пор, пока для Москвы не появятся реальные правила PROPERTY_SIGNAL, после чего порог нужно будет пересмотреть.',
};

// Corrected 2026-10-06 (user noticed this still claimed the real matcher
// didn't exist): ADR-038 (2026-09-29) shipped a real matcher for Moscow --
// weights ARE decided (Location/Price/Rooms/Type = 50/30/15/5, identical to
// Dubai's own shape, see rf-lead-matching-service/src/matching/scoring.js)
// and ADR-042 (2026-10-05) enabled real RENT buyer requests end-to-end too.
// The rules/thresholds below are genuinely load-bearing -- but ONLY once
// `v2_intake_cutover_enabled` is turned on (see the "Шлюз приёма V2" section
// below); while it's off, every event still resolves to NOT_IMPLEMENTED,
// same as before the matcher existed.
const STILL_OPEN_NOTE = 'Правила и пороги ниже реально сохраняются в БД (matching_moscow) и полностью независимы от настроек Дубая. Реальный сопоставитель объектов для Москвы уже существует и работает (ADR-038/ADR-042) — веса скоринга (Локация/Цена/Комнаты/Тип = 50/30/15/5, как у Дубая) решены и применяются к реальным сообщениям, как только включён «Шлюз приёма V2 — рабочий режим» ниже; пока он выключен, события по-прежнему возвращают NOT_IMPLEMENTED.';

module.exports = {
  AI_PARSER_DECISION,
  RUNTIME_SETTINGS_DECISION,
  STILL_OPEN_NOTE,
};
