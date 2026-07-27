/**
 * Writing Claude Code wiring into settings.json without wrecking it.
 *
 * The JSONC round-trip is the part that must not go quietly wrong: comments,
 * trailing commas and the user's own entries have to survive, a file that
 * does not parse must never be overwritten, and re-applying must be a no-op.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ENV_SETTING,
  MANAGED_ENV_KEYS,
  applyToEditor,
  desiredEnv,
  detectEditors,
  mergeEnv,
  planEdits,
  runtimeSettingKeys,
} from '../src/services/vscodeIntegration.ts'

const MODEL = 'cloudyu/gpt-oss-120b-Fable-5-Distilled'

test('desiredEnv writes exactly the managed keys', () => {
  const env = desiredEnv({ anthropicBaseUrl: 'http://127.0.0.1:8081', model: MODEL })
  assert.deepEqual(env.map((e) => e.name), [...MANAGED_ENV_KEYS])
  const map = new Map(env.map((e) => [e.name, e.value]))
  assert.equal(map.get('ANTHROPIC_MODEL'), MODEL)
  assert.equal(map.get('ANTHROPIC_SMALL_FAST_MODEL'), MODEL)
})

test('the base URL is an origin: a trailing /v1 is stripped', () => {
  // Anthropic clients append /v1/messages themselves; /v1/v1/messages 404s.
  const env = desiredEnv({ anthropicBaseUrl: 'http://127.0.0.1:8081/v1', model: MODEL })
  assert.equal(env[0].value, 'http://127.0.0.1:8081')
})

test('mergeEnv updates managed entries in place and keeps the rest', () => {
  const existing = [
    { name: 'MY_OWN_VAR', value: 'keep' },
    { name: 'ANTHROPIC_BASE_URL', value: 'http://old:1' },
  ]
  const merged = mergeEnv(existing, desiredEnv({ anthropicBaseUrl: 'http://127.0.0.1:8081', model: MODEL }))
  assert.equal(merged[0].name, 'MY_OWN_VAR')
  assert.equal(merged[1].value, 'http://127.0.0.1:8081')
  assert.equal(merged.length, 2 + MANAGED_ENV_KEYS.length - 1)
})

test('mergeEnv is idempotent', () => {
  const desired = desiredEnv({ anthropicBaseUrl: 'http://x:1', model: MODEL })
  const once = mergeEnv([], desired)
  assert.deepEqual(mergeEnv(once, desired), once)
})

const COMMENTED = `{
    // where the models live
    "mlxConsole.cleanEndpoint.enabled": true,
    "mlxServe.modelsDir": "/tmp/models",
    /* editor prefs */
    "editor.fontSize": 13,
}
`

test('planEdits preserves comments on kept keys and unrelated keys', () => {
  // A comment attached to a REMOVED key goes with it (jsonc-parser matches
  // VS Code's own behavior there); comments on surviving keys must stay.
  const out = planEdits(COMMENTED, {
    env: desiredEnv({ anthropicBaseUrl: 'http://127.0.0.1:8081', model: MODEL }),
    removeKeys: ['mlxServe.modelsDir'],
  })
  assert.ok(out.ok && out.changed)
  assert.match(out.text, /\/\/ where the models live/)
  assert.match(out.text, /\/\* editor prefs \*\//)
  assert.match(out.text, /"editor\.fontSize": 13/)
  assert.doesNotMatch(out.text, /mlxServe\.modelsDir/)
  assert.match(out.text, /"ANTHROPIC_BASE_URL"/)
})

test('planEdits is a no-op the second time', () => {
  const env = desiredEnv({ anthropicBaseUrl: 'http://127.0.0.1:8081', model: MODEL })
  const first = planEdits(COMMENTED, { env, removeKeys: ['mlxServe.modelsDir'] })
  assert.ok(first.ok)
  const second = planEdits(first.text, { env, removeKeys: ['mlxServe.modelsDir'] })
  assert.ok(second.ok)
  assert.equal(second.changed, false)
})

test('an empty or missing file becomes a minimal settings object', () => {
  const out = planEdits('', { env: desiredEnv({ anthropicBaseUrl: 'http://x:1', model: MODEL }) })
  assert.ok(out.ok && out.changed)
  const parsed = JSON.parse(out.text) as Record<string, unknown>
  assert.ok(Array.isArray(parsed[ENV_SETTING]))
})

test('an unparseable file is refused, never overwritten', () => {
  const out = planEdits('{ this is not json', { env: [] })
  assert.ok(!out.ok)
  assert.match(out.error, /not valid JSONC/)
})

test('applyToEditor backs up only when it changes something', () => {
  const files = new Map<string, string>([['/u/settings.json', COMMENTED]])
  const io = {
    exists: (p: string) => files.has(p),
    read: (p: string) => files.get(p) ?? '',
    write: (p: string, t: string) => void files.set(p, t),
  }
  const env = desiredEnv({ anthropicBaseUrl: 'http://x:1', model: MODEL })
  const now = new Date(2026, 6, 25, 12, 0, 0)

  const first = applyToEditor({ settingsPath: '/u/settings.json', env, io, now })
  assert.ok(first.ok && first.changed)
  assert.equal(first.backupPath, '/u/settings.json.mlx-backup-20260725-120000')
  assert.equal(files.get(first.backupPath!), COMMENTED)

  const second = applyToEditor({ settingsPath: '/u/settings.json', env, io, now })
  assert.ok(second.ok)
  assert.equal(second.changed, false)
  assert.equal(second.backupPath, undefined)
})

test('unwire removes only the managed entries, and the key itself when empty', () => {
  const desired = desiredEnv({ anthropicBaseUrl: 'http://x:1', model: MODEL })
  const withMine = JSON.stringify({
    [ENV_SETTING]: [{ name: 'MY_OWN_VAR', value: 'keep' }, ...desired],
    'editor.fontSize': 13,
  })
  const out = planEdits(withMine, { unwire: true })
  assert.ok(out.ok && out.changed)
  const parsed = JSON.parse(out.text) as Record<string, unknown>
  assert.deepEqual(parsed[ENV_SETTING], [{ name: 'MY_OWN_VAR', value: 'keep' }])

  const onlyManaged = JSON.stringify({ [ENV_SETTING]: desired, 'editor.fontSize': 13 })
  const gone = planEdits(onlyManaged, { unwire: true })
  assert.ok(gone.ok && gone.changed)
  const parsedGone = JSON.parse(gone.text) as Record<string, unknown>
  assert.ok(!(ENV_SETTING in parsedGone), 'empty block is dropped entirely')
  assert.equal(parsedGone['editor.fontSize'], 13)
})

test('unwire on an unwired file changes nothing', () => {
  const out = planEdits('{ "editor.fontSize": 13 }', { unwire: true })
  assert.ok(out.ok)
  assert.equal(out.changed, false)
})

test('detectEditors reports installed, wired and stale per editor', () => {
  const desired = desiredEnv({ anthropicBaseUrl: 'http://x:1', model: MODEL })
  const home = '/home/u'
  const codeDir = `${home}/Library/Application Support/Code/User`
  const cursorDir = `${home}/Library/Application Support/Cursor/User`
  const wired = JSON.stringify({
    [ENV_SETTING]: desired,
    'mlxServe.old': 1,
    'mlxConsole.server.port': 9999,
    'mlxConsole.daemonUrl': 'http://x',
  })
  const files = new Map<string, string>([
    [codeDir, ''],
    [`${codeDir}/settings.json`, wired],
    [cursorDir, ''],
  ])
  const io = { exists: (p: string) => files.has(p), read: (p: string) => files.get(p) ?? '' }

  const out = detectEditors({ desired, cleanupKeys: ['mlxConsole.server.port'], home, io })
  const code = out.find((e) => e.id === 'Code')!
  assert.ok(code.installed && code.wired && code.hasWiring)
  // mlxServe.* always stale; mlxConsole.* only when listed; daemonUrl never listed.
  assert.deepEqual(code.staleKeys.sort(), ['mlxConsole.server.port', 'mlxServe.old'])

  const cursor = out.find((e) => e.id === 'Cursor')!
  assert.ok(cursor.installed)
  assert.equal(cursor.wired, false)

  const insiders = out.find((e) => e.id === 'Code - Insiders')!
  assert.equal(insiders.installed, false)
})

test('runtimeSettingKeys drops the client-only pair', () => {
  const keys = runtimeSettingKeys({
    contributes: {
      configuration: {
        properties: {
          'mlxConsole.mode': {},
          'mlxConsole.daemonUrl': {},
          'mlxConsole.server.port': {},
          'other.thing': {},
        },
      },
    },
  })
  assert.deepEqual(keys, ['mlxConsole.server.port'])
})
