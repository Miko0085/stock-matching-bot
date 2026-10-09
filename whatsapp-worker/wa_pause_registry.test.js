'use strict'

// Unit tests for wa_pause_registry.js's PausedAccountsRegistry.
//
// Run:
//   cd whatsapp-worker
//   node --test wa_pause_registry.test.js

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { PausedAccountsRegistry } from './wa_pause_registry.js'

function tmpStatePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-pause-test-'))
  return path.join(dir, 'paused_accounts.json')
}

test('starts empty when no state file exists', () => {
  const registry = new PausedAccountsRegistry(tmpStatePath())
  assert.equal(registry.isPaused('wa_main'), false)
  assert.deepEqual(registry.listPaused(), [])
})

test('pause then isPaused is true', () => {
  const registry = new PausedAccountsRegistry(tmpStatePath())
  const result = registry.pause('wa_main')
  assert.equal(registry.isPaused('wa_main'), true)
  assert.equal(result.account_id, 'wa_main')
  assert.equal(result.paused, true)
  assert.ok(result.paused_at)
})

test('pause never affects a different account', () => {
  const registry = new PausedAccountsRegistry(tmpStatePath())
  registry.pause('wa_main')
  assert.equal(registry.isPaused('wa_second'), false)
})

test('resume clears the pause', () => {
  const registry = new PausedAccountsRegistry(tmpStatePath())
  registry.pause('wa_main')
  const result = registry.resume('wa_main')
  assert.equal(registry.isPaused('wa_main'), false)
  assert.equal(result.was_paused, true)
  assert.equal(result.paused, false)
})

test('resume on a non-paused account is a harmless no-op', () => {
  const registry = new PausedAccountsRegistry(tmpStatePath())
  const result = registry.resume('wa_never_paused')
  assert.equal(result.was_paused, false)
})

test('pause is idempotent and keeps the original paused_at', () => {
  const registry = new PausedAccountsRegistry(tmpStatePath())
  const first = registry.pause('wa_main')
  const second = registry.pause('wa_main')
  assert.equal(first.paused_at, second.paused_at)
})

test('pause requires a non-empty account_id', () => {
  const registry = new PausedAccountsRegistry(tmpStatePath())
  assert.throws(() => registry.pause(''))
})

test('state persists to disk and reloads in a new instance', () => {
  const statePath = tmpStatePath()
  const registry1 = new PausedAccountsRegistry(statePath)
  registry1.pause('wa_main')

  assert.ok(fs.existsSync(statePath))
  const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.ok('wa_main' in onDisk.paused)

  const registry2 = new PausedAccountsRegistry(statePath) // fresh instance, same file
  assert.equal(registry2.isPaused('wa_main'), true)
})

test('listPaused reflects multiple accounts sorted', () => {
  const registry = new PausedAccountsRegistry(tmpStatePath())
  registry.pause('wa_second')
  registry.pause('wa_first')
  const listed = registry.listPaused()
  assert.deepEqual(listed.map((e) => e.account_id), ['wa_first', 'wa_second'])
})

test('a missing or corrupt state file starts empty instead of crashing', () => {
  const statePath = tmpStatePath()
  fs.writeFileSync(statePath, 'not valid json{{{', 'utf8')
  const registry = new PausedAccountsRegistry(statePath)
  assert.equal(registry.isPaused('wa_main'), false)
})
