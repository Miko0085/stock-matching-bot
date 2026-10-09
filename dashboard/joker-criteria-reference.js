'use strict';

// Metadata for the Moscow Settings page's "Критерии Joker (Москва/РФ)"
// section (docs/PER_MARKET_SERVICE_INDEPENDENCE_PLAN.md section 5.1.1/5.1.2,
// finalized 2026-09-28) -- field labels, stable setting keys, defaults, and
// normalization notes. Never imported by src/joker/** or any matching/
// business logic -- this file only describes what the criteria ARE; live
// on/off state lives in matching_moscow.runtime_settings (migration 0031),
// read by the caller and rendered as real toggles (dashboard/settings-view.js's
// renderJokerCriteriaReference), same Draft->Apply mechanism as every other
// setting on this page.
//
// `key` is the stable matching_moscow.runtime_settings.key for each
// criterion -- never derive it dynamically from the Russian label (fragile,
// breaks silently if a label is ever reworded).

const JOKER_CRITERIA = [
  { key: 'joker_property_type_enabled', field: 'Тип объекта', onByDefault: true, note: 'Коммерческая недвижимость исключена из подбора для покупателя' },
  { key: 'joker_city_enabled', field: 'Город', onByDefault: true, note: null },
  { key: 'joker_district_enabled', field: 'Округ/Район', onByDefault: true, note: 'нормализация: суффикс «р-н»/«р-он» убирается перед сравнением' },
  { key: 'joker_complex_enabled', field: 'ЖК/Комплекс', onByDefault: true, note: 'нормализация: убираются «ЖК»/«МФК»/кавычки «» и лишние пробелы' },
  { key: 'joker_rooms_enabled', field: 'Комнаты', onByDefault: true, note: '«Студия» и «Свободная планировка» — отдельные явные значения, не 0' },
  { key: 'joker_bedrooms_enabled', field: 'Спальни', onByDefault: true, note: 'отдельное поле Joker (BedroomsCount), не совпадает с «Комнаты»' },
  { key: 'joker_area_enabled', field: 'Площадь (м²)', onByDefault: true, note: null },
  { key: 'joker_floor_enabled', field: 'Этаж', onByDefault: true, note: null },
  { key: 'joker_floors_total_enabled', field: 'Этажей в доме', onByDefault: true, note: null },
  { key: 'joker_price_enabled', field: 'Цена (руб)', onByDefault: true, note: null },
  { key: 'joker_readiness_enabled', field: 'Готовность/Год постройки', onByDefault: true, note: 'хранится как отдельные год и квартал (квартал — не то же, что год)' },
  { key: 'joker_layout_enabled', field: 'Планировка (Изолированная/Смежная/Своб.)', onByDefault: false, note: null },
  { key: 'joker_euro_layout_enabled', field: 'Евро-планировка', onByDefault: false, note: null },
  { key: 'joker_deal_type_enabled', field: 'Тип сделки (продажа/аренда)', onByDefault: false, note: 'вероятно должен быть жёстким фильтром, а не критерием оценки — решение отложено' },
  { key: 'joker_amenities_enabled', field: 'Паркинг / вид из окна / высота потолков', onByDefault: false, note: null },
];

const NORMALIZATION_NOTES = [
  'ЖК/Комплекс: убрать невидимые пробелы и «ЖК»/«МФК»/«Комплекс апартаментов»/«Элитный комплекс», кавычки «», лишние пробелы — до сравнения с текстом покупателя.',
  'Округ/Район: убрать суффикс «р-н»/«р-он» — «Одинцовский р-н» и «Одинцовский район» от покупателя должны совпасть.',
  'Комнаты: «Студия» и «Свободная планировка» — не 0 и не пропуск, а явные отдельные значения.',
  'Площадь: принимать «м²», «M{2}» (реальная опечатка в данных Joker на гаражах), «m2», «кв.м» как один и тот же формат.',
  'Готовность/Год: квартал (1-4) и год — разные поля, квартал никогда не путается с годом.',
];

module.exports = { JOKER_CRITERIA, NORMALIZATION_NOTES };
