/**
 * Loading a model, and the status the UI reads off it.
 *
 * Worth testing rather than clicking: a real load is minutes long, and the bug
 * these cover was invisible precisely because of that — the status stayed
 * "nothing loaded" for the whole time, so every view kept offering a Launch
 * button that queued another load of the same weights.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ServerManager } from '../src/backend/serverManager.ts'
import { setSettingsSource } from '../src/core/settings.ts'

setSettingsSource({ get: (_k, f) => f, isExplicit: () => false, update: async () => {} })

/**
 * A manager whose server is already up and whose chat call we control.
 * `ensureRunning` and the client are the only outside world warmUp touches.
 */
function managerWith(chat: () => Promise<unknown>) {
  const mgr = new ServerManager({ ensureReady: async () => true } as never)
  const calls: string[] = []
  Object.assign(mgr, { client: { chat: (p: { model: string }) => (calls.push(p.model), chat()) } })
  mgr.ensureRunning = async () => true
  return { mgr, calls }
}

test('a load announces itself before the request and confirms after', async () => {
  const states: string[] = []
  let release: (() => void) | undefined
  const { mgr } = managerWith(() => new Promise<void>((r) => (release = r)))
  mgr.onDidChange((s) => states.push(s.modelState))

  const load = mgr.warmUp('org/model')
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(mgr.modelState, 'loading', 'the UI must see loading while it loads')
  assert.equal(mgr.loadedModel, undefined)

  release?.()
  assert.equal(await load, true)
  assert.equal(mgr.modelState, 'loaded')
  assert.equal(mgr.loadedModel, 'org/model')
  // The first event is the active-model change, which still reports the old
  // residency; what matters is that loading and loaded both reach the UI in
  // order, and that it does not sit on 'none' for the length of the load.
  assert.deepEqual(
    states.filter((s, i) => s !== states[i - 1]).slice(-2),
    ['loading', 'loaded'],
    'both transitions are broadcast, in order',
  )
})

test('a launch verifies residency instead of trusting the cache', async () => {
  /*
   * The cache can lie: an API client can displace the model behind the
   * console's back, and trusting "already loaded" once turned Launch into a
   * silent no-op while 40 GB of the wrong model sat resident. The server does
   * not re-read weights for a model it already has, so verification costs one
   * token — and the UI must not flicker through 'loading' when the cache was
   * right, because beginModelUse/confirmModelLoaded both no-op on a match.
   */
  const { mgr, calls } = managerWith(async () => undefined)
  assert.equal(await mgr.warmUp('org/model'), true)
  assert.equal(calls.length, 1)

  const states: string[] = []
  mgr.onDidChange((s) => states.push(s.modelState))
  assert.equal(await mgr.warmUp('org/model'), true, 'still reports success')
  assert.equal(calls.length, 2, 'verified with a request rather than assumed')
  assert.ok(!states.includes('loading'), 'no loading flicker when it was truly resident')
})

test('a published record carries a pid even for a server we never spawned', async () => {
  /*
   * The pid is what memory attribution hangs off: metrics read that process's
   * RSS, and without it an idle model's 50 GB shows under "other apps" while
   * "model" reads whatever the GPU happens to have mapped (~1 GB). A load
   * confirmed via the proxy for an adopted server must resolve the pid from
   * the port before publishing.
   */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlx-state-'))
  const file = path.join(dir, 'server-state.json')
  const { mgr } = managerWith(async () => undefined)
  // A live pid: the liveness check clears records whose pid is gone, which is
  // right — and exactly what a made-up test pid would trip over.
  mgr.portHolder = async () => process.pid
  mgr.useSharedState(file)

  try {
    assert.equal(await mgr.warmUp('org/model'), true)
    // publishSharedState is fire-and-forget off the confirm; give it a beat.
    await new Promise((r) => setTimeout(r, 50))
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number; loadedModel?: string }
    assert.equal(state.loadedModel, 'org/model')
    assert.equal(state.pid, process.pid, 'pid resolved from the port holder')
  } finally {
    mgr.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('remote mode asks the daemon to start the server, never spawns', async () => {
  /*
   * A thin-client window spawning its own server builds the command line from
   * the editor's settings — which in remote mode are not the configuration.
   * That is how a chat request once started a bare-flag server (no prompt
   * cache bound, no concurrency limit) behind the app's back.
   */
  const mgr = new ServerManager({ ensureReady: async () => assert.fail('env must not be touched') } as never)
  let up = false
  let asked = 0
  Object.assign(mgr, { client: { ping: async () => up, chat: async () => undefined } })
  mgr.remoteStarter = async () => {
    asked += 1
    up = true
    return true
  }

  assert.equal(await mgr.ensureRunning(), true)
  assert.equal(asked, 1, 'the daemon was asked')
  assert.equal(mgr.state, 'ready')

  assert.equal(await mgr.ensureRunning(), true)
  assert.equal(asked, 1, 'an answering server is adopted, not restarted')
})

test('impatient clicks join the load in flight instead of queueing more', async () => {
  let release: (() => void) | undefined
  const { mgr, calls } = managerWith(() => new Promise<void>((r) => (release = r)))

  const loads = [mgr.warmUp('org/model'), mgr.warmUp('org/model'), mgr.warmUp('org/model')]
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(calls.length, 1, 'one request, however many clicks')

  release?.()
  assert.deepEqual(await Promise.all(loads), [true, true, true], 'every caller gets the result')
})

test('a failed load does not leave the UI stuck on "loading"', async () => {
  const { mgr } = managerWith(async () => {
    throw new Error('server said no')
  })

  assert.equal(await mgr.warmUp('org/model'), false)
  assert.equal(mgr.modelState, 'none', 'back to a state the UI can act on')
  assert.equal(mgr.loadedModel, undefined)
})

test('switching models reports the new one as loading, not the old one', async () => {
  let release: (() => void) | undefined
  const { mgr } = managerWith(async () => undefined)
  await mgr.warmUp('org/first')
  assert.equal(mgr.loadedModel, 'org/first')

  Object.assign(mgr, {
    client: { chat: () => new Promise<void>((r) => (release = r)) },
  })
  const load = mgr.warmUp('org/second')
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(mgr.modelState, 'loading')
  assert.equal(mgr.loadedModel, undefined, 'the old weights are gone the moment the switch starts')
  assert.equal(mgr.activeModel, 'org/second')

  release?.()
  await load
  assert.equal(mgr.loadedModel, 'org/second')
})

test('stopping mid-load leaves the UI in a state it can act on', async () => {
  // The case behind making Stop always clickable: a load that will take
  // minutes, interrupted on purpose. Killing the server makes the in-flight
  // request fail, and that failure must clear "loading" — otherwise every
  // button stays disabled against a load that is never coming back.
  let fail: ((e: Error) => void) | undefined
  const { mgr } = managerWith(() => new Promise<void>((_, reject) => (fail = reject)))

  const load = mgr.warmUp('org/model')
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(mgr.modelState, 'loading')

  // What a killed server does to a request in flight.
  fail?.(new Error('socket hang up'))
  assert.equal(await load, false)

  assert.equal(mgr.modelState, 'none', 'not stuck on loading')
  assert.equal(mgr.loadedModel, undefined)

  // And the next attempt is a fresh one, not a join onto the dead promise.
  Object.assign(mgr, { client: { chat: async () => undefined } })
  assert.equal(await mgr.warmUp('org/model'), true)
  assert.equal(mgr.modelState, 'loaded')
})
