/**
 * Converting a Hugging Face repo to MLX.
 *
 * The interesting parts are the ones a user never sees until they go wrong:
 * that the plan is data rather than an editor menu (the browser dashboard has
 * no quick pick, so a menu was the same as a dead button), and that a canceled
 * conversion does not leave a half-written model directory behind for mlx-lm
 * to find and fail on.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { ConvertManager } from '../src/services/convertManager.ts'
import { setSettingsSource } from '../src/core/settings.ts'
import type { ConvertItem } from '../src/shared/protocol.ts'

/** A stand-in for mlx_lm.convert that the test drives by hand. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed: NodeJS.Signals | undefined
  kill(signal?: NodeJS.Signals) {
    this.killed = signal
    return true
  }
}

function harness(opts: { modelsDir?: string; ready?: boolean; downloadFails?: string } = {}) {
  setSettingsSource({
    get: <T>(key: string, fallback: T) => (key === 'modelsDir' ? ((opts.modelsDir ?? '') as T) : fallback),
    isExplicit: () => false,
    update: async () => {},
  })
  const spawned: { bin: string; args: string[] }[] = []
  const downloaded: string[] = []
  let child: FakeChild | undefined
  const convert = new ConvertManager(
    {
      ensureReady: async () => opts.ready ?? true,
      binPath: (name) => `/venv/bin/${name}`,
    },
    {
      download: async (repo, onProgress) => {
        downloaded.push(repo)
        if (opts.downloadFails) throw new Error(opts.downloadFails)
        onProgress({ downloaded: 5, total: 10, file: 'model.safetensors' })
      },
    },
    (bin, args) => {
      spawned.push({ bin, args })
      child = new FakeChild()
      return child as unknown as ChildProcess
    },
  )
  return { convert, spawned, downloaded, child: () => child! }
}

test('the quantization choices are data, not a menu', () => {
  const { convert } = harness()
  const plan = convert.plan('Qwen/Qwen2.5-Coder-7B-Instruct')

  assert.equal(plan.paramsB, 7)
  assert.deepEqual(
    plan.options.map((o) => o.bits),
    [16, 8, 6, 5, 4, 3, 2],
  )
  const recommended = plan.options.filter((o) => o.recommended)
  assert.equal(recommended.length, 1, 'exactly one is recommended')
  assert.notEqual(recommended[0].bits, 16, 'bf16 is offered, never recommended')
  // Every option carries enough to render without a second round trip.
  for (const o of plan.options) {
    assert.ok(o.summary.length > 0)
    assert.ok(o.detail.length > 0)
  }
})

test('a repo that cannot be converted says so instead of offering choices', () => {
  const { convert } = harness()
  const plan = convert.plan('TheBloke/Llama-2-7B-GGUF')
  assert.deepEqual(plan.options, [])
  assert.match(plan.error ?? '', /GGUF/)
})

test('a model too big even at 2-bit is still convertible, with a warning', () => {
  const { convert } = harness()
  const plan = convert.plan('meta-llama/Llama-3.1-4000B') // absurd on purpose
  assert.equal(plan.options.length, 7, 'the choices remain; it is the machine that is small')
  assert.match(plan.error ?? '', /does not fit/)
  assert.equal(
    plan.options.some((o) => o.recommended),
    false,
    'nothing can be recommended',
  )
})

test('an unknown parameter count offers every width rather than refusing', () => {
  const { convert } = harness()
  const plan = convert.plan('some-org/mystery-model')
  assert.equal(plan.paramsB, undefined)
  assert.equal(plan.options.length, 7)
  assert.equal(plan.error, undefined)
})

test("the Hub's exact parameter count beats the repo-name guess", () => {
  const { convert } = harness()
  // A name that says nothing about size, sized by safetensors.total instead.
  const plan = convert.plan('some-org/mystery-model', 7.615616512)
  assert.equal(plan.paramsB, 7.62, 'rounded for display, not shown raw')
  for (const o of plan.options) {
    assert.ok(o.estBytes, `${o.bits}-bit has a size estimate`)
    assert.notEqual(o.summary, 'size unknown')
  }
})

test('conversion runs mlx_lm.convert and reports progress from its output', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlx-convert-'))
  const { convert, spawned, downloaded, child } = harness({ modelsDir: dir })
  const seen: ConvertItem[][] = []
  convert.onDidChange((items) => seen.push(items))

  const res = await convert.start('Qwen/Qwen2.5-Coder-7B-Instruct', 4)
  assert.deepEqual(res, { ok: true })

  // The full snapshot has to land first: mlx_lm.convert fetches only weights
  // and configs, then refuses to save because the snapshot is incomplete.
  assert.deepEqual(downloaded, ['Qwen/Qwen2.5-Coder-7B-Instruct'])

  assert.equal(spawned[0].bin, '/venv/bin/mlx_lm.convert')
  assert.deepEqual(spawned[0].args, [
    '--hf-path',
    'Qwen/Qwen2.5-Coder-7B-Instruct',
    '--mlx-path',
    path.join(dir, 'mlx-converted', 'Qwen2.5-Coder-7B-Instruct-4bit'),
    '-q',
    '--q-bits',
    '4',
    '--q-group-size',
    '64',
  ])

  // tqdm redraws one line with \r, so the percentage is in the last fragment.
  child().stderr.emit('data', Buffer.from('Fetching 12 files:   0%|  | 0/12\rFetching 12 files:  50%|# | 6/12'))
  const mid = convert.list()[0]
  assert.equal(mid.progress, 0.5)
  assert.match(mid.message ?? '', /50%/)

  child().emit('close', 0, null)
  const done = convert.list()[0]
  assert.equal(done.state, 'done')
  assert.equal(done.progress, 1)
  assert.ok(seen.length > 2, 'the UI was told each time something changed')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('bf16 converts without quantizing and names the output accordingly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlx-convert-'))
  const { convert, spawned } = harness({ modelsDir: dir })

  const res = await convert.start('Qwen/Qwen2.5-7B', 16)
  assert.deepEqual(res, { ok: true })
  assert.deepEqual(spawned[0].args, [
    '--hf-path',
    'Qwen/Qwen2.5-7B',
    '--mlx-path',
    path.join(dir, 'mlx-converted', 'Qwen2.5-7B-bf16'),
    '--dtype',
    'bfloat16',
  ])

  fs.rmSync(dir, { recursive: true, force: true })
})

test('canceling removes the half-written model directory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlx-convert-'))
  const { convert, child } = harness({ modelsDir: dir })
  await convert.start('Qwen/Qwen2.5-7B', 4)

  const outPath = path.join(dir, 'mlx-converted', 'Qwen2.5-7B-4bit')
  fs.mkdirSync(outPath, { recursive: true })
  fs.writeFileSync(path.join(outPath, 'model-00001-of-00002.safetensors'), 'partial')

  convert.cancel('Qwen/Qwen2.5-7B')
  assert.equal(child().killed, 'SIGTERM')
  child().emit('close', null, 'SIGTERM')

  assert.equal(convert.list()[0].state, 'canceled')
  // Left behind, mlx-lm would find this directory and fail on a missing shard.
  assert.equal(fs.existsSync(outPath), false)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('a failed conversion keeps the last thing the tool said', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlx-convert-'))
  const { convert, child } = harness({ modelsDir: dir })
  await convert.start('Qwen/Qwen2.5-7B', 4)

  child().stderr.emit('data', Buffer.from('ValueError: No safetensors found in Qwen/Qwen2.5-7B'))
  child().emit('close', 1, null)

  const item = convert.list()[0]
  assert.equal(item.state, 'error')
  assert.match(item.message ?? '', /exited with code 1/)
  assert.match(item.message ?? '', /No safetensors found/, 'the actual reason survives')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('an existing output is refused rather than overwritten', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlx-convert-'))
  const { convert, spawned } = harness({ modelsDir: dir })
  fs.mkdirSync(path.join(dir, 'mlx-converted', 'Qwen2.5-7B-4bit'), { recursive: true })

  const res = await convert.start('Qwen/Qwen2.5-7B', 4)
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /already exists/)
  assert.equal(spawned.length, 0, 'nothing was started')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('an unready environment fails before the hour-long download, not after', async () => {
  const { convert, spawned } = harness({ ready: false })
  const res = await convert.start('Qwen/Qwen2.5-7B', 4)
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /environment/)
  assert.equal(spawned.length, 0)
})

test('the source repo is downloaded in full before converting', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlx-convert-'))
  const { convert, spawned, downloaded } = harness({
    modelsDir: dir,
    downloadFails: 'network is down',
  })

  const res = await convert.start('Qwen/Qwen2.5-7B', 4)
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /network is down/)
  assert.deepEqual(downloaded, ['Qwen/Qwen2.5-7B'])
  // Converting anyway would quantize for an hour and then throw the result
  // away with IncompleteSnapshotError.
  assert.equal(spawned.length, 0)
  assert.equal(convert.list()[0].state, 'error')

  fs.rmSync(dir, { recursive: true, force: true })
})
