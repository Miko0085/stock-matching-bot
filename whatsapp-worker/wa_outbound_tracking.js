import crypto from 'crypto'

class AutomatedOutboundTracker {
  constructor({ ttlMs = 15_000, now = () => Date.now() } = {}) {
    this._ttlMs = ttlMs
    this._now = now
    this._pending = []
  }

  prepare(accountId, destinationId, text) {
    this._prune()
    const token = crypto.randomUUID()
    this._pending.push({
      token,
      accountId: String(accountId),
      destinationId: String(destinationId),
      text: String(text),
      expiresAt: this._now() + this._ttlMs,
    })
    return token
  }

  cancel(token) {
    this._pending = this._pending.filter(item => item.token !== token)
  }

  consume(accountId, destinationId, text) {
    this._prune()
    const match = this._pending.find(item =>
      item.accountId === String(accountId) &&
      item.destinationId === String(destinationId) &&
      item.text === String(text)
    )
    if (!match) return false
    this.cancel(match.token)
    return true
  }

  _prune() {
    const now = this._now()
    this._pending = this._pending.filter(item => item.expiresAt > now)
  }
}

export { AutomatedOutboundTracker }
