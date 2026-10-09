'use strict';

// Portable normalization layer behind the adapter interface
// (getHealth/getStatus/getSessionStatus/reconnect/restartSession/
// getConnectionInstructions) described in the channel-monitoring spec.
// Takes whatever raw JSON a worker's HTTP API returns and derives one
// canonical status — deliberately NOT based on "did a message arrive
// recently" alone, since a quiet-but-healthy channel (no new leads right
// now) must not be confused with a dead one.

const DEFAULT_STALE_HEARTBEAT_MS = 5 * 60 * 1000; // 5 minutes

// processStatus: is the worker process itself reachable at all.
// sessionStatus: is the underlying Telegram/WhatsApp session authenticated
// and connected (independent of whether the process is up).
function deriveStatus({ processStatus, sessionStatus, lastHeartbeatAt, now = new Date(), staleAfterMs = DEFAULT_STALE_HEARTBEAT_MS }) {
  if (processStatus === 'UNREACHABLE') return 'DOWN';
  if (sessionStatus === 'ERROR' || sessionStatus === 'REQUIRES_AUTH' || sessionStatus === 'REQUIRES_ATTENTION') return 'DOWN';
  if (sessionStatus === 'CONNECTING' || sessionStatus === 'RECONNECTING') return 'DEGRADED';

  if (lastHeartbeatAt) {
    const ageMs = now.getTime() - new Date(lastHeartbeatAt).getTime();
    if (ageMs > staleAfterMs) return 'DEGRADED';
  } else {
    return 'UNKNOWN';
  }

  if (sessionStatus === 'CONNECTED') return 'OK';
  return 'UNKNOWN';
}

// telegram-worker's /health + /telegram/accounts shape -> canonical record
// ready to persist into matching_dubai.channel_health_checks.
function normalizeTelegramHealth({ accounts, reachable, error }, now = new Date()) {
  if (!reachable) {
    return {
      channel: 'TELEGRAM_MONITORING',
      workerKey: 'telegram-worker',
      provider: 'telegram',
      status: 'DOWN',
      processStatus: 'UNREACHABLE',
      sessionStatus: null,
      lastHeartbeatAt: null,
      latencyMs: null,
      errorCode: 'UNREACHABLE',
      errorText: error || 'worker did not respond',
      checkedAt: now,
    };
  }

  const account = (accounts || [])[0] || null;
  const sessionStatus = !account
    ? 'UNKNOWN'
    : account.connected && account.authorized
      ? 'CONNECTED'
      : account.status
        ? account.status.toUpperCase()
        : 'UNKNOWN';

  const status = deriveStatus({
    processStatus: 'RUNNING',
    sessionStatus,
    lastHeartbeatAt: now, // /health responding at all IS the heartbeat for this worker
    now,
  });

  return {
    channel: 'TELEGRAM_MONITORING',
    workerKey: 'telegram-worker',
    provider: 'telegram',
    status,
    processStatus: 'RUNNING',
    sessionStatus,
    lastHeartbeatAt: now,
    latencyMs: null,
    errorCode: account && account.error ? 'ACCOUNT_ERROR' : null,
    errorText: account ? account.error || null : null,
    checkedAt: now,
  };
}

// whatsapp-worker's /health + /whatsapp/accounts shape (including the
// consecutive_failures/throttled/next_retry_at fields added for reconnect
// throttling) -> canonical record.
function normalizeWhatsappHealth({ accounts, reachable, error }, now = new Date()) {
  if (!reachable) {
    return {
      channel: 'WHATSAPP_MONITORING',
      workerKey: 'whatsapp-worker',
      provider: 'whatsapp',
      status: 'DOWN',
      processStatus: 'UNREACHABLE',
      sessionStatus: null,
      lastHeartbeatAt: null,
      latencyMs: null,
      errorCode: 'UNREACHABLE',
      errorText: error || 'worker did not respond',
      checkedAt: now,
    };
  }

  const account = (accounts || [])[0] || null;
  let sessionStatus = 'UNKNOWN';
  if (account) {
    if (account.connected) sessionStatus = 'CONNECTED';
    else if (account.status === 'requires_auth') sessionStatus = 'REQUIRES_AUTH';
    else if (account.status === 'requires_attention') sessionStatus = 'REQUIRES_ATTENTION';
    else if (account.status === 'waiting_for_qr') sessionStatus = 'CONNECTING';
    else sessionStatus = (account.status || 'UNKNOWN').toUpperCase();
  }

  const status = deriveStatus({
    processStatus: 'RUNNING',
    sessionStatus,
    lastHeartbeatAt: now,
    now,
  });

  return {
    channel: 'WHATSAPP_MONITORING',
    workerKey: 'whatsapp-worker',
    provider: 'whatsapp',
    status,
    processStatus: 'RUNNING',
    sessionStatus,
    lastHeartbeatAt: now,
    latencyMs: null,
    errorCode: account && account.throttled ? 'THROTTLED' : null,
    errorText: account ? account.last_error || null : null,
    metadata: account
      ? { consecutive_failures: account.consecutive_failures, next_retry_at: account.next_retry_at }
      : null,
    checkedAt: now,
  };
}

// Which reconnect-family actions each channel's adapter actually supports —
// a Telegram Monitoring session (a persistent MTProto client, not a
// page-scraping worker) has no reconnect/restart endpoint today, so a
// request for one must be rejected explicitly rather than silently no-op'd.
const SUPPORTED_CHANNEL_ACTIONS = {
  TELEGRAM_MONITORING: [],
  WHATSAPP_MONITORING: ['reconnect', 'clear_session'],
};

function isChannelActionSupported(channel, action) {
  return (SUPPORTED_CHANNEL_ACTIONS[channel] || []).includes(action);
}

module.exports = {
  DEFAULT_STALE_HEARTBEAT_MS,
  deriveStatus,
  normalizeTelegramHealth,
  normalizeWhatsappHealth,
  SUPPORTED_CHANNEL_ACTIONS,
  isChannelActionSupported,
};
