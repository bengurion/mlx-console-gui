/**
 * mlx-console — the extension's dashboard and server control, without VSCode.
 *
 * The extension host is a convenient place to run this, not a necessary one:
 * everything the dashboard needs is a process, a settings file and some
 * `ioreg`/`vm_stat` output. This entry point wires the same components to a
 * terminal instead, and shares the registry file so the two adopt each other's
 * server rather than fighting over the port.
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
import { buildPlist, loadCommands, plistPath, unloadCommands, logPaths } from './launchd'
import { parseArgs } from './args'
import { setSettingsSource } from '../core/settings'
import { setLogSink } from '../core/logging'
import { EnvironmentManager } from '../backend/environmentManager'
import { ServerManager } from '../backend/serverManager'
import { PythonHelper } from '../backend/pythonHelper'
import { HuggingFaceService } from '../services/huggingFaceService'
import { CacheService } from '../services/cacheService'
import { DownloadManager } from '../services/downloadManager'
import { ConvertManager } from '../services/convertManager'
import { MetricsService } from '../services/metricsService'
import { WebviewHub } from '../ui/webview/webviewHub'
import { HarmonyProxy } from '../services/harmonyProxy'
import { StoreSettings, headlessEnvHost, headlessHubHost, storageDir } from './headlessHost'
import { PythonBridge, findBundle, findHelper, selfPath } from './pythonBridge'
import type { LocalModel } from '../shared/protocol'

const run = promisify(execFile)

const HELP = `mlx-console ${pkg.version} — MLX Console without VS Code

  mlx-console serve [--port N]   serve the local dashboard (foreground)
                                 --keep-server leaves the model server up on exit
  mlx-console start              start mlx_lm.server
  mlx-console stop [--all]       stop mlx_lm.server (--all: every one running)
  mlx-console restart            restart mlx_lm.server
  mlx-console status [--json]    what is running, and what it costs
  mlx-console models [--json]    local models, scanned from your models directory
  mlx-console url                print the dashboard link
  mlx-console install [--port N] run the dashboard at login (launchd)
  mlx-console uninstall          remove the launchd agent
  mlx-console config             where settings are read from

Settings live in ~/.mlx-console/config.json, seeded once from your VS Code
settings. The dashboard is loopback-only and refuses cross-site requests; set
webUi.requireToken for a token as well. The URL is printed when it starts.
`

const log = {
  info: (m: string, ...r: unknown[]) => console.log(m, ...r.map(fmt)),
  warn: (m: string, ...r: unknown[]) => console.error(m, ...r.map(fmt)),
  error: (m: string, ...r: unknown[]) => console.error(m, ...r.map(fmt)),
}
const fmt = (v: unknown) => (v instanceof Error ? (v.stack ?? v.message) : v)

/** The manifest is the single source of truth for settings, as in the panel. */
function properties(): Record<string, ConfigProperty> {
  return (pkg.contributes?.configuration?.properties ?? {}) as Record<string, ConfigProperty>
}

function loadSettings(): SettingsStore {
  const defaults: Record<string, unknown> = {}
  for (const [key, prop] of Object.entries(properties())) {
    defaults[key.replace(/^mlxConsole\./, '')] = (prop as ConfigProperty).default
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
function pythonBridge(server: HeadlessServer): PythonBridge | undefined {
  const venv = server.venv()
  const helper = findHelper()
  if (!venv || !helper) return undefined
  return new PythonBridge({ venv, helper, env: server.processEnv() })
}

/** Machine metrics, read the same way the extension reads them. */
async function metrics(pid?: number, venv?: string) {
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
const URL_FILE = path.join(os.homedir(), '.mlx-console', 'url')

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

function modelLister(py: PythonBridge | undefined) {
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
function buildApp(settings: SettingsStore, helper: string | undefined) {
  const dir = storageDir()
  const env = new EnvironmentManager(headlessEnvHost(dir))
  const server = new ServerManager(env)
  server.useSharedState(path.join(dir, 'server-state.json'))

  const python = helper ? new PythonHelper(env, helper) : undefined
  const metrics = new MetricsService(env, server)

  // Same filtered endpoint the extension offers, for the same reason: without
  // it, a gpt-oss answer arrives with the model's reasoning in front of it.
  const cleanEndpoint = new HarmonyProxy({ upstream: () => server.baseUrl() })
  const hub = python
    ? new WebviewHub({
        env,
        server,
        hf: new HuggingFaceService(),
        cache: new CacheService(python),
        downloads: new DownloadManager(python),
        convert: new ConvertManager(env, python),
        metrics,
        packageJSON: pkg,
        extensionUri: { fsPath: dir },
        host: headlessHubHost(),
        cleanEndpointUrl: () => cleanEndpoint.url,
      })
    : undefined

  void env.refresh()
  return { env, server, metrics, hub, cleanEndpoint }
}

/** How long a graceful exit waits before quitting regardless. */
const STOP_ALL_TIMEOUT_MS = 8000

async function serve(port?: number, keepServer = false): Promise<void> {
  const settings = loadSettings()
  // Everything downstream reads settings through this, exactly as the
  // extension reads them through VSCode's configuration.
  setSettingsSource(new StoreSettings(settings))

  const server = new HeadlessServer(settings)
  const uiPort = port ?? Number(settings.get('webUi.port', 8090))
  const listModels = modelLister(pythonBridge(server))

  // The full panel UI when the helper script is beside us; the compact page
  // otherwise, since without it there is nothing behind half the buttons.
  const helper = findHelper()
  const bundle = findBundle()
  const app = buildApp(settings, helper)
  if (settings.get<boolean>('cleanEndpoint.enabled', false)) {
    const port = Number(settings.get('cleanEndpoint.port', 8082))
    const url = await app.cleanEndpoint.start(Number.isFinite(port) ? port : 8082)
    if (url) log.info(`Filtered endpoint on ${url}`)
  }
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

  /*
   * Take another port rather than failing.
   *
   * The extension serves the dashboard on 8090 by default, so a collision is
   * the ordinary case rather than an error — and the previous behaviour was
   * the worst of both: the bind failed, nothing was served, and the process
   * stayed alive anyway because the proxy was still holding the loop open.
   */
  const url = await ui.start(uiPort, { onBusy: 'ephemeral' })
  if (!url) {
    log.error(`Could not serve the dashboard on ${uiPort} or any free port.`)
    await app.cleanEndpoint.stop()
    process.exitCode = 1
    return
  }
  if (!url.includes(`:${uiPort}/`)) {
    log.info(`Port ${uiPort} was taken — using ${new URL(url).port} instead.`)
  }
  {
    // With a token configured the URL is a credential, and under launchd
    // stdout is a 0644 log file — so print it only to a terminal and otherwise
    // leave it in a 0600 file that `mlx-console url` reads back.
    writeUrlFile(url)
    if (process.stdout.isTTY) {
      console.log(`\n  MLX Console — ${url}\n`)
      console.log('  Settings: ~/.mlx-console/config.json')
      console.log(
      keepServer
        ? '  Ctrl-C stops the dashboard; the model server keeps running.\n'
        : '  Ctrl-C stops the dashboard and the model server (--keep-server to leave it up).\n',
    )
    } else {
      // The port actually bound, not the one asked for — they differ whenever
      // something else already had it.
      console.log(
        `MLX Console listening on 127.0.0.1:${new URL(url).port} — run \`mlx-console url\` for the link.`,
      )
    }
  }

  /**
   * Shut down what we started.
   *
   * Servers are spawned detached so they outlive a VSCode window, which is
   * wanted there — but quitting the daemon deliberately is a different act,
   * and leaving a process holding tens of gigabytes behind is not a graceful
   * exit. So Ctrl-C stops the model servers too, unless --keep-server says
   * otherwise.
   */
  const shutdown = () => {
    clearUrlFile()
    const done = () => process.exit(0)
    void (async () => {
      await app.cleanEndpoint.stop()
      if (!keepServer) {
        const { stopped, forced } = await server.stopAll()
        const total = stopped.length + forced.length
        // Reported either way: silence here reads as "it did not clean up".
        log.info(
          total
            ? `Stopped ${total} model server${total === 1 ? '' : 's'} on exit` +
                (forced.length ? ` (${forced.length} needed SIGKILL).` : '.')
            : 'No model servers were running.',
        )
      }
      await ui.stop()
      done()
    })()
    // Backstop: whatever is holding the loop open, Ctrl-C must mean Ctrl-C.
    setTimeout(done, STOP_ALL_TIMEOUT_MS).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function main(): Promise<void> {
  // Core services log through core/logging; send that to the terminal.
  setLogSink({ write: (level, message) => (level === 'ERROR' ? console.error : console.log)(message) })
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.command === 'help') return void console.log(HELP)

  switch (args.command) {
    case 'serve':
      return serve(args.port, args.keepServer)

    case 'start':
    case 'stop':
    case 'restart': {
      const server = new HeadlessServer(loadSettings())
      if (args.command === 'stop' && args.all) {
        const { stopped, forced } = await server.stopAll()
        const total = stopped.length + forced.length
        console.log(
          total === 0
            ? 'No mlx_lm.server processes were running.'
            : `Stopped ${total} server${total === 1 ? '' : 's'}` +
                (forced.length ? ` (${forced.length} needed SIGKILL)` : '') +
                `: ${[...stopped, ...forced].join(', ')}`,
        )
        return
      }
      const r = await server[args.command]()
      console.log(r.message)
      if (!r.ok) process.exitCode = 1
      return
    }

    case 'status': {
      const server = new HeadlessServer(loadSettings())
      const s = await server.status()
      const m = await metrics(s.pid, s.venv)
      if (args.json) return void console.log(JSON.stringify({ ...s, ...m }, null, 2))
      const gpu = m.gpu as { inUseBytes?: number } | undefined
      const proc = m.process as { rssBytes?: number } | undefined
      const held = occupancyBytes({ gpuInUseBytes: gpu?.inUseBytes, serverRssBytes: proc?.rssBytes })
      console.log(`server:  ${s.state}${s.pid ? ` (pid ${s.pid})` : ''} on port ${s.port}`)
      console.log(`model:   ${s.loadedModel ?? '—'}`)
      // With no server running this is device-wide GPU memory, not ours — say
      // so rather than implying a stopped server is holding gigabytes.
      const scope = s.state === 'ready' ? 'held by the server' : 'in use device-wide'
      console.log(`memory:  ${held ? `${(held / 1024 ** 3).toFixed(1)} GB ${scope}` : '—'}`)
      console.log(`venv:    ${s.venv ?? 'not found'}`)
      return
    }

    case 'install': {
      const settings = loadSettings()
      const port = args.port ?? Number(settings.get('webUi.port', 8090))
      const file = plistPath()
      const script = path.resolve(process.argv[1])
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.mkdirSync(path.dirname(logPaths().out), { recursive: true })
      // launchd creates these 0644 if they do not exist; pre-create them 0600
      // so daemon output is not readable by other local accounts.
      for (const f of [logPaths().out, logPaths().err]) {
        fs.closeSync(fs.openSync(f, 'a', 0o600))
        fs.chmodSync(f, 0o600)
      }
      fs.writeFileSync(file, buildPlist({ node: process.execPath, script, port }))
      for (const [cmd, ...cmdArgs] of loadCommands(file)) {
        // bootout fails when nothing is loaded yet; that is the normal path.
        await run(cmd, cmdArgs).catch(() => undefined)
      }
      console.log(`Installed ${file}`)
      console.log(`The dashboard will run at login on port ${port}.`)
      console.log(`Logs: ${logPaths().out}`)
      console.log('Run `mlx-console serve` once to see the URL with its token.')
      return
    }

    case 'uninstall': {
      for (const [cmd, ...cmdArgs] of unloadCommands()) await run(cmd, cmdArgs).catch(() => undefined)
      try {
        fs.unlinkSync(plistPath())
      } catch {
        // Not installed; nothing to remove.
      }
      console.log('Removed the launchd agent.')
      return
    }

    case 'models': {
      const server = new HeadlessServer(loadSettings())
      const py = pythonBridge(server)
      if (!py) {
        console.error('No mlx-lm environment or helper script found — run `mlx-console config`.')
        process.exitCode = 1
        return
      }
      const models = await py.scan()
      if (args.json) return void console.log(JSON.stringify(models, null, 2))
      if (!models.length) return void console.log('No models in the configured models directory.')
      const resident = (await server.status()).loadedModel
      for (const m of models) {
        const size = m.sizeBytes ? `${(m.sizeBytes / 1024 ** 3).toFixed(1)} GB` : '—'
        console.log(`${m.repo === resident ? '*' : ' '} ${size.padStart(9)}  ${m.repo}`)
      }
      if (resident) console.log('\n* resident in the running server')
      return
    }

    case 'url': {
      try {
        process.stdout.write(fs.readFileSync(URL_FILE, 'utf8'))
      } catch {
        console.error('No dashboard is running. Start one with `mlx-console serve`.')
        process.exitCode = 1
      }
      return
    }

    case 'config': {
      const settings = loadSettings()
      console.log(`config:   ${path.join(os.homedir(), '.mlx-console', 'config.json')}`)
      console.log(`seeded:   ${settingsCandidates().find((f) => fs.existsSync(f)) ?? 'no VS Code settings found'}`)
      const server = new HeadlessServer(settings)
      console.log(`venv:     ${server.venv() ?? 'not found'}`)
      // The path Python will actually scan, not the setting as typed.
      console.log(`HF_HOME:  ${server.processEnv().HF_HOME ?? '(default) ~/.cache/huggingface'}`)
      console.log(`helper:   ${findHelper() ?? 'not found'}`)
      console.log(`ui:       ${findBundle() ?? 'not found (compact dashboard)'}`)
      console.log(`cli:      ${selfPath()}`)
      return
    }

    default:
      console.error(`Unknown command: ${args.command}\n`)
      console.log(HELP)
      process.exitCode = 1
  }
}

// This module is only ever the CLI entry point — the pure, testable pieces
// live in args.ts and pythonBridge.ts. It used to guard on argv[1] ending in
// cli.js, which silently did nothing when invoked through the symlink npm
// install creates.
void main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
