import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseState,
  serializeState,
  isUsableState,
  STALE_AFTER_MS,
  type SharedServerState,
} from '../src/backend/serverRegistry.ts'

const NOW = 1_700_000_000_000
const alive = () => true
const dead = () => false

const STATE: SharedServerState = {
  pid: 4242,
  port: 8080,
  loadedModel: 'cloudyu/gpt-oss-120b-Fable-5-Distilled',
  loadedAt: NOW - 60_000,
  lastLoadSeconds: 91.4,
  updatedAt: NOW - 60_000,
}

test('state survives a serialize/parse round trip', () => {
  assert.deepEqual(parseState(serializeState(STATE)), STATE)
})

test('parseState rejects junk and records without a port', () => {
  assert.equal(parseState('not json'), undefined)
  assert.equal(parseState('null'), undefined)
  assert.equal(parseState(JSON.stringify({ loadedModel: 'x' })), undefined)
})

test('parseState drops fields of the wrong type', () => {
  const s = parseState(JSON.stringify({ port: 8080, pid: 'nope', loadedModel: 42 }))!
  assert.equal(s.port, 8080)
  assert.equal(s.pid, undefined)
  assert.equal(s.loadedModel, undefined)
})

test('a record for another port is not adopted', () => {
  assert.equal(isUsableState(STATE, 8080, alive, NOW), true)
  assert.equal(isUsableState(STATE, 9999, alive, NOW), false)
})

test('a dead pid invalidates an otherwise fresh record', () => {
  assert.equal(isUsableState(STATE, 8080, dead, NOW), false)
})

test('a stale record is ignored even when the pid is alive', () => {
  const old = { ...STATE, updatedAt: NOW - STALE_AFTER_MS - 1 }
  assert.equal(isUsableState(old, 8080, alive, NOW), false)
})

test('a record with no pid is still usable when fresh', () => {
  const noPid = { ...STATE, pid: undefined }
  assert.equal(isUsableState(noPid, 8080, dead, NOW), true, 'liveness is unknown, not false')
})

test('undefined state is never usable', () => {
  assert.equal(isUsableState(undefined, 8080, alive, NOW), false)
})
