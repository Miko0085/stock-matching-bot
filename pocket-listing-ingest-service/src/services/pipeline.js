'use strict';

// Orchestrates one raw WhatsApp event end to end (ADR-050). Deliberately
// NOT reused from/by any lead-matching contour -- this is stock SUPPLY
// extraction, not buyer-demand matching, and AGENTS.md section 0's
// isolation boundary applies here too: this file never imports anything
// from dubai-lead-matching-service/rf-lead-matching-service/
// abu-dhabi-lead-matching-service, and none of those ever import this.
const { validateStockRow } = require('../../../src/core/sync-normalize');
const { buildStockRow } = require('../normalize/listing-to-stock-row');

function buildSourceMessageId(rawPayload) {
  return `whatsapp:${rawPayload.chat_id}:${rawPayload.message_id}`;
}

async function runWebhookPipeline({ rawPayload, deps }) {
  const { config, pool, ingestLogRepo, stockRepo, classifyAndParse } = deps;

  const chatId = String(rawPayload.chat_id);
  if (!config.sourceChatIds.includes(chatId)) {
    // Not one of our groups -- no row, no log, nothing. This service must
    // never persist anything about a chat it has no business reading.
    return { status: 'IGNORED_CHAT' };
  }

  const sourceMessageId = buildSourceMessageId(rawPayload);
  const existing = await ingestLogRepo.findProcessed(pool, sourceMessageId);
  if (existing) {
    return { status: 'DUPLICATE', stock_id: existing.stock_id };
  }

  const originalText = rawPayload.text || '';
  const aiResult = await classifyAndParse({
    originalText,
    apiKey: config.openaiApiKey,
    model: config.openaiModel,
  });

  if (!aiResult.ok) {
    // No processed_messages row on failure -- a genuine webhook
    // redelivery must be able to retry, not be silently swallowed as a
    // "duplicate" of a request that never actually succeeded.
    return { status: 'PARSER_ERROR', reason: aiResult.reason };
  }

  const aiValue = aiResult.value;
  const sender = {
    senderId: rawPayload.sender_id || null,
    senderIdAlt: rawPayload.sender_id_alt || null,
    senderName: rawPayload.sender_name || null,
  };
  const logBase = {
    sourceMessageId,
    chatId,
    senderId: sender.senderId,
    senderIdAlt: sender.senderIdAlt,
    senderName: sender.senderName,
    postedAt: rawPayload.posted_at || null,
  };

  if (!aiValue.is_listing) {
    await ingestLogRepo.recordProcessed(pool, { ...logBase, classifiedAsListing: false, skipReason: 'not_a_listing' });
    return { status: 'SKIPPED', reason: 'not_a_listing' };
  }

  if (aiValue.city !== 'Dubai') {
    await ingestLogRepo.recordProcessed(pool, { ...logBase, classifiedAsListing: true, skipReason: 'non_dubai_city' });
    return { status: 'SKIPPED', reason: 'non_dubai_city' };
  }

  const rawRow = await buildStockRow(pool, { aiValue, postedAt: rawPayload.posted_at, sender });
  const { value: validated, errors } = validateStockRow(rawRow);
  if (!validated) {
    await ingestLogRepo.recordProcessed(pool, { ...logBase, classifiedAsListing: true, skipReason: `invalid_stock_row:${errors.join(',')}` });
    return { status: 'SKIPPED', reason: 'invalid_stock_row', errors };
  }
  // validateStockRow's whitelist predates stock_source (migration 0009,
  // added unused until ADR-048) -- it silently drops any field it doesn't
  // know about, same gap scripts/dubai-pocket-stock-import-run.js already
  // had to work around the same way.
  const stockRow = { ...validated, stock_source: rawRow.stock_source };

  await stockRepo.upsertStockRows(pool, [stockRow]);
  await ingestLogRepo.recordProcessed(pool, { ...logBase, classifiedAsListing: true, stockId: stockRow.stock_id });

  return { status: 'MATCH', stock_id: stockRow.stock_id };
}

module.exports = { runWebhookPipeline, buildSourceMessageId };
