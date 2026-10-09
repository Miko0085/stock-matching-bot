'use strict';

// Abu Dhabi's own bot (separate token/chat, per the user's decision) --
// reuses dubai-lead-matching-service's sendMatchNotification as-is: it is
// already 100% generic (botToken/chatId/messages in, no schema/market
// references at all). Not imported by pipeline.js directly (this file is
// the wrapper, matching the same pattern as gates/v2-intake-gate.js and
// repositories/config-repository.js).
module.exports = require('../../../dubai-lead-matching-service/src/notifications/telegram-sender');
