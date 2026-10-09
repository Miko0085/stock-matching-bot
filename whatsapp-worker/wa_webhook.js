/**
 * wa_webhook.js — bounded-retry webhook delivery queue.
 * Mirrors telegram-worker/telegram_events.py's WebhookDeliveryQueue: a
 * simple in-memory queue + one background consumer, so the Baileys event
 * handler only ever does a fast, non-blocking enqueue() -- the actual
 * HTTP POST, timeout and retries happen in the consumer, so a slow or
 * unreachable receiver can never stall message reception.
 */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class WebhookDeliveryQueue {
  constructor({ url, secret, logAction, timeoutMs = 10000, maxRetries = 3, maxQueueSize = 1000 }) {
    this.url = (url || '').trim()
    this.secret = secret || ''
    this._logAction = logAction || (() => {})
    this._timeoutMs = timeoutMs
    this._maxRetries = Math.max(1, maxRetries)
    this._maxQueueSize = maxQueueSize
    this._queue = []
    this._running = false
  }

  get enabled() {
    return Boolean(this.url)
  }

  start() {
    if (!this.enabled) {
      this._logAction('wa_webhook_delivery_disabled', {
        detail: 'WA_PRIVATE_REPLY_WEBHOOK_URL is not set',
      })
      return
    }
    this._running = true
    this._logAction('wa_webhook_delivery_started', {
      timeout_ms: this._timeoutMs,
      max_retries: this._maxRetries,
    })
    this._consume()
  }

  stop() {
    this._running = false
  }

  enqueue(payload) {
    if (!this.enabled) return
    if (this._queue.length >= this._maxQueueSize) {
      this._logAction('wa_webhook_queue_full_dropped_event', {
        account_id: payload?.account_id || '',
        chat_id: payload?.chat_id || '',
        message_id: payload?.message_id ?? null,
      })
      return
    }
    this._queue.push(payload)
  }

  async _consume() {
    while (this._running) {
      if (this._queue.length === 0) {
        await sleep(200)
        continue
      }
      const payload = this._queue.shift()
      try {
        await this._deliverWithRetries(payload)
      } catch (err) {
        this._logAction('wa_webhook_delivery_unexpected_error', {
          error: err?.message || String(err),
        })
      }
    }
  }

  async _deliverWithRetries(payload) {
    const meta = {
      account_id: payload?.account_id || '',
      chat_id: payload?.chat_id || '',
      message_id: payload?.message_id ?? null,
      text_length: (payload?.text || '').length,
    }

    const headers = { 'Content-Type': 'application/json' }
    if (this.secret) headers['X-Webhook-Secret'] = this.secret

    let attempt = 0
    while (attempt < this._maxRetries) {
      attempt += 1
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this._timeoutMs)
        let response
        try {
          response = await fetch(this.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
          })
        } finally {
          clearTimeout(timer)
        }

        if (response.status < 300) {
          this._logAction('wa_webhook_delivered', { attempt, status_code: response.status, ...meta })
          return
        }
        this._logAction('wa_webhook_delivery_rejected', {
          attempt,
          status_code: response.status,
          ...meta,
        })
      } catch (err) {
        this._logAction('wa_webhook_delivery_error', {
          attempt,
          error: err?.message || String(err),
          ...meta,
        })
      }

      if (attempt < this._maxRetries) {
        await sleep(Math.min(2 ** attempt, 10) * 1000)
      }
    }

    this._logAction('wa_webhook_delivery_gave_up', { attempts: attempt, ...meta })
  }
}

/**
 * Parses a comma-separated list of webhook URLs paired with a
 * comma-separated list of secrets (mirrors
 * telegram-worker/telegram_events.py's parse_webhook_targets()):
 *   WA_MONITOR_WEBHOOK_URL=https://a.example/webhook/x,https://b.example/webhook/y
 *   WA_MONITOR_WEBHOOK_SECRET=secret-a,secret-b
 * One shared secret for several URLs is fine too. A single URL/secret
 * pair (the original shape) still works unchanged.
 */
function parseWebhookTargets(urlsRaw, secretsRaw) {
  const urls = String(urlsRaw || '')
    .split(',')
    .map(u => u.trim())
    .filter(Boolean)
  let secrets = secretsRaw
    ? String(secretsRaw)
        .split(',')
        .map(s => s.trim())
    : []

  if (secrets.length === 1 && urls.length > 1) {
    secrets = urls.map(() => secrets[0])
  }
  while (secrets.length < urls.length) secrets.push('')

  return urls.map((url, i) => ({ url, secret: secrets[i] }))
}

/**
 * Fans one event out to N independent webhook destinations. Each
 * destination is its own WebhookDeliveryQueue -- own queue, own
 * consumer loop, own bounded retries -- so a slow/down destination can
 * never delay or block delivery to the others. Same
 * enabled/start/stop/enqueue interface as WebhookDeliveryQueue, so it's
 * a drop-in replacement wherever a single queue was used before.
 */
class MultiWebhookDeliveryQueue {
  constructor({ targets, logAction, timeoutMs = 10000, maxRetries = 3, maxQueueSize = 1000 }) {
    this._queues = (targets || [])
      .filter(t => t?.url)
      .map(
        t =>
          new WebhookDeliveryQueue({
            url: t.url,
            secret: t.secret,
            logAction,
            timeoutMs,
            maxRetries,
            maxQueueSize,
          })
      )
  }

  get enabled() {
    return this._queues.some(q => q.enabled)
  }

  get targetCount() {
    return this._queues.length
  }

  start() {
    for (const q of this._queues) q.start()
  }

  stop() {
    for (const q of this._queues) q.stop()
  }

  enqueue(payload) {
    for (const q of this._queues) q.enqueue(payload)
  }
}

class AutomationStatusProbe {
  constructor({ url, secret, logAction, timeoutMs = 5000 }) {
    this.url = (url || '').trim()
    this.secret = secret || ''
    this._logAction = logAction || (() => {})
    this._timeoutMs = timeoutMs
  }

  get enabled() {
    return Boolean(this.url)
  }

  async isActive(payload) {
    const meta = {
      account_id: payload?.account_id || '',
      chat_id: payload?.chat_id || '',
      message_id: payload?.message_id ?? null,
    }
    if (!this.enabled) {
      this._logAction('wa_automation_status_unavailable', meta)
      return false
    }

    const headers = { 'Content-Type': 'application/json' }
    if (this.secret) headers['X-Webhook-Secret'] = this.secret
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this._timeoutMs)
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      if (response.status >= 300) {
        this._logAction('wa_automation_status_rejected', {
          status_code: response.status,
          ...meta,
        })
        return false
      }
      const body = await response.json()
      const active = body?.automation_active === true
      this._logAction('wa_automation_status_resolved', {
        automation_active: active,
        ...meta,
      })
      return active
    } catch (err) {
      this._logAction('wa_automation_status_failed', {
        error: err?.message || String(err),
        ...meta,
      })
      return false
    } finally {
      clearTimeout(timer)
    }
  }
}

export { WebhookDeliveryQueue, MultiWebhookDeliveryQueue, parseWebhookTargets, AutomationStatusProbe }
