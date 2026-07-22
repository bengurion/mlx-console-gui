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

test('loading a model that is already resident does not re-read it', async () => {
  const { mgr, calls } = managerWith(async () => undefined)
  assert.equal(await mgr.warmUp('org/model'), true)
  assert.equal(calls.length, 1)

  assert.equal(await mgr.warmUp('org/model'), true, 'still reports success')
  assert.equal(calls.length, 1, 'minutes of work avoided by not asking again')
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
