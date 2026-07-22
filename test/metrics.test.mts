import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseVmStat,
  parseIoregGpu,
  parseDeviceInfo,
  parseWiredLimit,
  cpuSample,
  cpuPercent,
  parsePs,
  recommendPromptCacheBytes,
  MAX_PROMPT_CACHE,
} from '../src/services/metrics.ts'

// Captured from an M5 Max (page size 16384, not the 4096 many parsers assume).
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   595057.
Pages active:                                1064883.
Pages inactive:                              1941658.
Pages speculative:                              6526.
Pages throttled:                                   0.
Pages wired down:                            4654645.
Pages purgeable:                               22135.
Pages occupied by compressor:                  63603.
`

const IOREG = `"PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=143233236992,"Tiler Utilization %"=13,"Renderer Utilization %"=43,"Device Utilization %"=96,"In use system memory"=72686583808}`

test('parseVmStat uses the reported page size', () => {
  const total = 137438953472
  const m = parseVmStat(VM_STAT, total)!
  assert.equal(m.wiredBytes, 4654645 * 16384)
  assert.equal(m.activeBytes, 1064883 * 16384)
  // "occupied by compressor", not "stored in compressor".
  assert.equal(m.compressedBytes, 63603 * 16384)
  assert.equal(m.usedBytes, m.wiredBytes + m.activeBytes + m.compressedBytes)
  assert.ok(m.usedBytes < total)
})

test('parseVmStat rejects output without a page size', () => {
  assert.equal(parseVmStat('garbage', 1024), undefined)
})

test('parseIoregGpu pulls utilization and memory', () => {
  const g = parseIoregGpu(IOREG)
  assert.equal(g.utilizationPercent, 96)
  assert.equal(g.inUseBytes, 72686583808)
  assert.equal(g.allocatedBytes, 143233236992)
  assert.equal(g.rendererPercent, 43)
  assert.equal(g.tilerPercent, 13)
})

test('parseIoregGpu degrades to undefined fields, not a throw', () => {
  const g = parseIoregGpu('')
  assert.equal(g.utilizationPercent, undefined)
  assert.equal(g.inUseBytes, undefined)
})

test('parseDeviceInfo reads the real allocation ceiling', () => {
  const info = parseDeviceInfo(
    JSON.stringify({
      device_name: 'Apple M5 Max',
      max_recommended_working_set_size: 115448725504,
      memory_size: 137438953472,
      architecture: 'applegpu_g17s',
      max_buffer_length: 86586540032,
    }),
  )!
  assert.equal(info.deviceName, 'Apple M5 Max')
  assert.equal(info.maxRecommendedWorkingSetBytes, 115448725504)
  assert.equal(info.maxBufferBytes, 86586540032)
  // The ceiling is well below total memory — the point of surfacing it.
  assert.ok(info.maxRecommendedWorkingSetBytes! < info.memoryBytes!)
})

test('parseDeviceInfo survives non-JSON', () => {
  assert.equal(parseDeviceInfo('Traceback ...'), undefined)
})

test('parseWiredLimit treats 0 as "no explicit limit"', () => {
  assert.equal(parseWiredLimit('iogpu.wired_limit_mb: 0'), undefined)
  assert.equal(parseWiredLimit('iogpu.wired_limit_mb: 4096'), 4096 * 1024 * 1024)
  assert.equal(parseWiredLimit('nope'), undefined)
})

test('cpuPercent needs two samples and clamps', () => {
  const a = cpuSample([{ times: { user: 100, nice: 0, sys: 0, idle: 900, irq: 0 } }])
  const b = cpuSample([{ times: { user: 200, nice: 0, sys: 0, idle: 1800, irq: 0 } }])
  assert.equal(cpuPercent(undefined, a), undefined, 'first sample has no baseline')
  // 100 busy of 1000 elapsed = 10%
  assert.equal(cpuPercent(a, b), 10)
  assert.equal(cpuPercent(b, b), undefined, 'no elapsed time')
})

test('parsePs converts RSS from KiB', () => {
  assert.deepEqual(parsePs(' 54816192  92.0\n'), {
    rssBytes: 54816192 * 1024,
    cpuPercent: 92,
  })
  assert.equal(parsePs(''), undefined)
})

test('recommendPromptCacheBytes offers half the free headroom', () => {
  const GB = 1024 ** 3
  const ceiling = 107.5 * GB
  // Idle: no model resident, so nearly the whole ceiling is headroom.
  const idle = recommendPromptCacheBytes({ ceilingBytes: ceiling, gpuInUseBytes: 2 * GB })
  assert.ok(idle.recommendedBytes !== undefined)
  assert.ok(idle.recommendedBytes! <= MAX_PROMPT_CACHE, 'capped')

  // A 70 GB model resident leaves real but bounded headroom.
  const loaded = recommendPromptCacheBytes({ ceilingBytes: ceiling, gpuInUseBytes: 70 * GB })
  assert.ok(loaded.recommendedBytes! < idle.recommendedBytes!, 'less room when loaded')
  assert.equal(loaded.headroomBytes, ceiling - 70 * GB)
})

test('recommendPromptCacheBytes declines when headroom is exhausted', () => {
  const GB = 1024 ** 3
  const r = recommendPromptCacheBytes({ ceilingBytes: 107.5 * GB, gpuInUseBytes: 106 * GB })
  assert.equal(r.recommendedBytes, undefined, 'no recommendation without room')
  assert.match(r.reason, /headroom/i)
})

test('recommendPromptCacheBytes needs a ceiling', () => {
  const r = recommendPromptCacheBytes({ ceilingBytes: undefined, gpuInUseBytes: 1 })
  assert.equal(r.recommendedBytes, undefined)
  assert.match(r.reason, /ceiling unknown/i)
})
