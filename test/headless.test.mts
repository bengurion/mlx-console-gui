import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildServerArgs } from '../src/backend/serverArgs.ts'
import {
  SettingsStore,
  extractMlxSettings,
  parseJsonc,
  stripJsonComments,
} from '../src/headless/settingsStore.ts'
import { resolveVenv, venvCandidates, settingsCandidates } from '../src/headless/hostPaths.ts'
import { parsePgrepPids } from '../src/headless/serverControl.ts'
import { buildPlist, loadCommands, xmlEscape, LABEL } from '../src/headless/launchd.ts'
import { parseArgs } from '../src/headless/args.ts'
import {
  bundleCandidates,
  findBundle,
  findHelper,
  lastJsonLine,
  pythonError,
  selfPath,
} from '../src/headless/pythonBridge.ts'
import { migrateStorage, planMigration } from '../src/core/storageMigration.ts'

// ---- server arguments ------------------------------------------------------

test('flags left at 0 are omitted so the server keeps its own defaults', () => {
  const args = buildServerArgs({
    bindHost: '127.0.0.1',
    port: 8080,
    promptCacheSize: 0,
    decodeConcurrency: 0,
    numDraftTokens: 3,
  })
  assert.deepEqual(args, ['--host', '127.0.0.1', '--port', '8080', '--log-level', 'INFO'])
})

test('num-draft-tokens is only passed alongside a draft model', () => {
  const withoutDraft = buildServerArgs({ bindHost: 'h', port: 1, numDraftTokens: 5 })
  assert.equal(withoutDraft.includes('--num-draft-tokens'), false)

  const withDraft = buildServerArgs({ bindHost: 'h', port: 1, draftModel: 'small', numDraftTokens: 5 })
  assert.deepEqual(withDraft.slice(-4), ['--draft-model', 'small', '--num-draft-tokens', '5'])
})

test('blank extra args do not become empty arguments', () => {
  const args = buildServerArgs({ bindHost: 'h', port: 1, extraArgs: ['--chat-template', 'x', '  ', ''] })
  assert.deepEqual(args.slice(-2), ['--chat-template', 'x'])
})

// ---- JSONC -----------------------------------------------------------------

test('comments are stripped without damaging strings that contain slashes', () => {
  const src = `{
    // a line comment
    "modelsDir": "/Users/me/models", /* trailing block */
    "url": "https://example.com//path",
    "note": "not // a comment",
    /* multi
       line */
    "port": 8080,
  }`
  const parsed = parseJsonc(src)
  assert.deepEqual(parsed, {
    modelsDir: '/Users/me/models',
    url: 'https://example.com//path',
    note: 'not // a comment',
    port: 8080,
  })
})

test('an escaped quote does not end the string early', () => {
  assert.equal(stripJsonComments('{"a":"say \\"hi\\" // no"}'), '{"a":"say \\"hi\\" // no"}')
})

test('unparseable settings yield undefined rather than throwing', () => {
  assert.equal(parseJsonc('{ this is not json'), undefined)
  assert.equal(parseJsonc('[1,2]'), undefined, 'an array is not a settings object')
})

// ---- seeding from VSCode ---------------------------------------------------

test('both the flat and nested forms of VSCode settings are read', () => {
  const flat = extractMlxSettings({
    'mlxConsole.server.port': 8081,
    'editor.fontSize': 14,
    'mlxConsoleOther.x': 1,
  })
  assert.deepEqual(flat, { 'server.port': 8081 })

  const nested = extractMlxSettings({ mlxConsole: { 'server.port': 8082, modelsDir: '/m' } })
  assert.deepEqual(nested, { 'server.port': 8082, modelsDir: '/m' })
})

test('the store layers manifest defaults under the file, and records the source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlx-cfg-'))
  const file = path.join(dir, 'config.json')
  const store = new SettingsStore({ 'server.port': 8080, modelsDir: '' }, file).load({
    'server.port': 8081,
  })

  assert.equal(store.get('server.port'), 8081, 'seeded value wins over the default')
  assert.equal(store.get('modelsDir'), '', 'unset falls through to the manifest default')
  assert.equal(store.sourceOf('server.port'), 'vscode')
  assert.equal(store.sourceOf('modelsDir'), 'default')

  store.set('modelsDir', '/models')
  assert.equal(store.sourceOf('modelsDir'), 'cli')

  // A second run must read the file, not re-seed from VSCode.
  const reopened = new SettingsStore({ 'server.port': 8080 }, file).load({ 'server.port': 9999 })
  assert.equal(reopened.get('server.port'), 8081)
  assert.equal(reopened.get('modelsDir'), '/models')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('the config file is not world-readable, because it can hold a token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlx-cfg-'))
  const file = path.join(dir, 'config.json')
  new SettingsStore({}, file).load({ 'huggingFace.token': 'hf_secret' })
  assert.equal(fs.statSync(file).mode & 0o077, 0, 'no group or other permissions')
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---- locating the editor's files -------------------------------------------

test('an explicit venv wins; otherwise the first one holding the binary', () => {
  const present = '/b/venv/bin/mlx_lm.server'
  assert.equal(
    resolveVenv({ configured: ' /mine ', candidates: ['/a/venv'], exists: () => true }),
    '/mine',
  )
  assert.equal(
    resolveVenv({ candidates: ['/a/venv', '/b/venv'], exists: (p) => p === present }),
    '/b/venv',
  )
  assert.equal(resolveVenv({ candidates: ['/a/venv'], exists: () => false }), undefined)
})

test('forks with their own user directories are searched too', () => {
  const dirs = venvCandidates('/home/me').join('\n')
  for (const editor of ['Code', 'Cursor', 'VSCodium']) {
    assert.ok(dirs.includes(`/${editor}/User/globalStorage/mlx-console.mlx-console-vscode/venv`), editor)
  }
  assert.ok(settingsCandidates('/home/me')[0].endsWith('/Code/User/settings.json'))
})

// ---- launchd ---------------------------------------------------------------

test('the plist is valid XML with absolute paths', () => {
  const xml = buildPlist({ node: '/usr/local/bin/node', script: '/opt/mlx/cli.js', port: 8090, home: '/home/me' })
  assert.ok(xml.startsWith('<?xml'))
  assert.ok(xml.includes(`<string>${LABEL}</string>`))
  assert.ok(xml.includes('<string>/usr/local/bin/node</string>'))
  assert.ok(xml.includes('<string>serve</string>'))
  assert.ok(xml.includes('<string>--port</string>'))
  assert.ok(xml.includes('<string>/home/me/.mlx-console/daemon.log</string>'))
})

test('a deliberate stop is not undone by launchd relaunching it', () => {
  const xml = buildPlist({ node: '/n', script: '/s' })
  assert.match(xml, /<key>SuccessfulExit<\/key>\s*<false\/>/)
})

test('paths with XML-significant characters are escaped', () => {
  assert.equal(xmlEscape('a & b <c> "d"'), 'a &amp; b &lt;c&gt; &quot;d&quot;')
  const xml = buildPlist({ node: '/n', script: '/Users/a&b/cli.js' })
  assert.ok(xml.includes('/Users/a&amp;b/cli.js'))
  assert.equal(xml.includes('/Users/a&b/'), false)
})

test('loading boots out any previous agent first, so install is repeatable', () => {
  const cmds = loadCommands('/p/x.plist', 501)
  assert.deepEqual(cmds[0], ['launchctl', 'bootout', `gui/501/${LABEL}`])
  assert.deepEqual(cmds[1], ['launchctl', 'bootstrap', 'gui/501', '/p/x.plist'])
})

// ---- argument parsing ------------------------------------------------------

test('commands and flags parse in either order', () => {
  assert.equal(parseArgs(['serve']).command, 'serve')
  assert.equal(parseArgs(['serve', '--port', '9000']).port, 9000)
  assert.equal(parseArgs(['--port=9001', 'serve']).port, 9001)
  assert.equal(parseArgs(['status', '--json']).json, true)
  assert.equal(parseArgs(['--help']).help, true)
  assert.equal(parseArgs([]).command, 'help', 'no arguments prints help rather than acting')
})

test('a bad port is ignored rather than becoming NaN', () => {
  assert.equal(parseArgs(['serve', '--port', 'abc']).port, undefined)
  assert.equal(parseArgs(['serve', '--port', '-1']).port, undefined)
})

// ---- the Python helper -----------------------------------------------------

test('the helper script is found beside the CLI in either layout', () => {
  const repo = findHelper('/repo/dist/cli.js', (p) => p === '/repo/resources/py/mlx_console_helper.py')
  assert.equal(repo, '/repo/resources/py/mlx_console_helper.py')

  const nested = findHelper('/ext/out/dist/cli.js', (p) => p === '/ext/out/resources/py/mlx_console_helper.py')
  assert.equal(nested, '/ext/out/resources/py/mlx_console_helper.py')

  assert.equal(findHelper('/nowhere/cli.js', () => false), undefined)
})

test('the last JSON line wins, so helper chatter is ignored', () => {
  assert.deepEqual(lastJsonLine('loading...\n{"ok":true,"models":[]}\n'), { ok: true, models: [] })
  assert.deepEqual(lastJsonLine('  {"ok":false}  '), { ok: false })
})

test('a traceback is reported by its last line, not the whole dump', () => {
  const trace = [
    'Traceback (most recent call last):',
    '  File "helper.py", line 1, in <module>',
    '    scan()',
    'huggingface_hub.errors.CacheNotFound: cache not found',
  ].join('\n')
  assert.equal(pythonError(trace, 1).message, 'huggingface_hub.errors.CacheNotFound: cache not found')
  assert.equal(pythonError('', 2).message, 'helper exited with code 2')
})

// ---- surviving the rename --------------------------------------------------

test('storage moves only into an empty destination', () => {
  const withVenv = new Set(['/new/mlx-console.mlx-console-gui', '/old/legacy'])

  // Nothing to do when the new location is already set up.
  assert.equal(
    planMigration({
      storageDir: '/new/mlx-console.mlx-console-gui',
      legacyDirs: ['/old/legacy'],
      hasVenv: (d) => withVenv.has(d),
    }),
    undefined,
    'an existing install must not be overwritten by an older one',
  )

  assert.deepEqual(
    planMigration({
      storageDir: '/fresh',
      legacyDirs: ['/no-venv', '/old/legacy'],
      hasVenv: (d) => withVenv.has(d),
    }),
    { from: '/old/legacy', to: '/fresh' },
  )

  assert.equal(
    planMigration({ storageDir: '/fresh', legacyDirs: ['/nothing'], hasVenv: () => false }),
    undefined,
    'no venv anywhere means nothing worth moving',
  )
})

test('migration moves entries and never clobbers what is already there', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mlx-migrate-'))
  const from = path.join(root, 'old')
  const to = path.join(root, 'new')
  fs.mkdirSync(path.join(from, 'venv', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(from, 'venv', 'bin', 'python'), '#!/bin/sh\n')
  fs.writeFileSync(path.join(from, 'server-state.json'), '{"port":8080,"updatedAt":0}')
  fs.mkdirSync(to, { recursive: true })
  fs.writeFileSync(path.join(to, 'server-state.json'), '{"port":9999,"updatedAt":1}')

  const result = migrateStorage({ from, to })
  assert.deepEqual(result.moved, ['venv'], 'only what the destination lacked')
  assert.equal(result.error, undefined)
  assert.ok(fs.existsSync(path.join(to, 'venv', 'bin', 'python')), 'the venv came across')
  assert.equal(
    fs.readFileSync(path.join(to, 'server-state.json'), 'utf8'),
    '{"port":9999,"updatedAt":1}',
    'the newer state file was left alone',
  )
  assert.ok(fs.existsSync(path.join(from, 'server-state.json')), 'unmoved files are not deleted')

  // Running again is a no-op: the venv is gone from the old location.
  assert.equal(
    planMigration({
      storageDir: to,
      legacyDirs: [from],
      hasVenv: (d) => fs.existsSync(path.join(d, 'venv')),
    }),
    undefined,
  )
  fs.rmSync(root, { recursive: true, force: true })
})

test('a failed move reports the old venv rather than destroying anything', () => {
  const result = migrateStorage(
    { from: '/does/not/exist', to: '/also/not' },
    {
      mkdirSync: () => undefined,
      readdirSync: () => {
        throw new Error('EACCES')
      },
    } as never,
  )
  assert.deepEqual(result.moved, [])
  assert.equal(result.fallbackVenv, '/does/not/exist/venv')
  assert.match(result.error ?? '', /EACCES/)
})

test('both the current and previous storage ids are searched', () => {
  const dirs = venvCandidates('/home/me')
  assert.ok(dirs.some((d) => d.includes('mlx-console.mlx-console-gui')), 'current id')
  assert.ok(dirs.some((d) => d.includes('mlx-console.mlx-console-vscode')), 'previous id')
  assert.ok(
    dirs.indexOf(dirs.find((d) => d.includes('gui'))!) <
      dirs.indexOf(dirs.find((d) => d.includes('vscode'))!),
    'the current id is preferred',
  )
})

// ---- finding the files that ship beside the CLI ----------------------------

test('the CLI resolves through the symlink npm install creates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mlx-self-'))
  const dist = path.join(root, 'pkg', 'dist')
  fs.mkdirSync(path.join(dist, 'webview'), { recursive: true })
  fs.writeFileSync(path.join(dist, 'cli.js'), '')
  fs.writeFileSync(path.join(dist, 'webview', 'main.js'), '')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  const link = path.join(bin, 'mlx-console')
  fs.symlinkSync(path.join(dist, 'cli.js'), link)

  // The bug: the symlink's own directory holds none of the files we ship.
  assert.equal(findBundle(link, (p) => fs.existsSync(p)), undefined, 'unresolved path finds nothing')
  assert.equal(
    findBundle(selfPath(link), (p) => fs.existsSync(p)),
    // realpath also resolves /var -> /private/var on macOS, so compare like
    // with like rather than against the path we happened to construct.
    fs.realpathSync(path.join(dist, 'webview', 'main.js')),
    'resolving the symlink finds the panel bundle',
  )
  fs.rmSync(root, { recursive: true, force: true })
})

test('selfPath survives a path that does not exist', () => {
  assert.equal(selfPath('/no/such/cli.js'), '/no/such/cli.js')
})

test('the bundle is looked for in both shipped layouts', () => {
  assert.deepEqual(bundleCandidates('/x/dist/cli.js'), ['/x/dist/webview/main.js'])
  assert.deepEqual(bundleCandidates('/x/bin/cli.js'), [
    '/x/bin/webview/main.js',
    '/x/dist/webview/main.js',
  ])
})

// ---- stopping everything ---------------------------------------------------

test('pgrep output yields pids, never our own', () => {
  assert.deepEqual(parsePgrepPids('4821\n4900\n', 999), [4821, 4900])

  // Killing ourselves mid-shutdown would strand the very processes we are
  // trying to clean up.
  assert.deepEqual(parsePgrepPids('4821\n999\n4900\n', 999), [4821, 4900])

  assert.deepEqual(parsePgrepPids('', 999), [], 'nothing running')
  assert.deepEqual(parsePgrepPids('\n  \n', 999), [], 'blank lines are not pids')
  assert.deepEqual(parsePgrepPids('not-a-pid\n7\n', 999), [7], 'junk is skipped')
})
