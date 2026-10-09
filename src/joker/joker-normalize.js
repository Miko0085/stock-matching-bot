'use strict';

// Pure normalization functions for Joker CRM stock data (moscow.nikaestate.ru).
// No DB, no HTTP -- every rule here is grounded in real data confirmed
// live during the 2026-09-28 audit (docs/PER_MARKET_SERVICE_INDEPENDENCE_PLAN.md
// section 5.1.2, docs/JOKER_API_DISCOVERY.md). Never invents a rule for a
// case not actually observed in real Joker objects.

// ЖК/Комплекс: real values observed include a leading zero-width space
// (​), generic prefixes ("ЖК", "МФК", "Комплекс апартаментов",
// "Элитный комплекс"), guillemets, and trailing whitespace
// (e.g. `"ЖК «WILL TOWERS» "`). The canonical key must be reachable from
// both a raw stock row AND a buyer's free-text mention (AGENTS.md section 8).
const COMPLEX_PREFIX_RE = /^(ЖК|МФК|Комплекс апартаментов|Элитный комплекс)\s+/iu;

function normalizeComplex(raw) {
  if (!raw) return { key: null, display: null };
  let s = String(raw).replace(/^[​﻿\s]+/u, '').trim();
  s = s.replace(COMPLEX_PREFIX_RE, '');
  s = s.replace(/[«»]/gu, '').trim();
  if (!s) return { key: null, display: null };
  return { key: s.toLowerCase(), display: s };
}

// Округ/Район: strip the "р-н"/"р-он" suffix so "Одинцовский р-н" and a
// buyer's "Одинцовский район" resolve to the same alias lookup key.
function normalizeDistrict(raw) {
  if (!raw) return { key: null, display: null };
  const s = String(raw).trim().replace(/\s*р-(?:н|он)\.?$/iu, '').trim();
  if (!s) return { key: null, display: null };
  return { key: s.toLowerCase(), display: s };
}

// Комнаты: confirmed live non-numeric values "Студия" and
// "Свободная планировка" -- must not silently become 0 or a dropped null,
// each gets an explicit sentinel a matcher can branch on later.
const ROOM_SENTINELS = { 'студия': 'STUDIO', 'свободная планировка': 'FREE_PLAN' };

function normalizeRooms(raw) {
  if (raw === null || raw === undefined || raw === '') return { rooms: null, sentinel: null };
  const s = String(raw).trim();
  const sentinel = ROOM_SENTINELS[s.toLowerCase()];
  if (sentinel) return { rooms: null, sentinel };
  const n = Number(s);
  if (Number.isFinite(n)) return { rooms: n, sentinel: null };
  return { rooms: null, sentinel: null }; // unrecognized text -- never throws
}

// Площадь: confirmed formats "108 м²", "950 м²", and the broken garage-
// listing unit literal "28 М{2}" (a real encoding bug in Joker's own data,
// not something to "fix" upstream -- the parser must tolerate it).
function parseAreaSqm(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const m = String(raw).match(/[\d]+(?:[.,]\d+)?/u);
  if (!m) return null;
  const n = Number(m[0].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Готовность/Год постройки: confirmed live that `ready-quarter` is a bare
// small integer ("1".."4", quarter-of-year) while `built-year` is a
// 4-digit year, sometimes with a "г." suffix ("1915 г."). Never store both
// under one free-text field -- a bare "1" would be misread as a corrupt
// year by anything that assumes the column is always a year.
function normalizeReadiness({ builtYear, readyQuarter } = {}) {
  let year = null;
  if (builtYear !== null && builtYear !== undefined && builtYear !== '') {
    const m = String(builtYear).match(/\d{4}/u);
    if (m) year = Number(m[0]);
  }
  let quarter = null;
  if (readyQuarter !== null && readyQuarter !== undefined && readyQuarter !== '') {
    const n = Number(readyQuarter);
    if (Number.isInteger(n) && n >= 1 && n <= 4) quarter = n;
  }
  return { readinessYear: year, readinessQuarter: quarter };
}

// Тип объекта: commercial is excluded from buyer-facing matching entirely
// (business rule, mirrors UAE's own promotion/is_request filtering) --
// everything else gets a short canonical code.
const EXCLUDED_PROPERTY_TYPES = new Set(['Коммерческая недвижимость']);

const PROPERTY_TYPE_CODES = {
  'Квартиры - вторичное жильё': 'VTORICHKA',
  'Квартиры в новостройках': 'NOVOSTROYKA',
  'Дома, дачи, коттеджи': 'HOUSE',
  'Земельные участки': 'LAND',
  'Гараж': 'GARAGE',
};

function normalizePropertyType(raw) {
  if (!raw) return { code: null, excluded: false };
  if (EXCLUDED_PROPERTY_TYPES.has(raw)) return { code: null, excluded: true };
  return { code: PROPERTY_TYPE_CODES[raw] || null, excluded: false };
}

module.exports = {
  normalizeComplex,
  normalizeDistrict,
  normalizeRooms,
  parseAreaSqm,
  normalizeReadiness,
  normalizePropertyType,
  EXCLUDED_PROPERTY_TYPES,
  PROPERTY_TYPE_CODES,
};
