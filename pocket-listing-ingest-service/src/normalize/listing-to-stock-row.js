'use strict';

const { coerceNumeric } = require('../../../src/core/sync-normalize');
const { resolveBrokerContact } = require('./resolve-broker-contact');

// Pure mapping: AI-extracted listing fields + the WhatsApp message's own
// sender -> a raw stock row object (minus stock_id, which needs a DB
// round-trip -- see generateStockId below). Deliberately separate from
// the DB-dependent half so the business logic here (transaction_type
// inference, distress tagging, broker-contact resolution) is directly
// unit-testable without a database.
//
// `status` is always 'NEEDS_REVIEW' (user decision, 2026-10-07): this
// pipeline is fully automated with no human curation step before insert,
// unlike the one-time `.xlsx` import, which a person had already read.
// An operator confirms via the status dropdown already shipped on
// /stock?market=uae.
//
// `stock_source` is 'POCKET_LISTING_WHATSAPP_LIVE', distinct from the
// `.xlsx` import's 'POCKET_LISTING' tag, so an operator can tell which
// pipeline produced a given row.
//
// `broker`/`broker_contact` (2026-10-08 audit finding, PKT-WA-261008-02):
// the AI is never asked for a broker name -- the person who POSTED the
// listing in the group is the broker/contact, the same convention the
// one-time `.xlsx` import's own historical data already follows (its
// `broker` column holds the poster's name, e.g. "Дима Довгей Nika").
function mapListingToStockFields(aiValue, sender = {}) {
  const hasSellingPrice = aiValue.selling_price !== null && aiValue.selling_price !== undefined;
  const hasAnnualRent = aiValue.annual_rent !== null && aiValue.annual_rent !== undefined;
  // AGENTS.md section 4's own SALE default applies when neither price is
  // stated; when only a rent figure is given, this is a rental listing;
  // when both are given (a property offered either way), SALE is the
  // primary record -- the rent figure is preserved in `notes` so it is
  // never silently discarded.
  const transactionType = hasAnnualRent && !hasSellingPrice ? 'RENT_YEARLY' : 'SALE';

  const noteParts = [];
  if (aiValue.distress) noteParts.push('DISTRESS.');
  if (hasSellingPrice && hasAnnualRent) {
    noteParts.push(`Also available for rent: AED ${aiValue.annual_rent}/year.`);
  }
  const notes = noteParts.length ? noteParts.join(' ') : null;

  return {
    status: 'NEEDS_REVIEW',
    transaction_type: transactionType,
    city: aiValue.city,
    area: aiValue.area,
    building: aiValue.building,
    property_type: aiValue.property_type,
    bedrooms: aiValue.bedrooms,
    bathrooms: coerceNumeric(aiValue.bathrooms),
    selling_price: coerceNumeric(aiValue.selling_price),
    annual_rent: coerceNumeric(aiValue.annual_rent),
    size_sqft: coerceNumeric(aiValue.size_sqft),
    plot_size_sqft: coerceNumeric(aiValue.plot_size_sqft),
    furnishing: aiValue.furnishing,
    view: aiValue.view,
    notes,
    broker: sender.senderName || null,
    broker_contact: resolveBrokerContact(sender.senderId, sender.senderIdAlt),
    stock_source: 'POCKET_LISTING_WHATSAPP_LIVE',
  };
}

function yymmdd(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

// PKT-WA-<YYMMDD>-<NN>, the exact scheme already used by the one-time
// `.xlsx` import (ADR-048) -- new live-ingested rows look identical in
// shape to the historical batch. NN is a simple per-day count-based
// sequence against matching_dubai.stock_inventory itself; a tiny race
// window exists under concurrent inserts for the same day, acceptable for
// this single low-volume WhatsApp group (same tradeoff already accepted
// implicitly by every sequence-by-count scheme in this codebase).
async function generateStockId(pool, postedAt) {
  const day = yymmdd(postedAt ? new Date(postedAt) : new Date());
  const prefix = `PKT-WA-${day}-`;
  const { rows } = await pool.query(
    `SELECT count(*)::int AS c FROM matching_dubai.stock_inventory WHERE stock_id LIKE $1`,
    [`${prefix}%`]
  );
  const seq = String(rows[0].c + 1).padStart(2, '0');
  return `${prefix}${seq}`;
}

async function buildStockRow(pool, { aiValue, postedAt, sender }) {
  const fields = mapListingToStockFields(aiValue, sender);
  const stockId = await generateStockId(pool, postedAt);
  return { stock_id: stockId, ...fields };
}

module.exports = { mapListingToStockFields, generateStockId, buildStockRow };
