'use strict';

// Stats for the /notifications page's embedded stats panel -- how many
// broker Telegram/WhatsApp match notifications were sent, over the SAME
// rolling-period filter the Summary page (/) already uses, plus an
// optional flexible calendar date range (from/to) that overrides it when
// present. Reuses PERIODS/DEFAULT_PERIOD/resolvePeriodStart from
// summary-queries.js rather than forking a second copy of that logic.
const { PERIODS, DEFAULT_PERIOD, resolvePeriodStart } = require('./summary-queries');

// `from`/`to` are plain YYYY-MM-DD strings from <input type="date">. When
// either is present they take precedence over the rolling-period tabs --
// the calendar is a more specific request than "last 7 days". `to` is
// treated as inclusive of the whole day.
function resolveDateRange({ period = DEFAULT_PERIOD, from = null, to = null } = {}) {
  if (from || to) {
    return {
      start: from ? new Date(`${from}T00:00:00.000Z`) : null,
      end: to ? new Date(`${to}T23:59:59.999Z`) : null,
      usingCalendar: true,
    };
  }
  return { start: resolvePeriodStart(period), end: null, usingCalendar: false };
}

const EMPTY_CHANNEL_COUNTS = { sent: 0, failed: 0, skipped: 0 };

// matching_dubai.notification_deliveries.status is CHECK'd to PENDING/
// SENDING/SENT/DELIVERED/FAILED/SKIPPED (migration 0009) -- this feature
// only ever writes SENT or FAILED (broker-notifier.js never leaves a row
// PENDING/SENDING, and "skip silently" means no row at all, not a SKIPPED
// row), but DELIVERED/SKIPPED are still bucketed defensively so a future
// write path can't silently fall outside every bucket.
function bucketForStatus(status) {
  if (status === 'SENT' || status === 'DELIVERED') return 'sent';
  if (status === 'FAILED') return 'failed';
  return 'skipped';
}

async function getNotificationStats(pool, { period = DEFAULT_PERIOD, from = null, to = null } = {}) {
  const { start, end, usingCalendar } = resolveDateRange({ period, from, to });
  const { rows } = await pool.query(
    `SELECT channel, status, count(*)::int AS c
     FROM matching_dubai.notification_deliveries
     WHERE ($1::timestamptz IS NULL OR created_at >= $1)
       AND ($2::timestamptz IS NULL OR created_at <= $2)
     GROUP BY 1, 2`,
    [start, end]
  );

  const byChannel = { TELEGRAM: { ...EMPTY_CHANNEL_COUNTS }, WHATSAPP: { ...EMPTY_CHANNEL_COUNTS } };
  for (const row of rows) {
    if (!byChannel[row.channel]) byChannel[row.channel] = { ...EMPTY_CHANNEL_COUNTS };
    byChannel[row.channel][bucketForStatus(row.status)] += row.c;
  }

  const totalSent = Object.values(byChannel).reduce((sum, c) => sum + c.sent, 0);
  const totalFailed = Object.values(byChannel).reduce((sum, c) => sum + c.failed, 0);

  return { period, from, to, usingCalendar, byChannel, totalSent, totalFailed };
}

module.exports = { PERIODS, DEFAULT_PERIOD, resolveDateRange, bucketForStatus, getNotificationStats };
