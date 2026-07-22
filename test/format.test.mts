import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bytes, count, shortRepo } from '../webview/src/format.ts'

test('bytes formats human-readable sizes', () => {
  assert.equal(bytes(0), '—')
  assert.equal(bytes(512), '512 B')
  assert.equal(bytes(1536), '1.5 KB')
  assert.equal(bytes(1073741824), '1.0 GB')
})

test('count abbreviates large numbers', () => {
  assert.equal(count(0), '0')
  assert.equal(count(999), '999')
  assert.equal(count(1500), '1.5k')
  assert.equal(count(2_000_000), '2.0M')
})

test('shortRepo returns the last path segment', () => {
  assert.equal(shortRepo('mlx-community/Qwen2.5-Coder-7B-Instruct-4bit'), 'Qwen2.5-Coder-7B-Instruct-4bit')
  assert.equal(shortRepo('noslash'), 'noslash')
})
