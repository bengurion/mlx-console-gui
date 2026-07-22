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
import { PythonBridge, findHelper } from './pythonBridge'
import type { LocalModel } from '../shared/protocol'

const run = promisify(execFile)

const HELP = `mlx-console ${pkg.version} — MLX Console without VS Code

  mlx-console serve [--port N]   serve the local dashboard (foreground)
  mlx-console start              start mlx_lm.server
  mlx-console stop               stop mlx_lm.server
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
  const helper = findHelper(process.argv[1] ?? '')
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

async function serve(port?: number): Promise<void> {
  const settings = loadSettings()
  const server = new HeadlessServer(settings)
  const uiPort = port ?? Number(settings.get('webUi.port', 8090))
  const listModels = modelLister(pythonBridge(server))

  const ui = new WebUiServer({
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

  const url = await ui.start(uiPort)
  if (!url) {
    process.exitCode = 1
  } else {
    // With a token configured the URL is a credential, and under launchd
    // stdout is a 0644 log file — so print it only to a terminal and otherwise
    // leave it in a 0600 file that `mlx-console url` reads back.
    writeUrlFile(url)
    if (process.stdout.isTTY) {
      console.log(`\n  MLX Console — ${url}\n`)
      console.log('  Settings: ~/.mlx-console/config.json')
      console.log('  Ctrl-C to stop the dashboard (the model server keeps running).\n')
    } else {
      console.log(`MLX Console listening on 127.0.0.1:${uiPort} — run \`mlx-console url\` for the link.`)
    }
  }

  const shutdown = () => {
    clearUrlFile()
    void ui.stop().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.command === 'help') return void console.log(HELP)

  switch (args.command) {
    case 'serve':
      return serve(args.port)

    case 'start':
    case 'stop':
    case 'restart': {
      const server = new HeadlessServer(loadSettings())
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
      console.log(`helper:   ${findHelper(process.argv[1] ?? '') ?? 'not found'}`)
      return
    }

    default:
      console.error(`Unknown command: ${args.command}\n`)
      console.log(HELP)
      process.exitCode = 1
  }
}

// Only run when executed, so the pure exports above stay importable in tests.
if (process.argv[1] && /cli(\.[cm]?js|\.ts)?$/.test(process.argv[1])) {
  void main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
