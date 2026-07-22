/**
 * The policy around privileged sampling.
 *
 * The value of this grant is entirely in how narrow it is, so what it covers
 * is asserted rather than assumed: one absolute binary, one exact argument
 * list, no wildcards, and an output path we own.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  POWERMETRICS_BIN,
  SUDOERS_PATH,
  isSafeUserName,
  manualCommand,
  sampleCommand,
  samplePath,
  scrubForLog,
  sudoersRule,
} from '../src/services/rootAccess.ts'

test('the grant names one absolute binary and no wildcards', () => {
  const rule = sudoersRule('ben', sampleCommand('/Users/ben'))

  assert.match(rule, /^ben ALL=\(root\) NOPASSWD: \/usr\/bin\/powermetrics /m)
  assert.equal(rule.includes('*'), false, 'a wildcard would let the command be re-aimed')
  assert.equal(rule.includes('ALL$'), false)
  assert.ok(rule.endsWith('\n'), 'visudo rejects a file without a trailing newline')
})

test('the authorised command is exactly the one that will be run', () => {
  const cmd = sampleCommand('/Users/ben')
  const rule = sudoersRule('ben', cmd)

  assert.ok(rule.includes(cmd.join(' ')), 'rule and sampler must not drift apart')
  // The manual fallback shown in the UI has to be the same command too, or
  // someone copies one thing and the app runs another.
  assert.equal(manualCommand('/Users/ben'), `sudo ${cmd.join(' ')}`)
  assert.equal(cmd[0], POWERMETRICS_BIN, 'absolute path, not a PATH lookup')
})

test('the sample lands in a directory we own, not a shared one', () => {
  const out = samplePath('/Users/ben')
  assert.equal(out, '/Users/ben/.mlx-console/powermetrics.txt')
  assert.equal(
    out.startsWith('/tmp'),
    false,
    'a predictable name in /tmp is another local user’s opportunity',
  )
  assert.ok(sampleCommand('/Users/ben').includes(out), 'the rule pins the output path')
})

test('an account name that could break out of the rule is refused', () => {
  for (const ok of ['ben', 'ben.doucet', 'user_1', '_service']) {
    assert.equal(isSafeUserName(ok), true, ok)
  }
  for (const bad of ['ben ALL=(root)', 'ben\nroot', 'ben,root', '', 'a'.repeat(40), 'ben#']) {
    assert.equal(isSafeUserName(bad), false, JSON.stringify(bad))
  }
})

test('the drop-in path is a single file, so revoking is one deletion', () => {
  assert.equal(SUDOERS_PATH, '/etc/sudoers.d/mlx-console')
})

test('anything credential-shaped is scrubbed before it can reach a log', () => {
  assert.equal(scrubForLog('[sudo] password for ben:'), '[credential prompt]')

  const scrubbed = scrubForLog('password=correcthorse')
  assert.equal(scrubbed, '[redacted]')
  assert.equal(scrubbed.includes('correcthorse'), false, 'the value must not survive')

  // A replacement containing the word the next pattern matches would be
  // rewritten by it — the reason these run in this order with these strings.
  assert.equal(scrubForLog('[sudo] password for ben:').includes('[redacted]'), false)
  assert.equal(scrubForLog('visudo: ok'), 'visudo: ok', 'ordinary output stays readable')
})
