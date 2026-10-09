'use strict';

// Moscow reuses lead-matching-service's provider adapters as-is: they are
// pure transport-shape conversion (raw Telegram/WhatsApp worker payload ->
// UnifiedRawMessage), zero UAE-specific matching logic or schema
// references (MARKET_CONTOURS_AND_SOURCE_ROUTING.md section 16's own
// "transport-only" framing for workers applies equally well here -- these
// adapters are the transport layer, not the Dubai contour's business logic).
// Not imported by pipeline.js directly -- this local wrapper is, same
// pattern as gates/v2-intake-gate.js and repositories/config-repository.js.
const telegramAdapter = require('../../../dubai-lead-matching-service/src/adapters/telegram-adapter');
const whatsappAdapter = require('../../../dubai-lead-matching-service/src/adapters/whatsapp-adapter');
const schema = require('../../../dubai-lead-matching-service/src/adapters/unified-message-schema');

function adapt(raw, provider) {
  if (provider === 'telegram') return telegramAdapter.toUnifiedRawMessage(raw);
  if (provider === 'whatsapp') return whatsappAdapter.toUnifiedRawMessage(raw);
  throw new Error(`adapt: unsupported provider "${provider}"`);
}

module.exports = { adapt, ...schema };
