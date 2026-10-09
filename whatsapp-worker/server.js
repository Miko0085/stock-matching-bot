import express from 'express'
import crypto from 'crypto'
import fs from 'fs/promises'
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'fs'
import path from 'path'
import qrcodeTerminal from 'qrcode-terminal'
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import { buildMessageEvent } from './wa_events.js'
import { ReplyDebouncer } from './wa_debounce.js'
import {
  AutomationStatusProbe,
  WebhookDeliveryQueue,
  MultiWebhookDeliveryQueue,
  parseWebhookTargets,
} from './wa_webhook.js'
import { AutomatedOutboundTracker } from './wa_outbound_tracking.js'
import { PausedAccountsRegistry } from './wa_pause_registry.js'

const HOST = process.env.WORKER_HOST || '0.0.0.0'
const PORT = Number(process.env.WORKER_PORT || 8092)
const WORKER_API_KEY = process.env.WORKER_API_KEY || ''

// Private 1:1 reply forwarding (debounced) -- a SEPARATE, off-by-default
// destination from group-post monitoring below (WA_MONITOR_*), same
// rationale as telegram-worker's own private-reply bridge: a private
// conversation and a "did someone post a lead in this group" event are
// different consumers (ai-qualifier vs. n8n) with different payload
// cadence, so they get independent webhook queues.
const WA_REPLY_DEBOUNCE_SECONDS = Number(process.env.WA_REPLY_DEBOUNCE_SECONDS || 40)
const WA_TYPING_SECONDS = Number(process.env.WA_TYPING_SECONDS || 10)
const WA_PRIVATE_REPLY_WEBHOOK_URL = (process.env.WA_PRIVATE_REPLY_WEBHOOK_URL || '').trim()
const WA_PRIVATE_REPLY_WEBHOOK_SECRET = process.env.WA_PRIVATE_REPLY_WEBHOOK_SECRET || ''
const WA_AUTOMATION_STATUS_URL = (
  process.env.WA_AUTOMATION_STATUS_URL ||
  (WA_PRIVATE_REPLY_WEBHOOK_URL
    ? `${WA_PRIVATE_REPLY_WEBHOOK_URL.slice(0, WA_PRIVATE_REPLY_WEBHOOK_URL.lastIndexOf('/'))}/automation-status`
    : '')
).trim()

// Group-post monitoring/lead detection -- mirrors telegram-worker's
// TELEGRAM_MONITOR_WEBHOOK_URL + TELEGRAM_MONITOR_CHAT_IDS. Off by default
// (empty allowlist = nothing forwarded) even if a URL is configured, so
// enabling this can never silently start forwarding every group the
// account happens to be in.
// Both WA_MONITOR_WEBHOOK_URL and WA_MONITOR_WEBHOOK_SECRET accept a
// comma-separated list to deliver the same event to more than one n8n
// instance -- see wa_webhook.js's parseWebhookTargets().
const WA_MONITOR_WEBHOOK_URL = (process.env.WA_MONITOR_WEBHOOK_URL || '').trim()
const WA_MONITOR_WEBHOOK_SECRET = process.env.WA_MONITOR_WEBHOOK_SECRET || ''
const WA_MONITOR_GROUP_IDS = new Set(
  String(process.env.WA_MONITOR_GROUP_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)
)

function isGroupMonitored(chatId) {
  if (WA_MONITOR_GROUP_IDS.size === 0) return false
  return WA_MONITOR_GROUP_IDS.has(String(chatId || ''))
}

// ============================================================
// ACTION LOGGING
//
// Every action (HTTP request, account state change, send, error) is
// written as one JSON line to logs/whatsapp-worker.log, in addition to
// the usual console output (still visible via `docker compose logs`).
// Rotates at ~5MB with up to 5 backups so the file never grows
// unbounded. No message text or session credentials are ever logged.
// ============================================================

const LOGS_DIR = process.env.LOG_DIR || './logs'
mkdirSync(LOGS_DIR, { recursive: true })

const LOG_FILE = path.join(LOGS_DIR, 'whatsapp-worker.log')
const MAX_LOG_BYTES = 5_000_000
const MAX_LOG_BACKUPS = 5

let logStream = createWriteStream(LOG_FILE, { flags: 'a' })

function rotateLogIfNeeded() {
  let size = 0
  try {
    size = statSync(LOG_FILE).size
  } catch {
    return
  }
  if (size < MAX_LOG_BYTES) return

  logStream.end()
  for (let i = MAX_LOG_BACKUPS - 1; i >= 1; i--) {
    const src = `${LOG_FILE}.${i}`
    const dst = `${LOG_FILE}.${i + 1}`
    if (existsSync(src)) {
      try {
        renameSync(src, dst)
      } catch {
        /* best effort */
      }
    }
  }
  try {
    renameSync(LOG_FILE, `${LOG_FILE}.1`)
  } catch {
    /* best effort */
  }
  logStream = createWriteStream(LOG_FILE, { flags: 'a' })
}

function logAction(level, message, fields = {}) {
  const entry = { time: new Date().toISOString(), level, message, ...fields }
  const line = JSON.stringify(entry)

  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)

  rotateLogIfNeeded()
  logStream.write(line + '\n')
}

// New multi-account layout: whatsapp-worker/sessions/<account_id>/
// (the old single-account ./wa_session is not touched or auto-migrated —
// see README_DEPLOY.md for the manual migration steps).
const SESSIONS_DIR = process.env.WA_SESSIONS_DIR || './sessions'
const STATE_DIR = process.env.WA_STATE_DIR || './state'

const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

const pausedAccounts = new PausedAccountsRegistry(path.join(STATE_DIR, 'paused_accounts.json'), logAction)

// ============================================================
// RECONNECT THROTTLING
//
// A transient disconnect (network blip, WhatsApp server hiccup) used to
// retry after a fixed 3s/5s delay forever, with no cap and no signal that
// anything was wrong -- indistinguishable, from WhatsApp's side, from a
// client hammering the connection on a fixed cadence. Modeled on the same
// ban-avoidance shape Devi's extension config uses for its own scanning
// (randomized interval, escalating backoff, eventual give-up instead of
// retrying forever) -- see docs/DEVI_CHANNEL_MONITORING_RESEARCH.md.
// requires_auth (an actual WhatsApp-side logout) already never
// auto-retries; this only governs disconnected/error.
// ============================================================
const WA_RECONNECT_BASE_DELAY_MS = Number(process.env.WA_RECONNECT_BASE_DELAY_MS || 3000)
const WA_RECONNECT_MAX_DELAY_MS = Number(process.env.WA_RECONNECT_MAX_DELAY_MS || 5 * 60 * 1000)
const WA_RECONNECT_PAUSE_AFTER_FAILURES = Number(process.env.WA_RECONNECT_PAUSE_AFTER_FAILURES || 5)
const WA_RECONNECT_GIVE_UP_AFTER_MS = Number(
  process.env.WA_RECONNECT_GIVE_UP_AFTER_MS || 2 * 60 * 60 * 1000
)

// Exponential backoff with +/-20% jitter (never a fixed, fingerprintable
// cadence), capped at WA_RECONNECT_MAX_DELAY_MS.
function computeBackoffDelayMs(consecutiveFailures) {
  const raw = WA_RECONNECT_BASE_DELAY_MS * Math.pow(2, Math.max(0, consecutiveFailures - 1))
  const capped = Math.min(raw, WA_RECONNECT_MAX_DELAY_MS)
  const jitter = capped * (0.8 + Math.random() * 0.4)
  return Math.round(jitter)
}

// account_id -> { sock, status, qr, reconnecting, lastError, requiresAuth,
//                 consecutiveFailures, firstFailureAt, nextRetryAt, retryTimer }
// status is one of: connecting | waiting_for_qr | connected | disconnected
//                    | requires_auth | error | requires_attention
// requires_attention means: repeated disconnects/errors for longer than
// WA_RECONNECT_GIVE_UP_AFTER_MS -- auto-retry has stopped, same as
// requires_auth, a human must trigger POST /whatsapp/accounts again.
const accounts = new Map()

const privateReplyWebhookQueue = new WebhookDeliveryQueue({
  url: WA_PRIVATE_REPLY_WEBHOOK_URL,
  secret: WA_PRIVATE_REPLY_WEBHOOK_SECRET,
  logAction: (message, fields) => logAction('info', message, fields),
})
const groupMonitorWebhookQueue = new MultiWebhookDeliveryQueue({
  targets: parseWebhookTargets(WA_MONITOR_WEBHOOK_URL, WA_MONITOR_WEBHOOK_SECRET),
  logAction: (message, fields) => logAction('info', message, fields),
})
const outboundTracker = new AutomatedOutboundTracker()
const automationStatusProbe = new AutomationStatusProbe({
  url: WA_AUTOMATION_STATUS_URL,
  secret: WA_PRIVATE_REPLY_WEBHOOK_SECRET,
  logAction: (message, fields) => logAction('info', message, fields),
})

// Only worth buffering/showing "typing..." if there's somewhere to
// deliver the aggregated event to afterward.
const replyDebouncer = privateReplyWebhookQueue.enabled
  ? new ReplyDebouncer({
      getEntry: accountId => accounts.get(accountId),
      onFlush: async payload => privateReplyWebhookQueue.enqueue(payload),
      shouldSignal: payload => automationStatusProbe.isActive(payload),
      logAction: (message, fields) => logAction('info', message, fields),
      delaySeconds: WA_REPLY_DEBOUNCE_SECONDS,
      typingSeconds: WA_TYPING_SECONDS,
    })
  : null

// Optional QR-as-image support. Not a hard dependency: if the `qrcode`
// package is not installed (e.g. no network access at deploy time), the
// /whatsapp/qr endpoint still returns the raw QR string, just without
// qr_data_url. This keeps the worker fully functional either way.
let qrToDataURL = null
try {
  const qrcodeLib = await import('qrcode')
  qrToDataURL = qrcodeLib.toDataURL
} catch {
  logAction('warn', 'qrcode_package_unavailable', {
    detail: '/whatsapp/qr will omit qr_data_url',
  })
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message)
    this.statusCode = statusCode
  }
}

function validateAccountId(rawAccountId) {
  const value = String(rawAccountId || '').trim()
  if (!value || !ACCOUNT_ID_RE.test(value)) {
    throw new HttpError(
      400,
      'Invalid account_id. Use 1-64 characters: letters, numbers, underscore or hyphen only.'
    )
  }
  return value
}

function sessionDirFor(accountId) {
  // accountId is always validated against ACCOUNT_ID_RE first, which
  // forbids "/", "\\" and "..", so this can never escape SESSIONS_DIR.
  return path.join(SESSIONS_DIR, accountId)
}

function publicState(accountId, entry) {
  return {
    account_id: accountId,
    status: entry.status,
    connected: entry.status === 'connected',
    requires_auth: !!entry.requiresAuth,
    last_error: entry.lastError || null,
    consecutive_failures: entry.consecutiveFailures || 0,
    throttled: (entry.consecutiveFailures || 0) >= WA_RECONNECT_PAUSE_AFTER_FAILURES,
    next_retry_at: entry.nextRetryAt || null,
    paused: pausedAccounts.isPaused(accountId),
  }
}

function normalizePhone(raw) {
  return String(raw || '').replace(/[^\d]/g, '').trim()
}

function inferDestinationType(jid) {
  const value = String(jid || '').toLowerCase()

  if (value.endsWith('@g.us')) return 'group'
  if (value.endsWith('@s.whatsapp.net') || value.endsWith('@lid')) return 'private'
  if (value.endsWith('@broadcast') || value === 'status@broadcast') return 'broadcast'

  return 'unknown'
}

async function resolvePrivateDestinationFromPhone(sock, phoneRaw) {
  const phone = normalizePhone(phoneRaw)
  if (!phone) throw new HttpError(400, 'phone is empty')

  const results = await sock.onWhatsApp(phone)
  const found = Array.isArray(results)
    ? results.find(item => item?.exists && item?.jid)
    : null

  if (!found?.jid) {
    throw new HttpError(404, `WhatsApp account was not resolved for phone: ${phone}`)
  }

  return found.jid
}

async function resolveDestination(sock, body) {
  const suppliedId = String(body.destination_id || '').trim()

  if (suppliedId) {
    return {
      destinationId: suppliedId,
      destinationType:
        String(body.destination_type || '').trim().toLowerCase() ||
        inferDestinationType(suppliedId),
      resolvedFrom: 'destination_id',
    }
  }

  const phone = normalizePhone(body.phone)

  if (phone) {
    const jid = await resolvePrivateDestinationFromPhone(sock, phone)
    return {
      destinationId: jid,
      destinationType: 'private',
      resolvedFrom: 'phone',
    }
  }

  throw new HttpError(400, 'destination_id or phone is required')
}

function getAccountOrThrow(accountId) {
  const entry = accounts.get(accountId)
  if (!entry) {
    throw new HttpError(404, `WhatsApp account not initialized: ${accountId}`)
  }
  return entry
}

function getConnectedAccountOrThrow(accountId) {
  const entry = getAccountOrThrow(accountId)
  if (entry.status !== 'connected' || !entry.sock) {
    throw new HttpError(
      503,
      `WhatsApp account '${accountId}' is not connected (status: ${entry.status}).`
    )
  }
  return entry
}

/**
 * Schedule a throttled reconnect attempt after a transient
 * disconnect/error. Escalates to 'requires_attention' (auto-retry stops,
 * same as a real requires_auth logout) once the failure streak has run
 * longer than WA_RECONNECT_GIVE_UP_AFTER_MS -- a persistent failure that
 * long is a structural problem, not a network blip, and retrying forever
 * only makes the account look more automated to WhatsApp, not less.
 */
function scheduleReconnect(accountId, entry) {
  entry.consecutiveFailures = (entry.consecutiveFailures || 0) + 1
  if (!entry.firstFailureAt) entry.firstFailureAt = Date.now()

  const failingForMs = Date.now() - entry.firstFailureAt
  if (failingForMs >= WA_RECONNECT_GIVE_UP_AFTER_MS) {
    entry.status = 'requires_attention'
    entry.nextRetryAt = null
    entry.reconnecting = false
    logAction('error', 'whatsapp_reconnect_give_up', {
      account_id: accountId,
      consecutive_failures: entry.consecutiveFailures,
      failing_for_ms: failingForMs,
    })
    return
  }

  const delayMs = computeBackoffDelayMs(entry.consecutiveFailures)
  entry.nextRetryAt = new Date(Date.now() + delayMs).toISOString()
  const throttled = entry.consecutiveFailures >= WA_RECONNECT_PAUSE_AFTER_FAILURES

  logAction(throttled ? 'warn' : 'info', 'whatsapp_reconnect_scheduled', {
    account_id: accountId,
    consecutive_failures: entry.consecutiveFailures,
    delay_ms: delayMs,
    throttled,
  })

  clearTimeout(entry.retryTimer)
  entry.retryTimer = setTimeout(() => {
    entry.reconnecting = false
    connectAccount(accountId).catch(err =>
      logAction('error', 'whatsapp_reconnect_failed', {
        account_id: accountId,
        error: err?.message || String(err),
      })
    )
  }, delayMs)
}

/**
 * Start (or resume) a connection for one account. Reconnect state is
 * tracked per account_id, so a failure/reconnect on one account can never
 * touch another account's socket or session directory.
 *
 * `isManual: true` (only ever passed from the HTTP route, never from an
 * internal scheduled retry) resets the failure/backoff streak -- a human
 * explicitly asking to reconnect is a fresh start, not a continuation of
 * whatever was failing before.
 */
async function connectAccount(accountId, { isManual = false } = {}) {
  let entry = accounts.get(accountId)
  if (!entry) {
    entry = {
      sock: null,
      status: 'connecting',
      qr: null,
      reconnecting: false,
      lastError: null,
      requiresAuth: false,
      consecutiveFailures: 0,
      firstFailureAt: null,
      nextRetryAt: null,
      retryTimer: null,
    }
    accounts.set(accountId, entry)
  }

  // Only one connect/reconnect attempt in flight per account at a time.
  if (entry.reconnecting) return entry
  entry.reconnecting = true
  entry.status = 'connecting'

  if (isManual) {
    clearTimeout(entry.retryTimer)
    entry.consecutiveFailures = 0
    entry.firstFailureAt = null
    entry.nextRetryAt = null
  }

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDirFor(accountId))

    const sock = makeWASocket({
      auth: state,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    })

    entry.sock = sock

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return
      if (pausedAccounts.isPaused(accountId)) {
        logAction('info', 'wa_message_skipped_paused', { account_id: accountId, count: messages.length })
        return
      }
      for (const waMessage of messages) {
        try {
          const payload = await buildMessageEvent(accountId, waMessage)

          // payload.sender_id/chat_id are always exactly what Baileys
          // reported (see wa_events.js) -- never rewritten here. When
          // it's a LID and the passive remoteJidAlt wasn't populated,
          // try an active lookup against Baileys' own phone<->LID
          // mapping store and attach the result as sender_id_alt (still
          // never overwriting the primary identity) so the receiving
          // side can match a stored conversation under either form.
          if (payload.sender_id.endsWith('@lid') && !payload.sender_id_alt) {
            try {
              const resolvedPn = await sock.signalRepository.lidMapping.getPNForLID(payload.sender_id)
              if (resolvedPn) {
                payload.sender_id_alt = resolvedPn
                logAction('info', 'wa_lid_alt_resolved', {
                  account_id: accountId,
                  raw_sender_id: payload.sender_id,
                  sender_id_alt: resolvedPn,
                  via: 'active_lid_mapping_lookup',
                })
              } else {
                logAction('warn', 'wa_lid_could_not_be_resolved', {
                  account_id: accountId,
                  raw_sender_id: payload.sender_id,
                  detail: 'no phone-number mapping known for this LID yet -- matching relies on the LID itself staying consistent',
                })
              }
            } catch (err) {
              logAction('warn', 'wa_lid_mapping_lookup_failed', {
                account_id: accountId,
                raw_sender_id: payload.sender_id,
                error: err?.message || String(err),
              })
            }
          } else if (payload.sender_id_alt) {
            logAction('info', 'wa_lid_alt_resolved', {
              account_id: accountId,
              raw_sender_id: payload.sender_id,
              sender_id_alt: payload.sender_id_alt,
              via: 'remoteJidAlt',
            })
          }

          if (waMessage.key?.fromMe) {
            if (!payload.is_private) continue
            const automated = outboundTracker.consume(
              accountId,
              payload.chat_id,
              payload.text || ''
            )
            if (automated) {
              logAction('info', 'wa_automated_outbound_observed', {
                account_id: accountId,
                chat_id: payload.chat_id,
                message_id: payload.message_id,
              })
              continue
            }
            if (replyDebouncer) replyDebouncer.cancelChat(accountId, payload.chat_id)
            payload.event = 'message.manual_outbound'
            logAction('info', 'wa_manual_outbound_observed', {
              account_id: accountId,
              chat_id: payload.chat_id,
              message_id: payload.message_id,
            })
            privateReplyWebhookQueue.enqueue(payload)
            continue
          }

          if (!payload.is_private) {
            // Group posts: forward only if this specific group is on
            // the WA_MONITOR_GROUP_IDS allowlist (empty by default --
            // see isGroupMonitored()). Mirrors telegram-worker's
            // TELEGRAM_MONITOR_CHAT_IDS behaviour exactly.
            if (isGroupMonitored(payload.chat_id)) {
              groupMonitorWebhookQueue.enqueue(payload)
            } else {
              logAction('info', 'wa_group_message_not_forwarded', {
                account_id: accountId,
                chat_id: payload.chat_id,
                reason: 'group_not_in_monitor_list',
              })
            }
            continue
          }
          if (!replyDebouncer) continue
          replyDebouncer.handlePrivateMessage(
            accountId,
            payload.chat_id,
            payload,
            waMessage.key
          )
        } catch (err) {
          logAction('error', 'wa_message_handling_failed', {
            account_id: accountId,
            error: err?.message || String(err),
          })
        }
      }
    })

    sock.ev.on('connection.update', update => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        entry.qr = qr
        entry.status = 'waiting_for_qr'
        logAction('info', 'whatsapp_qr_issued', { account_id: accountId })
        qrcodeTerminal.generate(qr, { small: true })
      }

      if (connection === 'open') {
        entry.status = 'connected'
        entry.qr = null
        entry.lastError = null
        entry.requiresAuth = false
        // A stable connection clears the failure streak -- the next
        // disconnect, if any, starts backoff fresh rather than picking up
        // where a previous, unrelated outage left off.
        entry.consecutiveFailures = 0
        entry.firstFailureAt = null
        entry.nextRetryAt = null
        clearTimeout(entry.retryTimer)
        // The connect attempt has settled into a stable state: release the
        // guard so a future disconnect can trigger a fresh reconnect.
        entry.reconnecting = false
        logAction('info', 'whatsapp_connected', { account_id: accountId })
      }

      if (connection === 'close') {
        const statusCode =
          lastDisconnect?.error instanceof Boom
            ? lastDisconnect.error.output?.statusCode
            : undefined

        const loggedOut = statusCode === DisconnectReason.loggedOut
        entry.lastError = lastDisconnect?.error?.message || null
        entry.sock = null

        if (loggedOut) {
          // Do not auto-reconnect a logged-out account forever. The
          // operator must re-run POST /whatsapp/accounts to get a new QR.
          entry.status = 'requires_auth'
          entry.requiresAuth = true
          entry.reconnecting = false
          logAction('warn', 'whatsapp_logged_out', {
            account_id: accountId,
            status_code: statusCode ?? null,
          })
          return
        }

        entry.status = 'disconnected'
        logAction('warn', 'whatsapp_disconnected', {
          account_id: accountId,
          status_code: statusCode ?? null,
        })

        scheduleReconnect(accountId, entry)

        // Skip the "reconnecting = false" below the try block for this
        // event; scheduleReconnect owns clearing that flag (either now, if
        // it gave up, or when its scheduled retry fires).
        return
      }
    })
  } catch (error) {
    logAction('error', 'whatsapp_connect_error', {
      account_id: accountId,
      error: error?.message || String(error),
    })
    entry.status = 'error'
    entry.lastError = error?.message || String(error)
    // Keep `reconnecting` true until scheduleReconnect's timer actually
    // fires (or it gives up), so a manual POST /whatsapp/accounts in the
    // meantime cannot start a second concurrent connect attempt.

    scheduleReconnect(accountId, entry)

    return entry
  }

  // Do not clear `reconnecting` here: the socket was created but has not
  // yet reached a stable state (open / requires_auth / scheduled retry).
  // The connection.update handler above is the single place that clears
  // it, once the outcome is actually known.
  return entry
}

async function bootstrapExistingAccounts() {
  try {
    await fs.mkdir(SESSIONS_DIR, { recursive: true })
    const dirEntries = await fs.readdir(SESSIONS_DIR, { withFileTypes: true })

    for (const dirEntry of dirEntries) {
      if (!dirEntry.isDirectory()) continue
      if (!ACCOUNT_ID_RE.test(dirEntry.name)) continue

      logAction('info', 'whatsapp_bootstrap_account', { account_id: dirEntry.name })
      connectAccount(dirEntry.name).catch(err =>
        logAction('error', 'whatsapp_bootstrap_failed', {
          account_id: dirEntry.name,
          error: err?.message || String(err),
        })
      )
    }
  } catch (err) {
    logAction('error', 'whatsapp_bootstrap_scan_failed', { error: err?.message || String(err) })
  }
}

// ============================================================
// APP
// ============================================================

const app = express()
app.use(express.json({ limit: '2mb' }))

// Small helper so route handlers can `await` freely and forward any
// rejection (including HttpError) to the central error handler below,
// instead of every route repeating its own try/catch.
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next)

// ------------------------------------------------------------
// Request logging: registered before auth, so it captures every request
// including ones auth rejects (401/503), with the real final status code
// (hooked via res.on('finish'), which fires however the response ends).
// ------------------------------------------------------------
app.use((req, res, next) => {
  const started = Date.now()
  res.on('finish', () => {
    logAction('info', 'http_request', {
      method: req.method,
      path: req.path,
      query: req.query || {},
      account_id: req.query?.account_id || req.body?.account_id || null,
      status_code: res.statusCode,
      duration_ms: Date.now() - started,
    })
  })
  next()
})

// ------------------------------------------------------------
// Auth: X-API-Key on everything except /health.
// Never log the provided or configured key value.
// ------------------------------------------------------------
app.use((req, res, next) => {
  if (req.path === '/health') return next()

  if (!WORKER_API_KEY) {
    return res.status(503).json({ status: 'error', error: 'WORKER_API_KEY is not configured' })
  }

  const provided = String(req.headers['x-api-key'] || '')
  const providedBuf = Buffer.from(provided)
  const expectedBuf = Buffer.from(WORKER_API_KEY)

  const isValid =
    providedBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(providedBuf, expectedBuf)

  if (!isValid) {
    return res.status(401).json({ status: 'error', error: 'Unauthorized' })
  }

  next()
})

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'whatsapp_worker',
    version: '2.0.0',
    port: PORT,
    accounts_loaded: accounts.size,
    private_reply_webhook_enabled: privateReplyWebhookQueue.enabled,
    reply_debounce_enabled: replyDebouncer !== null,
    reply_debounce_seconds: WA_REPLY_DEBOUNCE_SECONDS,
    reply_typing_seconds: WA_TYPING_SECONDS,
    automation_status_probe_enabled: automationStatusProbe.enabled,
    group_monitor_webhook_enabled: groupMonitorWebhookQueue.enabled,
    group_monitor_webhook_target_count: groupMonitorWebhookQueue.targetCount,
    group_monitor_groups_configured: WA_MONITOR_GROUP_IDS.size,
  })
})

app.get('/whatsapp/accounts', (req, res) => {
  const list = Array.from(accounts.entries()).map(([accountId, entry]) =>
    publicState(accountId, entry)
  )
  res.json({ status: 'ok', count: list.length, accounts: list })
})

app.post(
  '/whatsapp/accounts',
  wrap(async (req, res) => {
    const accountId = validateAccountId(req.body?.account_id)
    logAction('info', 'whatsapp_account_requested', { account_id: accountId })

    const existing = accounts.get(accountId)
    if (existing && ['connected', 'connecting', 'waiting_for_qr'].includes(existing.status)) {
      return res.json({
        status: 'ok',
        message: 'Account already initializing or connected',
        ...publicState(accountId, existing),
      })
    }

    const entry = await connectAccount(accountId, { isManual: true })
    return res.json({ status: 'ok', ...publicState(accountId, entry) })
  })
)

app.post(
  '/whatsapp/accounts/logout',
  wrap(async (req, res) => {
    const accountId = validateAccountId(req.body?.account_id)
    const entry = getAccountOrThrow(accountId)

    if (!entry.sock) {
      throw new HttpError(
        409,
        `WhatsApp account '${accountId}' has no active socket to log out (status: ${entry.status}).`
      )
    }

    logAction('info', 'whatsapp_logout_requested', { account_id: accountId })

    try {
      // Properly unlinks this device on WhatsApp's side — the phone will
      // show it removed from Settings -> Linked Devices, unlike just
      // deleting the local session files.
      await entry.sock.logout()
      logAction('info', 'whatsapp_logout_success', { account_id: accountId })
    } catch (err) {
      logAction('warn', 'whatsapp_logout_error', {
        account_id: accountId,
        error: err?.message || String(err),
      })
      // Fall through: we told the server to log out either way, so this
      // socket must not be reused regardless of whether logout() itself
      // threw (it can throw once the connection starts closing as part
      // of the same logout).
    }

    // Set state directly rather than relying on the connection.update
    // handler's timing: no more auto-reconnect for this account_id, and
    // the old socket must never be reused after a logout was requested.
    entry.status = 'requires_auth'
    entry.requiresAuth = true
    entry.lastError = null
    entry.sock = null

    res.json({
      status: 'ok',
      message: 'Logout requested — device unlinked on WhatsApp. Session files were not deleted.',
      ...publicState(accountId, entry),
    })
  })
)

app.post(
  '/whatsapp/accounts/pause',
  wrap(async (req, res) => {
    const accountId = validateAccountId(req.body?.account_id)
    const entry = getAccountOrThrow(accountId)
    const result = pausedAccounts.pause(accountId)
    logAction('info', 'wa_pause_requested', { account_id: accountId })
    // publicState()'s own `status` field is the WhatsApp connection status
    // (e.g. "connected") -- spread it first, then force the request-outcome
    // `status: 'ok'` last so it always wins, matching every other endpoint
    // in this worker (and telegram-worker's) response-shape convention.
    res.json({ ...publicState(accountId, entry), ...result, status: 'ok' })
  })
)

app.post(
  '/whatsapp/accounts/resume',
  wrap(async (req, res) => {
    const accountId = validateAccountId(req.body?.account_id)
    const entry = getAccountOrThrow(accountId)
    const result = pausedAccounts.resume(accountId)
    logAction('info', 'wa_resume_requested', { account_id: accountId, was_paused: result.was_paused })
    res.json({ ...publicState(accountId, entry), ...result, status: 'ok' })
  })
)

app.get(
  '/whatsapp/status',
  wrap(async (req, res) => {
    const accountId = validateAccountId(req.query.account_id)
    const entry = getAccountOrThrow(accountId)
    res.json({ status: 'ok', ...publicState(accountId, entry) })
  })
)

app.get(
  '/whatsapp/qr',
  wrap(async (req, res) => {
    const accountId = validateAccountId(req.query.account_id)
    const entry = getAccountOrThrow(accountId)

    let qrDataUrl = null
    if (entry.qr && qrToDataURL) {
      try {
        qrDataUrl = await qrToDataURL(entry.qr)
      } catch (err) {
        logAction('error', 'qr_data_url_render_failed', {
          account_id: accountId,
          error: err?.message || String(err),
        })
      }
    }

    // Never return session credentials — only the transient pairing QR.
    res.json({
      status: 'ok',
      account_id: accountId,
      qr_status: entry.status,
      qr: entry.qr || null,
      qr_data_url: qrDataUrl,
    })
  })
)

app.get(
  '/whatsapp/groups',
  wrap(async (req, res) => {
    const accountId = validateAccountId(req.query.account_id)
    const entry = getConnectedAccountOrThrow(accountId)

    const groups = await entry.sock.groupFetchAllParticipating()

    const result = Object.values(groups)
      .map(group => ({
        name: group.subject || '',
        destination_id: group.id,
        destination_type: 'group',
        owner: group.owner || '',
        participants: group.participants?.length || 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

    res.json({ status: 'ok', account_id: accountId, count: result.length, groups: result })
  })
)

// Read-only, additive (2026-10-07, dashboard operator request): the full
// participant list for ONE group -- raw phone-number JIDs + admin flag
// only. Deliberately a separate endpoint from /whatsapp/groups above
// rather than adding this array to every group there: that endpoint is
// also used for the Sources sync, which only ever needs name/id/type, and
// embedding every group's full participant list in that response would
// bloat it for no benefit to that caller. No display names are available
// here -- Baileys' groupMetadata never includes one (WhatsApp does not
// expose a participant's name to anyone outside their own contact book),
// and this worker runs with no contact store attached (see makeWASocket()
// above, no `auth`-adjacent store option set), so there is nothing to
// resolve a JID against even for participants already in wa_anna's own
// contacts.
app.get(
  '/whatsapp/groups/participants',
  wrap(async (req, res) => {
    const accountId = validateAccountId(req.query.account_id)
    const entry = getConnectedAccountOrThrow(accountId)

    const groupId = String(req.query.group_id || '').trim()
    if (!groupId) {
      throw new HttpError(400, 'group_id query parameter is required')
    }

    const metadata = await entry.sock.groupMetadata(groupId)

    const participants = (metadata.participants || []).map(p => ({
      id: p.id,
      admin: p.admin || null,
    }))

    res.json({
      status: 'ok',
      account_id: accountId,
      group_id: groupId,
      name: metadata.subject || '',
      count: participants.length,
      participants,
    })
  })
)

app.get(
  '/whatsapp/resolve',
  wrap(async (req, res) => {
    const accountId = validateAccountId(req.query.account_id)
    const entry = getConnectedAccountOrThrow(accountId)

    const phone = normalizePhone(req.query.phone)
    if (!phone) {
      throw new HttpError(400, 'phone query parameter is required')
    }

    const destinationId = await resolvePrivateDestinationFromPhone(entry.sock, phone)

    res.json({
      status: 'ok',
      account_id: accountId,
      phone,
      destination_id: destinationId,
      destination_type: 'private',
    })
  })
)

app.post(
  '/whatsapp/send',
  wrap(async (req, res) => {
    const accountId = validateAccountId(req.body?.account_id)
    const entry = getConnectedAccountOrThrow(accountId)

    const message = String(req.body.message || '').trim()
    if (!message) {
      throw new HttpError(400, 'message is required')
    }

    // Log the send attempt itself, message length only — never the
    // message text — before we know the outcome.
    logAction('info', 'whatsapp_send_requested', {
      account_id: accountId,
      destination_id: req.body?.destination_id || null,
      phone_supplied: !!req.body?.phone,
      message_length: message.length,
    })

    const { destinationId, destinationType, resolvedFrom } = await resolveDestination(
      entry.sock,
      req.body
    )

    const actualType = destinationType || inferDestinationType(destinationId)

    if (actualType === 'unknown') {
      throw new HttpError(400, 'Unsupported WhatsApp destination_id format')
    }
    if (actualType === 'broadcast') {
      throw new HttpError(400, 'Broadcast/status sending is not enabled')
    }

    const automationToken = outboundTracker.prepare(accountId, destinationId, message)
    let sent
    try {
      sent = await entry.sock.sendMessage(destinationId, { text: message })
    } catch (err) {
      outboundTracker.cancel(automationToken)
      throw err
    }

    logAction('info', 'whatsapp_send_completed', {
      account_id: accountId,
      destination_id: destinationId,
      destination_type: actualType,
      resolved_from: resolvedFrom,
      message_id: sent?.key?.id || '',
    })

    res.json({
      status: 'ok',
      platform: 'whatsapp',
      account_id: accountId,
      destination_id: destinationId,
      destination_type: actualType,
      resolved_from: resolvedFrom,
      message_id: sent?.key?.id || '',
      message,
    })
  })
)

// 404 for anything unmatched.
app.use((req, res) => {
  res.status(404).json({ status: 'error', error: 'Not found' })
})

// Central error handler. Logs full detail server-side only; the client
// only ever sees a short message and the right HTTP status.
app.use((err, req, res, next) => {
  const statusCode = err.statusCode || 500
  logAction(statusCode >= 500 ? 'error' : 'warn', 'http_error', {
    method: req.method,
    path: req.path,
    status_code: statusCode,
    error: err?.message || String(err),
  })
  const message = statusCode >= 500 ? 'Internal server error' : (err.message || 'Error')
  res.status(statusCode).json({ status: 'error', error: message })
})

app.listen(PORT, HOST, () => {
  logAction('info', 'worker_starting', {
    port: PORT,
    sessions_dir: SESSIONS_DIR,
    logs_dir: LOGS_DIR,
    worker_api_key_configured: !!WORKER_API_KEY,
    qr_data_url_supported: !!qrToDataURL,
    private_reply_webhook_enabled: privateReplyWebhookQueue.enabled,
    reply_debounce_enabled: replyDebouncer !== null,
    reply_debounce_seconds: WA_REPLY_DEBOUNCE_SECONDS,
    reply_typing_seconds: WA_TYPING_SECONDS,
    automation_status_probe_enabled: automationStatusProbe.enabled,
    group_monitor_webhook_enabled: groupMonitorWebhookQueue.enabled,
    group_monitor_webhook_target_count: groupMonitorWebhookQueue.targetCount,
    group_monitor_groups_configured: WA_MONITOR_GROUP_IDS.size,
  })

  privateReplyWebhookQueue.start()
  groupMonitorWebhookQueue.start()
  bootstrapExistingAccounts()
})

async function shutdown(signal) {
  logAction('info', 'worker_shutting_down', { signal, accounts: accounts.size })
  privateReplyWebhookQueue.stop()
  groupMonitorWebhookQueue.stop()
  for (const [accountId, entry] of accounts.entries()) {
    try {
      entry.sock?.end?.(undefined)
    } catch (err) {
      logAction('error', 'whatsapp_shutdown_close_failed', {
        account_id: accountId,
        error: err?.message || String(err),
      })
    }
  }
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
