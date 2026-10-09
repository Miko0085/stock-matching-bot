'use strict';

// The accepted request's original chat post link, split by provider so
// Match Log / dashboards can show which channel a lead came from without
// guessing from one ambiguous URL field. This describes the REQUEST's
// source, not the stock item.
function deriveSourcePostLinks(provider, sourceUrl) {
  if (!sourceUrl) return { telegramPost: null, whatsappPost: null };
  return {
    telegramPost: provider === 'telegram' ? sourceUrl : null,
    whatsappPost: provider === 'whatsapp' ? sourceUrl : null,
  };
}

module.exports = { deriveSourcePostLinks };
