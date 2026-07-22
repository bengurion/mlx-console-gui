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
  grantsPasswordless,
  isSafeUserName,
  manualCommand,
  sampleCommand,
  samplePath,
  scrubForLog,
  sudoersEscape,
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

  // The rule carries sudoers escapes, so compare after removing them: what
  // must not drift is the command, not its encoding.
  assert.ok(
    rule.replace(/\\([,:=\\])/g, '$1').includes(cmd.join(' ')),
    'rule and sampler must not drift apart',
  )
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

test('an admin\'s blanket (ALL) ALL is not mistaken for a grant', () => {
  const command = sampleCommand('/Users/ben')

  // Real `sudo -l` output on an admin account with no rule installed. Asking
  // "may I run this?" answers yes here — it just wants a password — which is
  // why the check has to be for NOPASSWD specifically.
  const noRule = [
    'User ben may run the following commands on bens-macbook-pro:',
    '    (ALL) ALL',
  ].join('\n')
  assert.equal(grantsPasswordless(noRule, command), false)

  // sudo echoes the entry as sudoers stores it, escapes intact.
  const withRule = [
    'User ben may run the following commands on bens-macbook-pro:',
    '    (ALL) ALL',
    `    (root) NOPASSWD: ${command.map(sudoersEscape).join(' ')}`,
  ].join('\n')
  assert.equal(grantsPasswordless(withRule, command), true)
})

test('a grant for a different command does not count', () => {
  // What an older version installed: same binary, different samplers. sudo
  // would refuse the command we now run, so reporting "enabled" would mean
  // failing on every sample instead of offering to re-authorise.
  const stale =
    '    (root) NOPASSWD: /usr/bin/powermetrics --samplers tasks --show-process-gpu -n 1 -i 1000 -o /Users/ben/.mlx-console/powermetrics.txt'
  assert.equal(grantsPasswordless(stale, sampleCommand('/Users/ben')), false)

  // And a NOPASSWD line for something else entirely.
  assert.equal(
    grantsPasswordless('    (root) NOPASSWD: /bin/rm -rf /tmp/x', sampleCommand('/Users/ben')),
    false,
  )
})

test('the rule escapes what sudoers treats as syntax, and visudo accepts it', () => {
  const rule = sudoersRule('ben', sampleCommand('/Users/ben'))

  // The comma in `--samplers tasks,gpu_power` is a list separator in sudoers:
  // unescaped, visudo reports "expected a fully-qualified path name" and the
  // whole file is rejected.
  assert.ok(rule.includes('tasks\\,gpu_power'), 'the comma is escaped')
  assert.equal(/[^\\],gpu_power/.test(rule), false, 'no bare comma survives')

  assert.equal(sudoersEscape('a,b'), 'a\\,b')
  assert.equal(sudoersEscape('a:b=c'), 'a\\:b\\=c')
  assert.equal(sudoersEscape('back\\slash'), 'back\\\\slash')
  assert.equal(sudoersEscape('/usr/bin/powermetrics'), '/usr/bin/powermetrics', 'paths untouched')
})

test('an unescaped comma in a listing means two commands, not one', () => {
  const command = sampleCommand('/Users/ben')

  // Not a formatting quirk to paper over: in sudoers grammar a bare comma
  // separates entries, so this listing grants `... --samplers tasks` and a
  // second command starting `gpu_power` — neither of which is what we run.
  const bareComma = `    (root) NOPASSWD: ${command.join(' ')}`
  assert.equal(grantsPasswordless(bareComma, command), false)

  const escaped = `    (root) NOPASSWD: ${command.map(sudoersEscape).join(' ')}`
  assert.equal(grantsPasswordless(escaped, command), true, 'escapes are normalised away')
})

test('a grant wrapped across lines by sudo is still recognised', () => {
  const command = sampleCommand('/Users/ben')

  // Verbatim from `sudo -n -l` on this machine: sudo hard-wraps at ~80
  // columns, so the command spans two lines and no single line contains it.
  // Matching line by line reported "not authorised" for a rule that was
  // installed and working.
  const listing = [
    'User ben may run the following commands on bens-macbook-pro:',
    '    (ALL) ALL',
    '    (root) NOPASSWD: /usr/bin/powermetrics --samplers tasks\\,gpu_power',
    '    --show-process-gpu -n 1 -i 1000 -o /Users/ben/.mlx-console/powermetrics.txt',
  ].join('\n')

  assert.equal(grantsPasswordless(listing, command), true)
})

test('a NOPASSWD for something else does not vouch for our command', () => {
  const command = sampleCommand('/Users/ben')

  // Our command appears, but under (ALL) ALL — which needs a password — while
  // the passwordless grant is for an unrelated binary.
  const listing = [
    '    (root) NOPASSWD: /bin/rm -f /tmp/x',
    `    (ALL) ALL: ${command.join(' ')}`,
  ].join('\n')
  assert.equal(grantsPasswordless(listing, command), false)
})
