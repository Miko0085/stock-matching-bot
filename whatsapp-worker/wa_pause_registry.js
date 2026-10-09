// wa_pause_registry.js — per-account "paused" flag, persisted to
// state/paused_accounts.json so it survives a worker restart.
//
// When an account is paused, server.js's messages.upsert handler skips ALL
// processing for its inbound events -- no webhook forwarding, no
// private-reply debounce, no outbound tracking -- as if the worker weren't
// listening at all, while the account itself stays fully connected to
// WhatsApp.
//
// Deliberately NOT the same as logout (POST /whatsapp/accounts/logout):
// the session, its connection, and all channels/routing/monitoring config
// remain completely untouched -- only whether events get PROCESSED
// changes. Resuming needs no re-pairing, no QR, nothing but
// POST /whatsapp/accounts/resume.
//
// Same atomic-write pattern as the rest of this project's persisted state
// (write to a temp file in the same directory, then rename()) so a crash
// or concurrent read never observes a partially-written file.

import fs from 'fs'
import path from 'path'

export class PausedAccountsRegistry {
  constructor(statePath, logAction = () => {}) {
    this.statePath = statePath
    this.logAction = logAction
    this.paused = new Map() // account_id -> ISO timestamp paused_at
    this._load()
  }

  _load() {
    if (!fs.existsSync(this.statePath)) {
      this.paused = new Map()
      return
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8') || '{}')
      const entries = Object.entries(raw.paused || {})
      this.paused = new Map(entries.map(([k, v]) => [String(k), String(v)]))
    } catch (err) {
      this.logAction('error', 'wa_pause_registry_load_failed', {
        path: this.statePath,
        error: err?.message || String(err),
      })
      this.paused = new Map()
    }
  }

  _persist() {
    const dir = path.dirname(this.statePath)
    fs.mkdirSync(dir, { recursive: true })
    const payload = JSON.stringify({ paused: Object.fromEntries(this.paused) }, null, 2)
    const tmpPath = path.join(dir, `.paused_accounts-${process.pid}-${Date.now()}.tmp`)
    fs.writeFileSync(tmpPath, payload, 'utf8')
    fs.renameSync(tmpPath, this.statePath)
  }

  isPaused(accountId) {
    return this.paused.has(String(accountId || ''))
  }

  pause(accountId) {
    accountId = String(accountId || '').trim()
    if (!accountId) throw new Error('account_id is required')
    if (!this.paused.has(accountId)) {
      this.paused.set(accountId, new Date().toISOString())
      this._persist()
    }
    this.logAction('info', 'wa_account_paused', { account_id: accountId })
    return { account_id: accountId, paused: true, paused_at: this.paused.get(accountId) }
  }

  resume(accountId) {
    accountId = String(accountId || '').trim()
    const wasPaused = this.paused.has(accountId)
    if (wasPaused) {
      this.paused.delete(accountId)
      this._persist()
      this.logAction('info', 'wa_account_resumed', { account_id: accountId })
    }
    return { account_id: accountId, paused: false, was_paused: wasPaused }
  }

  listPaused() {
    return Array.from(this.paused.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([account_id, paused_at]) => ({ account_id, paused_at }))
  }
}
