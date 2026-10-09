'use strict';

// Validates/coerces the AI's raw JSON output into a safe value. Same
// defensive-coercion discipline as dubai-lead-matching-service's own
// parser/schema.js: untrusted input never throws, an invalid/missing
// field is dropped to null/false, never trusted as-is. This is the
// SUPPLY side (a property being offered), not the buyer-request schema
// those services use -- deliberately a separate, smaller field set.

const PROPERTY_TYPES = ['Apartment', 'Villa', 'Townhouse', 'Penthouse', 'Studio', 'Duplex', 'Office', 'Retail', 'Land', 'Building'];
const FURNISHING_VALUES = ['Furnished', 'Unfurnished', 'Semi-Furnished'];

function normalizeText(value) {
  return String(value ?? '').trim().toLowerCase();
}

function coerceString(rawValue) {
  if (rawValue === null || rawValue === undefined) return null;
  const text = String(rawValue).trim();
  return text.length ? text : null;
}

function coerceEnum(rawValue, allowed, warnings, fieldName) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return null;
  const match = allowed.find((v) => normalizeText(v) === normalizeText(rawValue));
  if (!match) {
    warnings.push(`invalid_enum:${fieldName}`);
    return null;
  }
  return match;
}

// Numeric fields are coerced leniently here (the AI is asked for a bare
// number, but defensively handles a currency-formatted string too) --
// normalize/listing-to-stock-row.js applies the SAME coerceNumeric used by
// the rest of the platform's sync pipelines right before the DB write, so
// this layer only needs to not throw, not to be the final word on format.
function coerceNumber(rawValue, fieldName, warnings) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return null;
  if (typeof rawValue === 'number') return Number.isFinite(rawValue) ? rawValue : null;
  const cleaned = String(rawValue).replace(/[^0-9.\-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) {
    warnings.push(`malformed_number:${fieldName}`);
    return null;
  }
  return n;
}

function coerceInteger(rawValue, fieldName, warnings) {
  const n = coerceNumber(rawValue, fieldName, warnings);
  return n === null ? null : Math.round(n);
}

function coerceBoolean(rawValue, fallback = false) {
  if (typeof rawValue === 'boolean') return rawValue;
  if (rawValue === null || rawValue === undefined || rawValue === '') return fallback;
  const text = normalizeText(rawValue);
  if (['true', 'yes', '1'].includes(text)) return true;
  if (['false', 'no', '0'].includes(text)) return false;
  return fallback;
}

function parseAiOutput(raw) {
  const warnings = [];
  const source = raw && typeof raw === 'object' ? raw : {};

  const value = {
    is_listing: coerceBoolean(source.is_listing, false),
    city: coerceString(source.city),
    area: coerceString(source.area),
    building: coerceString(source.building),
    property_type: coerceEnum(source.property_type, PROPERTY_TYPES, warnings, 'property_type'),
    bedrooms: coerceInteger(source.bedrooms, 'bedrooms', warnings),
    bathrooms: coerceNumber(source.bathrooms, 'bathrooms', warnings),
    selling_price: coerceNumber(source.selling_price, 'selling_price', warnings),
    annual_rent: coerceNumber(source.annual_rent, 'annual_rent', warnings),
    size_sqft: coerceNumber(source.size_sqft, 'size_sqft', warnings),
    plot_size_sqft: coerceNumber(source.plot_size_sqft, 'plot_size_sqft', warnings),
    furnishing: coerceEnum(source.furnishing, FURNISHING_VALUES, warnings, 'furnishing'),
    view: coerceString(source.view),
    distress: coerceBoolean(source.distress, false),
    confidence:
      source.confidence === null || source.confidence === undefined
        ? null
        : Math.min(1, Math.max(0, coerceNumber(source.confidence, 'confidence', warnings) ?? 0)),
  };

  return { value, warnings };
}

module.exports = { PROPERTY_TYPES, FURNISHING_VALUES, parseAiOutput };
