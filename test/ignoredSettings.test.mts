/**
 * Which explicitly-set VS Code keys deserve the "ignored in remote mode"
 * warning, and when the warning re-arms.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_ONLY_KEYS, describeKeys, fingerprint, ignoredKeys } from '../src/services/ignoredSettings.ts'

test('client-only keys are never flagged', () => {
  const out = ignoredKeys([
    { key: 'mode', global: true, workspace: false },
    { key: 'daemonUrl', global: true, workspace: false },
    { key: 'server.decodeConcurrency', global: true, workspace: false },
  ])
  assert.deepEqual(
    out.map((k) => k.key),
    ['server.decodeConcurrency'],
  )
})

test('keys not actually set are not flagged', () => {
  const out = ignoredKeys([
    { key: 'modelsDir', global: false, workspace: false },
    { key: 'venvPath', global: false, workspace: true },
  ])
  assert.deepEqual(
    out.map((k) => k.key),
    ['venvPath'],
  )
})

test('the fingerprint is order-independent, so dismissal survives re-scan', () => {
  const a = fingerprint([
    { key: 'b', global: true, workspace: false },
    { key: 'a', global: true, workspace: false },
  ])
  const b = fingerprint([
    { key: 'a', global: false, workspace: true },
    { key: 'b', global: true, workspace: false },
  ])
  assert.equal(a, b)
})

test('a new offender changes the fingerprint and re-arms the warning', () => {
  const before = fingerprint([{ key: 'a', global: true, workspace: false }])
  const after = fingerprint([
    { key: 'a', global: true, workspace: false },
    { key: 'c', global: true, workspace: false },
  ])
  assert.notEqual(before, after)
})

test('descriptions stay toast-sized', () => {
  const two = describeKeys([
    { key: 'modelsDir', global: true, workspace: false },
    { key: 'venvPath', global: true, workspace: false },
  ])
  assert.equal(two, 'modelsDir and venvPath')
  const four = describeKeys(
    ['a', 'b', 'c', 'd'].map((key) => ({ key, global: true, workspace: false })),
  )
  assert.equal(four, 'a and 3 more')
})

test('the client-only list is exactly the two keys remote mode reads', () => {
  assert.deepEqual([...CLIENT_ONLY_KEYS].sort(), ['daemonUrl', 'mode'])
})
