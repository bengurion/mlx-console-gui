import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MemoryObserver,
  recommendPrefillStepSize,
  MIN_OBSERVATIONS,
  MAX_OBSERVATIONS,
} from '../src/services/memoryObserver.ts'

const MB = 1024 ** 2
const GB = 1024 ** 3

/** Synthetic requests costing `perToken` bytes each plus a fixed overhead. */
function feed(o: MemoryObserver, model: string, perToken: number, fixed: number, sizes: number[]) {
  for (const n of sizes) {
    o.record(model, {
      promptTokens: n,
      baselineBytes: 70 * GB,
      peakBytes: 70 * GB + fixed + perToken * n,
    })
  }
}

test('no estimate until enough requests are observed', () => {
  const o = new MemoryObserver()
  feed(o, 'm', 4096, 200 * MB, [1000, 2000])
  const e = o.estimate('m')
  assert.equal(e.usable, false)
  assert.equal(e.samples, 2)
  assert.match(e.reason, new RegExp(`2/${MIN_OBSERVATIONS}`))
})

test('recovers the per-token cost from clean observations', () => {
  const o = new MemoryObserver()
  feed(o, 'm', 4096, 200 * MB, [1000, 2000, 4000, 8000])
  const e = o.estimate('m')
  assert.equal(e.usable, true)
  // 4 KiB/token, recovered by least squares.
  assert.ok(Math.abs(e.bytesPerToken! - 4096) < 1)
  assert.ok(Math.abs(e.fixedBytes! - 200 * MB) < MB)
})

test('identical prompt sizes cannot identify a slope', () => {
  const o = new MemoryObserver()
  feed(o, 'm', 4096, 0, [2000, 2000, 2000, 2000])
  const e = o.estimate('m')
  assert.equal(e.usable, false)
  assert.match(e.reason, /same size/i)
})

test('memory freed during a request is not recorded as a cost', () => {
  const o = new MemoryObserver()
  o.record('m', { promptTokens: 1000, baselineBytes: 70 * GB, peakBytes: 69 * GB })
  o.record('m', { promptTokens: 0, baselineBytes: 70 * GB, peakBytes: 71 * GB })
  assert.equal(o.observations('m').length, 0, 'both samples are meaningless')
})

test('a downward trend is reported as noise, not a negative cost', () => {
  const o = new MemoryObserver()
  // Larger prompts happening to show smaller deltas — other GPU activity.
  o.record('m', { promptTokens: 1000, baselineBytes: 70 * GB, peakBytes: 70 * GB + 900 * MB })
  o.record('m', { promptTokens: 4000, baselineBytes: 70 * GB, peakBytes: 70 * GB + 500 * MB })
  o.record('m', { promptTokens: 8000, baselineBytes: 70 * GB, peakBytes: 70 * GB + 100 * MB })
  const e = o.estimate('m')
  assert.equal(e.usable, false)
  assert.equal(e.bytesPerToken, undefined, 'never emit a negative per-token cost')
  assert.match(e.reason, /noisy/i)
})

test('history stays bounded so the estimate tracks the current model', () => {
  const o = new MemoryObserver()
  feed(o, 'm', 4096, 0, Array.from({ length: MAX_OBSERVATIONS + 10 }, (_, i) => 1000 + i * 100))
  assert.equal(o.observations('m').length, MAX_OBSERVATIONS)
})

test('observations are kept per model', () => {
  const o = new MemoryObserver()
  feed(o, 'a', 4096, 0, [1000, 2000, 3000])
  feed(o, 'b', 8192, 0, [1000, 2000, 3000])
  assert.ok(Math.abs(o.estimate('a').bytesPerToken! - 4096) < 1)
  assert.ok(Math.abs(o.estimate('b').bytesPerToken! - 8192) < 1)
  o.reset('a')
  assert.equal(o.estimate('a').usable, false)
  assert.equal(o.estimate('b').usable, true)
})

test('prefill step size is sized from the measurement and rounded down', () => {
  const o = new MemoryObserver()
  feed(o, 'm', 1 * MB, 0, [1000, 2000, 4000])
  const r = recommendPrefillStepSize({
    estimate: o.estimate('m'),
    headroomBytes: 37 * GB,
  })
  // 25% of 37 GB at 1 MiB/token ~= 9472 tokens -> rounded down to 8192.
  assert.equal(r.recommended, 8192)
  assert.match(r.reason, /per prompt token/i)
})

test('prefill recommendation waits for a usable measurement', () => {
  const o = new MemoryObserver()
  const r = recommendPrefillStepSize({ estimate: o.estimate('m'), headroomBytes: 37 * GB })
  assert.equal(r.recommended, undefined)
  assert.match(r.reason, /Measuring/i)
})

test('KV growth is removed so the slope is transient cost alone', () => {
  const o = new MemoryObserver()
  const kv = 72 * 1024 // KiB/token of KV, known from config
  const transient = 1 * MB
  for (const n of [1000, 2000, 4000]) {
    o.record('m', {
      promptTokens: n,
      baselineBytes: 70 * GB,
      // Observed delta contains BOTH costs.
      peakBytes: 70 * GB + (kv + transient) * n,
      kvBytesPerToken: kv,
    })
  }
  const e = o.estimate('m')
  assert.equal(e.usable, true)
  // Without subtracting KV the slope would be ~1.07 MB, not 1 MB.
  assert.ok(
    Math.abs(e.bytesPerToken! - transient) < 1,
    `expected ~${transient}, got ${e.bytesPerToken}`,
  )
})

test('a request whose entire delta is KV yields no transient cost', () => {
  const o = new MemoryObserver()
  const kv = 72 * 1024
  for (const n of [1000, 2000, 4000]) {
    o.record('m', {
      promptTokens: n,
      baselineBytes: 70 * GB,
      peakBytes: 70 * GB + kv * n,
      kvBytesPerToken: kv,
    })
  }
  const e = o.estimate('m')
  assert.equal(e.usable, false, 'zero slope is not a usable measurement')
})
