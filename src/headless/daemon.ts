/**
 * The daemon behind every non-VSCode front end.
 *
 * `mlx-console serve` and the desktop app are the same application: the same
 * services the extension constructs, wired to a settings file and an HTTP
 * server instead of an editor. This module holds that assembly so each entry
 * point only decides what it can — where settings come from, which host
 * answers questions that need a person, and when to start and stop.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import pkg from '../../package.json'
import { WebUiServer } from '../services/webUiServer'
import { buildSettingsCatalog, coerceSettingValue, type ConfigProperty } from '../services/settingsCatalog'
import { parseIoregGpu, parseVmStat, parsePs, parseWiredLimit } from '../services/metrics'
import { occupancyBytes } from '../services/modelConfig'
import { SettingsStore, extractMlxSettings, parseJsonc } from './settingsStore'
import { HeadlessServer } from './serverControl'
import { settingsCandidates } from './hostPaths'
import { runtimeSettingKeys } from '../services/vscodeIntegration'
import { setSettingsSource } from '../core/settings'
import { EnvironmentManager } from '../backend/environmentManager'
import { ServerManager } from '../backend/serverManager'
import { PythonHelper } from '../backend/pythonHelper'
import { HuggingFaceService } from '../services/huggingFaceService'
import { CacheService } from '../services/cacheService'
import { DownloadManager } from '../services/downloadManager'
import { ConvertManager } from '../services/convertManager'
import { MetricsService } from '../services/metricsService'
import { WebviewHub, type HubHost } from '../ui/webview/webviewHub'
import { HarmonyProxy } from '../services/harmonyProxy'
import { StoreSettings, headlessEnvHost, headlessHubHost, storageDir } from './headlessHost'
import { readInstallRoot } from './installRoot'
import { PythonBridge, findBundle, findHelper, selfPath } from './pythonBridge'
import type { LocalModel } from '../shared/protocol'

const run = promisify(execFile)

export interface DaemonLogger {
  info: (m: string, ...rest: unknown[]) => void
  warn: (m: string, ...rest: unknown[]) => void
  error: (m: string, ...rest: unknown[]) => void
}

/** The manifest is the single source of truth for settings, as in the panel. */
export function properties(): Record<string, ConfigProperty> {
  return (pkg.contributes?.configuration?.properties ?? {}) as Record<string, ConfigProperty>
}

/** Manifest defaults keyed by short name, as SettingsStore expects them. */
export function settingsDefaults(): Record<string, unknown> {
  const defaults: Record<string, unknown> = {}
  for (const [key, prop] of Object.entries(properties())) {
    defaults[key.replace(/^mlxConsole\./, '')] = (prop as ConfigProperty).default
  }
  return defaults
}

export function loadSettings(): SettingsStore {
  const defaults = settingsDefaults()
  // Once the desktop app has installed into a root, its config.json is the
  // source of truth for every front end. It was written by onboarding, so no
  // VSCode seeding applies.
  const root = readInstallRoot()
  const rootConfig = root ? path.join(root, 'config.json') : undefined
  if (rootConfig && fs.existsSync(rootConfig)) {
    return new SettingsStore(defaults, rootConfig).load()
  }
  // Seeded from VSCode on first run only; after that this file stands alone.
  const seed = settingsCandidates()
    .map((f) => {
      try {
        return extractMlxSettings(parseJsonc(fs.readFileSync(f, 'utf8')))
      } catch {
        return undefined
      }
    })
    .find((s) => s && Object.keys(s).length > 0)

  return new SettingsStore(defaults).load(seed)
}

/**
 * The real GPU ceiling, straight from Metal.
 *
 * `max_recommended_working_set_size` is well under total RAM and is the number
 * that actually matters; without it the dashboard would fall back to total
 * memory and quietly overstate your headroom. Needs the venv's Python, so it
 * is best-effort and cached for the life of the process.
 */
let deviceInfo: Record<string, number> | undefined
let deviceInfoTried = false

async function readDeviceInfo(venv?: string): Promise<Record<string, number> | undefined> {
  if (deviceInfoTried || !venv) return deviceInfo
  try {
    const { stdout } = await run(path.join(venv, 'bin', 'python'), [
      '-c',
      'import mlx.core as mx, json; print(json.dumps({k: int(v) for k, v in mx.device_info().items() if isinstance(v, int)}))',
    ])
    deviceInfo = JSON.parse(stdout) as Record<string, number>
    // Only latch on success: a not-yet-installed venv must not disable this
    // permanently, which is exactly the bug the extension had.
    deviceInfoTried = true
  } catch {
    /* mlx not importable yet; try again next poll */
  }
  return deviceInfo
}

/**
 * The Python helper, pointed at the configured models directory.
 *
 * Undefined when there is no venv or the script is not beside us — both are
 * ordinary situations (a fresh machine, a CLI copied somewhere odd), so the
 * caller degrades rather than fails.
 */
export function pythonBridge(server: HeadlessServer, helper = findHelper()): PythonBridge | undefined {
  const venv = server.venv()
  if (!venv || !helper) return undefined
  return new PythonBridge({ venv, helper, env: server.processEnv() })
}

/** Machine metrics, read the same way the extension reads them. */
export async function metrics(pid?: number, venv?: string) {
  const out: Record<string, unknown> = {}
  const dev = await readDeviceInfo(venv)
  if (dev) out.maxRecommendedWorkingSetBytes = dev.max_recommended_working_set_size
  try {
    const vm = await run('vm_stat')
    const mem = parseVmStat(vm.stdout, os.totalmem())
    if (mem) Object.assign(out, { memory: mem })
  } catch {
    /* not fatal — the dashboard just shows less */
  }
  try {
    const io = await run('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'])
    out.gpu = parseIoregGpu(io.stdout)
  } catch {
    /* ditto */
  }
  try {
    const sc = await run('sysctl', ['iogpu.wired_limit_mb'])
    out.wiredLimitBytes = parseWiredLimit(sc.stdout)
  } catch {
    /* unset means "use the Metal default" */
  }
  if (pid !== undefined) {
    try {
      const ps = await run('ps', ['-o', 'rss=,%cpu=', '-p', String(pid)])
      out.process = parsePs(ps.stdout)
    } catch {
      /* the process went away between calls */
    }
  }
  return out
}

/** Where the running daemon leaves its URL, readable only by you. */
export const URL_FILE = path.join(os.homedir(), '.mlx-console', 'url')

function writeUrlFile(url: string): void {
  try {
    fs.mkdirSync(path.dirname(URL_FILE), { recursive: true })
    fs.writeFileSync(URL_FILE, url + '\n', { mode: 0o600 })
  } catch {
    /* not fatal: the URL is still on stdout in a terminal */
  }
}

function clearUrlFile(): void {
  try {
    fs.unlinkSync(URL_FILE)
  } catch {
    /* already gone */
  }
}

/**
 * Local models for the dashboard, cached.
 *
 * Scanning walks the whole cache directory, which takes real time on a disk
 * holding 60 GB of weights — far too slow to repeat on every 3-second poll.
 * A stale-while-revalidate cache keeps the page responsive and the list fresh
 * enough for something that only changes when you download or delete.
 */
const MODEL_CACHE_MS = 60_000

function modelLister(py: PythonBridge | undefined, log: DaemonLogger) {
  let cached: LocalModel[] = []
  let at = 0
  let inFlight: Promise<void> | undefined

  return async (): Promise<LocalModel[]> => {
    if (!py) return []
    const stale = Date.now() - at > MODEL_CACHE_MS
    if (stale && !inFlight) {
      inFlight = py
        .scan()
        .then((models) => {
          cached = models
          at = Date.now()
        })
        .catch((err) => log.error('Model scan failed', err))
        .finally(() => {
          inFlight = undefined
        })
      // Block only on the first scan; later ones refresh behind the page.
      if (!at) await inFlight
    }
    return cached
  }
}

/**
 * The whole application, without an editor.
 *
 * Every service here is the same class the extension constructs — same server
 * manager, same metrics sampler, same hub — differing only in which host
 * answers the questions that need a person. That is the point of the split:
 * the daemon serves the real UI rather than an approximation of it.
 */
function buildApp(dir: string, helper: string | undefined, hubHost: HubHost) {
  const env = new EnvironmentManager(headlessEnvHost(dir))
  const server = new ServerManager(env)
  server.useSharedState(path.join(dir, 'server-state.json'))

  const python = helper ? new PythonHelper(env, helper) : undefined
  const metrics = new MetricsService(env, server)
  const hf = new HuggingFaceService()
  const downloads = python ? new DownloadManager(python) : undefined
  const cache = python ? new CacheService(python) : undefined
  const convert = python ? new ConvertManager(env, python) : undefined
  if (downloads && convert && cache) {
    // The two managers must know about each other, or a download and a
    // convert of the same repo become two unrelated helpers racing the same
    // blobs directory.
    downloads.busyElsewhere = (repo) =>
      convert.isActive(repo) ? 'A conversion of this repo is already downloading it.' : undefined
    convert.busyElsewhere = (repo) =>
      downloads.isActive(repo) ? 'This repo is already downloading — wait for it or cancel it first.' : undefined
    // Facts feed the convert gates on every entry path, palette included.
    convert.facts = async (repo) => {
      const [paramsB, factsRes] = await Promise.all([
        hf.getParamsB(repo).catch(() => undefined),
        hf.getConfigFacts(repo).catch(() => undefined),
      ])
      const supported = factsRes?.modelType
        ? await cache.archSupported(factsRes.modelType).catch(() => undefined)
        : undefined
      return {
        paramsB,
        arch: factsRes
          ? { modelType: factsRes.modelType, supported, prequantized: factsRes.prequantized }
          : undefined,
      }
    }
  }

  // Same filtered endpoint the extension offers, for the same reason: without
  // it, a gpt-oss answer arrives with the model's reasoning in front of it.
  // The load callbacks keep the registry honest when an API client (Claude
  // Code, most likely) swaps the resident model inside one of its requests.
  const cleanEndpoint = new HarmonyProxy({
    upstream: () => server.baseUrl(),
    onModelUse: (m) => server.beginModelUse(m),
    onModelServed: (m) => server.confirmModelLoaded(m),
    onModelFailed: () => server.abortModelLoad(),
  })
  const hub =
    python && downloads && cache && convert
      ? new WebviewHub({
        env,
        server,
        hf,
        cache,
        downloads,
        convert,
        metrics,
        packageJSON: pkg,
        extensionUri: { fsPath: dir },
        host: hubHost,
        cleanEndpointUrl: () => cleanEndpoint.url,
        // The daemon may clean runtime keys out of editors' settings.json —
        // for it they are stale remnants, not configuration (the embedded
        // extension, which actually reads them, never gets this).
          vscodeCleanupKeys: () => runtimeSettingKeys(pkg),
        })
      : undefined

  void env.refresh()
  return { env, server, metrics, hub, cleanEndpoint, downloads, convert }
}

export interface DaemonOptions {
  settings: SettingsStore
  /** Where the venv and server registry live; defaults to the shared discovery. */
  storageDir?: string
  /** Explicit paths for hosts (the packaged app) that cannot walk from argv. */
  helperPath?: string
  bundlePath?: string
  port?: number
  log?: DaemonLogger
  /** Who answers confirmations and opens links; defaults to log-and-proceed. */
  hubHost?: HubHost
}

export interface Daemon {
  /** Set once start() succeeds. */
  url: string | undefined
  readonly env: EnvironmentManager
  readonly manager: ServerManager
  readonly server: HeadlessServer
  readonly hub: WebviewHub | undefined
  start(): Promise<string | undefined>
  stop(opts?: { keepServer?: boolean }): Promise<void>
}

export function createDaemon(opts: DaemonOptions): Daemon {
  const log = opts.log ?? {
    info: (m: string, ...r: unknown[]) => console.log(m, ...r),
    warn: (m: string, ...r: unknown[]) => console.error(m, ...r),
    error: (m: string, ...r: unknown[]) => console.error(m, ...r),
  }
  const settings = opts.settings
  // Everything downstream reads settings through this, exactly as the
  // extension reads them through VSCode's configuration.
  setSettingsSource(new StoreSettings(settings))

  const dir = opts.storageDir ?? storageDir()
  const server = new HeadlessServer(settings)
  const uiPort = opts.port ?? Number(settings.get('webUi.port', 8090))
  const helper = opts.helperPath ?? findHelper()
  const bundle = opts.bundlePath ?? findBundle()
  const listModels = modelLister(pythonBridge(server, helper), log)
  const app = buildApp(dir, helper, opts.hubHost ?? headlessHubHost())

  // The full panel UI when the helper script is beside us; the compact page
  // otherwise, since without it there is nothing behind half the buttons.
  const fullUi = Boolean(app.hub && bundle)
  if (!fullUi) {
    // Say exactly what was missing and where we looked: the usual cause is
    // running a copy of cli.js away from the files that ship beside it.
    log.warn(
      `Serving the compact dashboard — ${helper ? 'panel bundle' : 'helper script'} not found ` +
        `next to ${selfPath()}.`,
    )
  }

  const ui = new WebUiServer({
    app:
      fullUi && app.hub && bundle
        ? {
            scriptPath: bundle,
            attach: (sink) => app.hub!.attach(sink),
            handleMessage: (sink, message) => app.hub!.handleMessage(sink, message),
          }
        : undefined,
    settings: () =>
      buildSettingsCatalog(properties(), (short) => settings.get(short)).map((s) => ({
        ...s,
        // Say where the value came from; the two config files can drift.
        description: `${s.description ?? ''} [${settings.sourceOf(s.short)}]`.trim(),
      })),
    updateSetting: async (key, value) => {
      const short = key.replace(/^mlxConsole\./, '')
      const spec = buildSettingsCatalog(properties(), () => undefined).find((s) => s.short === short)
      if (!spec) return { ok: false, error: `Unknown setting ${key}` }
      const coerced = coerceSettingValue(spec, value)
      if (!coerced.ok) return { ok: false, error: coerced.error }
      settings.set(short, coerced.value)
      return { ok: true }
    },
    state: async () => {
      const s = await server.status()
      const m = await metrics(s.pid, s.venv)
      const mem = m.memory as { totalBytes?: number } | undefined
      const gpu = m.gpu as { inUseBytes?: number; maxRecommendedWorkingSetBytes?: number; utilizationPercent?: number } | undefined
      const proc = m.process as { rssBytes?: number; cpuPercent?: number } | undefined
      return {
        serverState: s.state,
        loadedModel: s.loadedModel,
        baseUrl: `http://127.0.0.1:${s.port}/v1`,
        occupiedBytes: occupancyBytes({ gpuInUseBytes: gpu?.inUseBytes, serverRssBytes: proc?.rssBytes }),
        ceilingBytes:
          (m.wiredLimitBytes as number | undefined) ??
          (m.maxRecommendedWorkingSetBytes as number | undefined) ??
          mem?.totalBytes,
        cpuPercent: proc?.cpuPercent,
        gpuPercent: gpu?.utilizationPercent,
        models: await listModels(),
      }
    },
    serverAction: async (action) => {
      // No model management here: 'clear' means restart, which is the only way
      // mlx_lm.server ever releases weights.
      const r = action === 'stop' ? await server.stop() : action === 'start' ? await server.start() : await server.restart()
      log.info(r.message)
      return { ok: r.ok }
    },
    log,
    notify: (m) => log.error(m),
    hostLabel: 'the mlx-console daemon',
    requireToken: () => settings.get<boolean>('webUi.requireToken', false),
  })

  const daemon: Daemon = {
    url: undefined,
    env: app.env,
    manager: app.server,
    server,
    hub: app.hub,

    async start() {
      if (settings.get<boolean>('cleanEndpoint.enabled', false)) {
        const port = Number(settings.get('cleanEndpoint.port', 8082))
        const url = await app.cleanEndpoint.start(Number.isFinite(port) ? port : 8082)
        if (url) log.info(`Filtered endpoint on ${url}`)
      }

      /*
       * Take another port rather than failing.
       *
       * The extension serves the dashboard on 8090 by default, so a collision
       * is the ordinary case rather than an error — and the previous behaviour
       * was the worst of both: the bind failed, nothing was served, and the
       * process stayed alive anyway because the proxy was still holding the
       * loop open.
       */
      const url = await ui.start(uiPort, { onBusy: 'ephemeral' })
      if (!url) {
        log.error(`Could not serve the dashboard on ${uiPort} or any free port.`)
        await app.cleanEndpoint.stop()
        return undefined
      }
      if (!url.includes(`:${uiPort}/`)) {
        log.info(`Port ${uiPort} was taken — using ${new URL(url).port} instead.`)
      }
      // With a token configured the URL is a credential, and under launchd
      // stdout is a 0644 log file — so leave it in a 0600 file that
      // `mlx-console url` reads back rather than only printing it.
      writeUrlFile(url)
      daemon.url = url
      return url
    },

    /**
     * Shut down what we started.
     *
     * Servers are spawned detached so they outlive a VSCode window, which is
     * wanted there — but quitting deliberately is a different act, and leaving
     * a process holding tens of gigabytes behind is not a graceful exit. So
     * quitting stops the model servers too, unless keepServer says otherwise.
     */
    async stop({ keepServer = false } = {}) {
      clearUrlFile()
      // The workers first: downloads and conversions spawn children that
      // outlive this process if nobody tells them to stop — the orphaned
      // helpers that kept downloading behind a dead app's back.
      app.downloads?.dispose()
      app.convert?.dispose()
      await app.cleanEndpoint.stop()
      if (!keepServer) {
        const { stopped, forced, survivors } = await server.stopAll()
        const total = stopped.length + forced.length
        // Reported either way: silence here reads as "it did not clean up".
        log.info(
          total
            ? `Stopped ${total} model server${total === 1 ? '' : 's'} on exit` +
                (forced.length ? ` (${forced.length} needed SIGKILL).` : '.')
            : 'No model servers were running.',
        )
        if (survivors.length) {
          log.error(
            `Server pid(s) ${survivors.join(', ')} survived SIGKILL — stuck in GPU work, ` +
              'still holding wired memory. `mlx-console stop --all` once the call returns.',
          )
        }
      }
      await ui.stop()
    },
  }

  return daemon
}
