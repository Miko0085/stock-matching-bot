'use strict';

// Same constant-time API-key check convention as the Dubai service --
// independent copy, not imported, so the two services never share an
// auth code path either.
const { timingSafeEqual } = require('crypto');

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function requireApiKey(config) {
  return async function (request, reply) {
    if (!config.apiKey) return; // dev mode: no key configured
    const provided = request.headers['x-api-key'] || '';
    if (!safeEqual(provided, config.apiKey)) {
      reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing X-API-Key' } });
    }
  };
}

module.exports = { requireApiKey };
