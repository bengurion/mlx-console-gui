import * as os from 'node:os'
import * as path from 'node:path'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { log } from '../core/logging'
import { Emitter, type Disposable } from '../core/events'
import { Config } from '../config'
import {
  cpuPercent,
  perCorePercent,
  cpuSample,
  pagingRates,
  parseDeviceInfo,
  parsePagingCounters,
  parseSwapUsage,
  parseIoregGpu,
  parsePs,
  parseVmStat,
  parseWiredLimit,
  recommendPromptCacheBytes,
  type CpuSample,
  type GpuDeviceInfo,
  type PagingCounters,
} from './metrics'
import {
  parseProcessGpu,
  powermetricsArgs,
  type ProcessGpuSample,
} from './powermetrics'
import { SERVER_DEFAULTS, occupancyBytes, recommendConcurrency } from './modelConfig'
import { ModelConfigReader } from './modelConfigReader'
import type { MetricsSnapshot } from '../shared/protocol'
import type { EnvironmentManager } from '../backend/environmentManager'
import type { ServerManager } from '../backend/serverManager'

const run = promisify(execFile)
const SAMPLE_TIMEOUT_MS = 4000

/** Run a command, returning '' instead of throwing — metrics must never break the UI. */
async function tryRun(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(cmd, args, { timeout: SAMPLE_TIMEOUT_MS, maxBuffer: 8 << 20 })
    return stdout
  } catch {
    return ''
  }
}

/**
 * Samples CPU / memory / GPU while at least one webview is listening.
 *
 * Polling only runs while a subscriber is attached, so a hidden panel costs
 * nothing. Every source is best-effort: a missing tool degrades that one field
 * rather than failing the snapshot.
 */
export class MetricsService implements Disposable {
  private timer: NodeJS.Timeout | undefined
  private prevCpu: CpuSample | undefined
  private prevPaging: { counters: PagingCounters; at: number } | undefined
  private deviceInfo: GpuDeviceInfo | undefined
  private deviceInfoTried = false
  private subscribers = 0
  private readonly modelConfig = new ModelConfigReader()

  private readonly _onDidSample = new Emitter<MetricsSnapshot>()
  readonly onDidSample = this._onDidSample.event

  /**
   * How to obtain root, when the host can offer it.
   *
   * Elevation is inherently a UI act — someone has to be asked and has to type
   * a password — so the host supplies it. Without one, the non-interactive path
   * is tried and the caller is told authentication is needed.
   */
  elevate?: (args: string[]) => Promise<boolean>

  constructor(
    private readonly env: EnvironmentManager,
    private readonly server: ServerManager,
    private readonly intervalMs = 2000,
  ) {}

  /** Begin polling; the returned disposable releases this subscription. */
  subscribe(): Disposable {
    this.subscribers++
    if (this.subscribers === 1) this.start()
    return {
      dispose: () => {
        this.subscribers = Math.max(0, this.subscribers - 1)
        if (this.subscribers === 0) this.stop()
      },
    }
  }

  private start() {
    if (this.timer) return
    void this.sampleOnce()
    this.timer = setInterval(() => void this.sampleOnce(), this.intervalMs)
  }

  private stop() {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
    this.prevCpu = undefined
  }

  /**
   * Static GPU limits, read once from mlx via the managed interpreter.
   *
   * The latch is set only on success. A new window samples before
   * `env.refresh()` has resolved the active venv, so an early attempt finds no
   * interpreter — latching there would leave that window without a GPU ceiling
   * for the rest of the session.
   */
  private async loadDeviceInfo(): Promise<void> {
    if (this.deviceInfoTried) return
    if (!this.env.venvExists()) return // not ready yet; try again next sample
    // `mx.metal.device_info` is deprecated in favour of `mx.device_info`; try
    // the current name first and fall back for older mlx builds.
    const stdout = await tryRun(this.env.venvPython, [
      '-c',
      'import json,mlx.core as mx;'
      + 'f=getattr(mx,"device_info",None) or mx.metal.device_info;'
      + 'print(json.dumps(f()))',
    ])
    this.deviceInfo = parseDeviceInfo(stdout.trim())
    if (this.deviceInfo) {
      this.deviceInfoTried = true
      log.info(`GPU: ${this.deviceInfo.deviceName ?? 'unknown'}`)
    }
  }

  /**
   * Paging rates since the previous sample.
   *
   * Cumulative counters are useless on their own — a machine up for a week has
   * swapped at some point. What matters is whether it is swapping *now*, while
   * a model is resident.
   */
  private pagingSince(counters: PagingCounters | undefined) {
    if (!counters) return undefined
    const at = Date.now()
    const rates = pagingRates(this.prevPaging?.counters, counters, at - (this.prevPaging?.at ?? at))
    this.prevPaging = { counters, at }
    return rates
  }

  async sampleOnce(): Promise<MetricsSnapshot> {
    await this.loadDeviceInfo()

    const [vmStat, ioregOut, wiredOut, swapOut] = await Promise.all([
      tryRun('vm_stat', []),
      tryRun('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']),
      tryRun('sysctl', ['iogpu.wired_limit_mb']),
      tryRun('sysctl', ['vm.swapusage']),
    ])

    const next = cpuSample(os.cpus())
    const cpu = {
      percent: cpuPercent(this.prevCpu, next),
      cores: os.cpus().length,
      load1: os.loadavg()[0],
      perCore: perCorePercent(this.prevCpu, next),
    }
    this.prevCpu = next

    const gpu = { ...parseIoregGpu(ioregOut), ...this.deviceInfo }
    const wiredLimitBytes = parseWiredLimit(wiredOut)

    const proc = await this.serverProcess()
    // GPU in-use collapses when a resident model goes idle; the server's RSS is
    // the honest measure of what is actually held.
    const occupied = occupancyBytes({
      gpuInUseBytes: gpu.inUseBytes,
      serverRssBytes: proc?.rssBytes,
    })

    const snapshot: MetricsSnapshot = {
      at: Date.now(),
      cpu,
      memory: parseVmStat(vmStat, os.totalmem()),
      gpu,
      wiredLimitBytes,
      occupiedBytes: occupied,
      swap: parseSwapUsage(swapOut),
      paging: this.pagingSince(parsePagingCounters(vmStat)),
      promptCache: {
        ...recommendPromptCacheBytes({
          ceilingBytes: wiredLimitBytes ?? gpu.maxRecommendedWorkingSetBytes,
          gpuInUseBytes: occupied,
        }),
        configuredBytes: Config.promptCacheBytes(),
      },
      concurrency: this.concurrencyAdvice(
        wiredLimitBytes ?? gpu.maxRecommendedWorkingSetBytes,
        occupied,
      ),
      process: proc,
    }
    this._onDidSample.fire(snapshot)
    return snapshot
  }

  /** Current GPU bytes in use, sampled directly (cheap: one ioreg call). */
  async gpuInUseBytes(): Promise<number | undefined> {
    const out = await tryRun('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'])
    return parseIoregGpu(out).inUseBytes
  }

  /** How many parallel sequences the current model and memory can support. */
  private concurrencyAdvice(
    ceilingBytes?: number,
    inUseBytes?: number,
  ): MetricsSnapshot['concurrency'] {
    const model = this.server.loadedModel ?? this.server.activeModel
    const advice = recommendConcurrency({
      headroomBytes: ceilingBytes ? Math.max(0, ceilingBytes - (inUseBytes ?? 0)) : undefined,
      contextWindow: model ? this.modelConfig.contextLength(model) : undefined,
      kvBytesPerToken: model ? this.modelConfig.kvBytesPerToken(model) : undefined,
    })
    return {
      ...advice,
      configured: Config.decodeConcurrency(),
      serverDefault: SERVER_DEFAULTS.decodeConcurrency,
    }
  }

  /** RSS and CPU of the mlx_lm.server process, when one is running. */
  private async serverProcess(): Promise<MetricsSnapshot['process']> {
    const pid = this.server.pid
    if (!pid) return undefined
    const out = await tryRun('ps', ['-o', 'rss=,%cpu=', '-p', String(pid)])
    const parsed = parsePs(out)
    return parsed ? { pid, ...parsed } : undefined
  }

  /**
   * Take one per-process GPU sample. Requires root.
   *
   * Tries `sudo -n` first (silent, works if the user has configured
   * passwordless sudo for powermetrics). If that fails, runs the command in a
   * visible terminal so the user types their own password — the extension
   * never receives, stores, or forwards a credential.
   *
   * Returns GPU *time* attribution only; macOS has no per-process GPU memory
   * accounting at any privilege level.
   */
  async samplePerProcessGpu(): Promise<{
    ok: boolean
    samples?: ProcessGpuSample[]
    error?: string
    needsAuth?: boolean
  }> {
    const outFile = path.join(os.tmpdir(), `mlx-console-powermetrics-${process.pid}.txt`)
    const args = powermetricsArgs(outFile)

    try {
      await fs.rm(outFile, { force: true })
    } catch {
      /* first run */
    }

    // 1. Non-interactive: succeeds only with an existing passwordless rule.
    try {
      await run('sudo', ['-n', ...args], { timeout: 20_000 })
      return { ok: true, samples: parseProcessGpu(await fs.readFile(outFile, 'utf8')) }
    } catch {
      log.info('sudo -n powermetrics unavailable; falling back to an interactive terminal')
    }

    // 2. Interactive: the host asks, and the user types their own password
    // somewhere they can see the command. We never handle the password.
    if (!this.elevate) return { ok: false, needsAuth: true }
    if (!(await this.elevate(args))) return { ok: false, needsAuth: true }

    // Poll for the file the privileged command writes.
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      try {
        const text = await fs.readFile(outFile, 'utf8')
        if (text.trim()) return { ok: true, samples: parseProcessGpu(text) }
      } catch {
        /* not written yet */
      }
    }
    return { ok: false, error: 'Timed out waiting for powermetrics output.' }
  }

  dispose() {
    this.stop()
    this._onDidSample.dispose()
  }
}
