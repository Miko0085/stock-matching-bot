'use strict';

const { formatPrice, formatBedrooms, formatBudget } = require('./telegram');

const DEFAULT_MAX_MESSAGE_LENGTH = 4096;
// Generous fixed headroom for " (Part 999/999)" plus the blank line before
// the stock list — correctness (no lost/duplicated line) matters far more
// here than packing the exact minimum number of chunks.
const PART_LABEL_RESERVE = 24;

function formatTypeAndBeds(propertyType, bedrooms) {
  const beds = formatBedrooms(bedrooms);
  if (propertyType && beds) return `${propertyType} - ${beds}`;
  return propertyType || beds || null;
}

function renderStockLine(entry, index) {
  const { stock, score, status } = entry;
  const parts = [
    `${index}. 🆔 ${stock.stock_id}`,
    stock.building ? `🏢 ${stock.building}` : null,
    `📍 ${stock.area || 'Unknown area'}`,
    formatTypeAndBeds(stock.property_type, stock.bedrooms),
    formatPrice(stock.selling_price) ? `💰 ${formatPrice(stock.selling_price)} AED` : null,
    `${status.replace('_', ' ')} ${score.total}/100`,
  ].filter(Boolean);
  return parts.join(' — ');
}

function buildHeader(sourceMessageId, brokerId, normalizedRequest, matchCount) {
  return [
    `🔔 ${matchCount} matching ${matchCount === 1 ? 'property' : 'properties'} for a buyer request`,
    `Request: ${sourceMessageId} | Broker: ${brokerId}`,
    `📍 ${normalizedRequest.area || 'Not specified'} | 💰 ${formatBudget(normalizedRequest.budgetMin, normalizedRequest.budgetMax)}`,
  ].join('\n');
}

// Renders ALL of one broker's matched stock for one request as one message,
// or as few "Part i/N" chunks as needed to respect maxMessageLength. Every
// stock line appears exactly once, in the same order matches were given
// (assumed pre-sorted best-score-first, same convention as telegram.js),
// and the request/broker header repeats on every chunk so a chunk read in
// isolation still carries full context. Never truncates — this is the
// "no Top-3 cutoff, ever" rule applied to the grouped broker payload.
function buildBrokerNotificationMessages({
  sourceMessageId,
  brokerId,
  normalizedRequest = {},
  matches = [],
  maxMessageLength = DEFAULT_MAX_MESSAGE_LENGTH,
}) {
  const lines = matches.map((entry, i) => renderStockLine(entry, i + 1));
  const header = buildHeader(sourceMessageId, brokerId, normalizedRequest, matches.length);
  const perChunkBudget = maxMessageLength - header.length - PART_LABEL_RESERVE;

  const chunks = [];
  let bucket = [];
  let bucketLen = 0;
  for (const line of lines) {
    const lineLen = line.length + 1;
    if (bucket.length > 0 && bucketLen + lineLen > perChunkBudget) {
      chunks.push(bucket);
      bucket = [];
      bucketLen = 0;
    }
    bucket.push(line);
    bucketLen += lineLen;
  }
  if (bucket.length > 0 || chunks.length === 0) chunks.push(bucket);

  const total = chunks.length;
  return chunks.map((bucketLines, i) => {
    const headerLine = total > 1 ? `${header} (Part ${i + 1}/${total})` : header;
    return [headerLine, '', ...bucketLines].join('\n');
  });
}

module.exports = { buildBrokerNotificationMessages };
