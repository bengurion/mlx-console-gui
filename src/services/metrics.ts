/**
 * Pure parsers for macOS system metrics. No VSCode / Node-process dependencies,
 * so these are unit-testable against captured command output.
 *
 * Sources (all readable without sudo on Apple Silicon):
 *  - `vm_stat`                              page-level memory breakdown
 *  - `ioreg -r -d 1 -w 0 -c IOAccelerator`  GPU utilization + GPU-side memory
 *  - `os.cpus()` deltas                     CPU busy percentage
 *  - `ps -o rss=,%cpu=`                     the server process itself
 *
 * `powermetrics` would give richer GPU/ANE detail but requires root, so it is
 * deliberately not used.
 */

export interface MemoryStats {
  totalBytes: number
  /** Resident and non-evictable — this is where model weights land. */
  wiredBytes: number
  activeBytes: number
  compressedBytes: number
  freeBytes: number
  /** Wired + active + compressed, i.e. genuinely committed. */
  usedBytes: number
}

/**
 * Swap and compressor activity — the honest measure of local impact.
 *
 * Utilisation says how hard the machine is working; this says whether it is
 * *suffering*. Wired GPU memory cannot be paged out, so an oversized model
 * does not fail — it squeezes everything else until macOS starts compressing
 * and then swapping. Sustained swap-outs while a model is resident is the
 * signal that you took more than the machine had.
 */
export interface SwapStats {
  totalBytes: number
  usedBytes: number
  freeBytes: number
}

/** Cumulative paging counters, in pages, as vm_stat reports them. */
export interface PagingCounters {
  pageIns: number
  pageOuts: number
  swapIns: number
  swapOuts: number
  pageSize: number
}

/**
 * `sysctl vm.swapusage` reports megabytes with an M suffix:
 *   vm.swapusage: total = 3072.00M  used = 1803.31M  free = 1268.69M
 */
export function parseSwapUsage(output: string): SwapStats | undefined {
  const mb = (label: string): number | undefined => {
    const m = output.match(new RegExp(`${label}\\s*=\\s*([\\d.]+)([KMG])`, 'i'))
    if (!m) return undefined
    const scale = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()] ?? 1
    // sysctl reports two decimal places of megabytes; whole bytes is the unit
    // every consumer expects, and a fractional byte reads as a bug.
    return Math.round(Number(m[1]) * scale)
  }
  const totalBytes = mb('total')
  const usedBytes = mb('used')
  const freeBytes = mb('free')
  if (totalBytes === undefined || usedBytes === undefined) return undefined
  return { totalBytes, usedBytes, freeBytes: freeBytes ?? Math.max(0, totalBytes - usedBytes) }
}

/** Cumulative paging counters from the same vm_stat output. */
export function parsePagingCounters(output: string): PagingCounters | undefined {
  const pageSize = Number(output.match(/page size of (\d+) bytes/)?.[1])
  if (!Number.isFinite(pageSize) || pageSize <= 0) return undefined
  const count = (label: string): number => {
    const m = output.match(new RegExp(`${label}:\\s+(\\d+)\\.`, 'i'))
    return m ? Number(m[1]) : 0
  }
  return {
    pageIns: count('Pageins'),
    pageOuts: count('Pageouts'),
    swapIns: count('Swapins'),
    swapOuts: count('Swapouts'),
    pageSize,
  }
}

/**
 * Bytes per second between two cumulative readings.
 *
 * Returns undefined rather than 0 when there is no previous sample or the
 * counters went backwards (a reboot), so the UI can say "measuring" instead of
 * claiming a calm machine it has not observed.
 */
export function pagingRates(
  prev: PagingCounters | undefined,
  next: PagingCounters,
  elapsedMs: number,
): { swapOutBytesPerSec?: number; swapInBytesPerSec?: number; pageOutBytesPerSec?: number } {
  if (!prev || elapsedMs <= 0) return {}
  const perSec = (a: number, b: number) =>
    b < a ? undefined : ((b - a) * next.pageSize) / (elapsedMs / 1000)
  return {
    swapOutBytesPerSec: perSec(prev.swapOuts, next.swapOuts),
    swapInBytesPerSec: perSec(prev.swapIns, next.swapIns),
    pageOutBytesPerSec: perSec(prev.pageOuts, next.pageOuts),
  }
}

export interface GpuStats {
  /** 0-100. Overall device utilization as reported by the accelerator. */
  utilizationPercent?: number
  /** Bytes the GPU driver currently has mapped — tracks the loaded model. */
  inUseBytes?: number
  /**
   * `Alloc system memory`: GPU address space, not resident pages.
   *
   * Routinely larger than installed RAM, which is not an error — it counts
   * allocations that are mapped but not backed, the same pages once per client
   * that maps them, and purgeable ranges the kernel has already reclaimed.
   * Never treat this as a memory footprint; `inUseBytes` is the physical one.
   */
  allocatedBytes?: number
  /** Rasterizer/geometry utilization; mostly idle for pure compute workloads. */
  rendererPercent?: number
  tilerPercent?: number
}

/**
 * Static GPU capabilities from `mx.device_info()`.
 *
 * `maxRecommendedWorkingSetBytes` is the real ceiling Metal will let a process
 * allocate — on a 128 GB M5 Max it is ~107.5 GB, not the 75%-of-RAM heuristic
 * used for fit estimates elsewhere.
 */
export interface GpuDeviceInfo {
  deviceName?: string
  architecture?: string
  /** Total unified memory visible to the GPU. */
  memoryBytes?: number
  maxRecommendedWorkingSetBytes?: number
  /** Largest single allocation; a model with one huge tensor can hit this. */
  maxBufferBytes?: number
}

/** Parse the JSON emitted by `mx.device_info()`. */
export function parseDeviceInfo(json: string): GpuDeviceInfo | undefined {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(json) as Record<string, unknown>
  } catch {
    return undefined
  }
  const num = (k: string): number | undefined => {
    const v = raw[k]
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
  }
  const str = (k: string): string | undefined => {
    const v = raw[k]
    return typeof v === 'string' ? v : undefined
  }
  return {
    deviceName: str('device_name'),
    architecture: str('architecture'),
    memoryBytes: num('memory_size'),
    maxRecommendedWorkingSetBytes: num('max_recommended_working_set_size'),
    maxBufferBytes: num('max_buffer_length'),
  }
}

/**
 * `iogpu.wired_limit_mb` caps GPU-wired memory. 0 means "system default",
 * which is where the recommended working set above comes from.
 */
export function parseWiredLimit(sysctlOutput: string): number | undefined {
  const m = sysctlOutput.match(/iogpu\.wired_limit_mb:\s*(\d+)/)
  if (!m) return undefined
  const mb = Number(m[1])
  return mb > 0 ? mb * 1024 * 1024 : undefined
}

export interface CpuSample {
  idle: number
  total: number
}

/**
 * Parse `vm_stat`. The header declares the page size, which is 16384 on Apple
 * Silicon rather than the 4096 many parsers assume — read it rather than
 * hardcoding it.
 */
export function parseVmStat(output: string, totalBytes: number): MemoryStats | undefined {
  const pageSize = Number(output.match(/page size of (\d+) bytes/)?.[1])
  if (!Number.isFinite(pageSize) || pageSize <= 0) return undefined

  const pages = (label: string): number => {
    const m = output.match(new RegExp(`${label}:\\s+(\\d+)\\.`, 'i'))
    return m ? Number(m[1]) : 0
  }

  const wiredBytes = pages('Pages wired down') * pageSize
  const activeBytes = pages('Pages active') * pageSize
  // "occupied by compressor" is the real footprint; "stored in compressor" is
  // the uncompressed size of that data and would overstate usage.
  const compressedBytes = pages('Pages occupied by compressor') * pageSize
  const freeBytes = pages('Pages free') * pageSize

  return {
    totalBytes,
    wiredBytes,
    activeBytes,
    compressedBytes,
    freeBytes,
    usedBytes: wiredBytes + activeBytes + compressedBytes,
  }
}

/**
 * Pull GPU counters out of ioreg's PerformanceStatistics dictionary.
 * Key names differ across GPU families, so each lookup is tolerant.
 */
export function parseIoregGpu(output: string): GpuStats {
  const num = (key: string): number | undefined => {
    const m = output.match(new RegExp(`"${key}"\\s*=\\s*(\\d+)`))
    return m ? Number(m[1]) : undefined
  }
  return {
    utilizationPercent: num('Device Utilization %') ?? num('GPU Activity\\(%\\)'),
    inUseBytes: num('In use system memory'),
    allocatedBytes: num('Alloc system memory'),
    rendererPercent: num('Renderer Utilization %'),
    tilerPercent: num('Tiler Utilization %'),
  }
}

/** Aggregate `os.cpus()` times into one idle/total pair. */
export function cpuSample(cpus: Array<{ times: Record<string, number> }>): CpuSample {
  let idle = 0
  let total = 0
  for (const cpu of cpus) {
    for (const [mode, ms] of Object.entries(cpu.times)) {
      total += ms
      if (mode === 'idle') idle += ms
    }
  }
  return { idle, total }
}

/**
 * Busy percentage between two samples. Returns undefined on the first sample or
 * when no time elapsed, so callers can show "—" rather than a bogus 0%.
 */
export function cpuPercent(prev: CpuSample | undefined, next: CpuSample): number | undefined {
  if (!prev) return undefined
  const totalDelta = next.total - prev.total
  const idleDelta = next.idle - prev.idle
  if (totalDelta <= 0) return undefined
  const pct = (1 - idleDelta / totalDelta) * 100
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10))
}

const GB = 1024 ** 3

/** Never recommend a cache smaller than this — below it, reuse barely helps. */
export const MIN_PROMPT_CACHE = 1 * GB
/**
 * Cap the recommendation. Lowered from 32 GB after comparing against other MLX
 * servers, which ship a 2 GB prefix-cache default — beyond a few GB the cache
 * mostly competes with the model rather than earning its keep.
 */
export const MAX_PROMPT_CACHE = 8 * GB

export interface PromptCacheAdvice {
  /** Suggested `--prompt-cache-bytes`, or undefined when there is no headroom. */
  recommendedBytes?: number
  /** Free space under the GPU ceiling after the resident model. */
  headroomBytes?: number
  /** Why this number — shown verbatim in the UI. */
  reason: string
}

/**
 * Suggest a KV-cache budget from live memory.
 *
 * `mlx_lm.server` leaves `--prompt-cache-bytes` unbounded by default and trims
 * only by entry count (10), so long-context caches can grow into whatever the
 * model left free. This recommends a bound, it does not impose one: the caller
 * is free to ignore it and over-commit.
 *
 * Half of the free headroom is offered, after reserving room for activations
 * and allocator fragmentation, because the cache competes with the very
 * allocations that make generation possible.
 */
export function recommendPromptCacheBytes(args: {
  ceilingBytes?: number
  gpuInUseBytes?: number
}): PromptCacheAdvice {
  const { ceilingBytes, gpuInUseBytes } = args
  if (!ceilingBytes) {
    return { reason: 'GPU ceiling unknown — cannot size the cache yet.' }
  }

  const inUse = gpuInUseBytes ?? 0
  const headroomBytes = Math.max(0, ceilingBytes - inUse)
  // Activations and fragmentation need room the cache must not claim.
  const reserve = Math.max(4 * GB, ceilingBytes * 0.1)
  const spare = headroomBytes - reserve

  if (spare <= MIN_PROMPT_CACHE) {
    return {
      headroomBytes,
      reason:
        'Little headroom under the GPU ceiling — a large KV cache would compete with the ' +
        'model. Keep the cache small or unload the model first.',
    }
  }

  const recommendedBytes = Math.min(MAX_PROMPT_CACHE, Math.floor(spare * 0.25))
  return {
    recommendedBytes,
    headroomBytes,
    reason:
      'A quarter of the free headroom under the GPU ceiling (capped at 8 GB), after ' +
      'reserving room for activations. Raising it caches longer conversations; too ' +
      'high and a long context can push the model out of memory.',
  }
}

/** Parse `ps -o rss=,%cpu=` output (RSS is in KiB). */
export function parsePs(output: string): { rssBytes: number; cpuPercent: number } | undefined {
  const m = output.trim().match(/^(\d+)\s+([\d.]+)$/)
  if (!m) return undefined
  return { rssBytes: Number(m[1]) * 1024, cpuPercent: Number(m[2]) }
}
