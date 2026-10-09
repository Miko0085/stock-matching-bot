'use strict';

// Moscow's own message rendering -- reuses lead-matching-service's
// buildHeaderText/chunkMatchedStock/splitLongText as-is (already generic:
// requestId/originalText/provider/groupName/sourceUrl/requester* in, no
// UAE-specific stock fields at all), writes its own formatMatchEntry
// (Moscow's fields differ: district/complex/комнаты/price in RUB, not
// area/building/bedrooms/AED).
const { buildHeaderText, chunkMatchedStock, splitLongText } = require('../../../dubai-lead-matching-service/src/notifications/render');

function formatPriceRub(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  return Number(value).toLocaleString('ru-RU');
}

function formatRooms(rooms, roomsSentinel) {
  if (roomsSentinel === 'STUDIO') return 'Студия';
  if (roomsSentinel === 'FREE_PLAN') return 'Свободная планировка';
  if (rooms === null || rooms === undefined) return null;
  return `${rooms}-комн.`;
}

function formatMatchEntry(match, index) {
  const location = match.complex || match.district || 'Округ не указан';
  const rooms = formatRooms(match.rooms, match.rooms_sentinel);
  const price = formatPriceRub(match.price);
  const priceLine = price ? `${price} ₽` : null;
  const lines = [
    `${index}. ${location}`,
    rooms,
    priceLine,
    `Совпадение: ${match.score}`,
  ].filter(Boolean);
  return lines.join('\n');
}

function buildNotificationMessages({
  requestId,
  originalText,
  provider,
  groupName,
  sourceUrl,
  matches,
  maxMessageLength = 3800,
  requesterName = null,
  requesterContactUrl = null,
  requesterSenderId = null,
}) {
  const headerText = buildHeaderText({ requestId, originalText, provider, groupName, sourceUrl, requesterName, requesterContactUrl, requesterSenderId });
  const matchEntries = matches.map((m, i) => formatMatchEntry(m, i + 1));

  const headerMessages = headerText.length <= maxMessageLength ? [headerText] : splitLongText(headerText, maxMessageLength, requestId);

  const stockMessages = matchEntries.length
    ? chunkMatchedStock(matchEntries, { maxLength: maxMessageLength, requestId, startingPartNumber: headerMessages.length + 1 })
    : [];

  return [...headerMessages, ...stockMessages];
}

module.exports = { buildNotificationMessages, formatMatchEntry, formatPriceRub, formatRooms };
