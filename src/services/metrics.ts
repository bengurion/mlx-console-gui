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

export interface GpuStats {
  /** 0-100. Overall device utilization as reported by the accelerator. */
  utilizationPercent?: number
  /** Bytes the GPU driver currently has mapped — tracks the loaded model. */
  inUseBytes?: number
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
