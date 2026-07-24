/**
 * mlx-console — the extension's dashboard and server control, without VSCode.
 *
 * The extension host is a convenient place to run this, not a necessary one:
 * everything the dashboard needs is a process, a settings file and some
 * `ioreg`/`vm_stat` output. This entry point wires the same components to a
 * terminal instead, and shares the registry file so the two adopt each other's
 * server rather than fighting over the port. The assembly itself lives in
 * daemon.ts, shared with the desktop app.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import pkg from '../../package.json'
import { occupancyBytes } from '../services/modelConfig'
import { HeadlessServer } from './serverControl'
import { settingsCandidates } from './hostPaths'
import { buildPlist, loadCommands, plistPath, unloadCommands, logPaths } from './launchd'
import { parseArgs } from './args'
import { setLogSink } from '../core/logging'
import { findBundle, findHelper, selfPath } from './pythonBridge'
import { URL_FILE, createDaemon, loadSettings, metrics, pythonBridge } from './daemon'

const run = promisify(execFile)

const HELP = `mlx-console ${pkg.version} — MLX Console GUI without VS Code

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

/** How long a graceful exit waits before quitting regardless. */
const STOP_ALL_TIMEOUT_MS = 8000

async function serve(port?: number, keepServer = false): Promise<void> {
  const daemon = createDaemon({ settings: loadSettings(), port, log })
  const url = await daemon.start()
  if (!url) {
    process.exitCode = 1
    return
  }

  if (process.stdout.isTTY) {
    console.log(`\n  MLX Console GUI — ${url}\n`)
    console.log('  Settings: ~/.mlx-console/config.json')
    console.log(
      keepServer
        ? '  Ctrl-C stops the dashboard; the model server keeps running.\n'
        : '  Ctrl-C stops the dashboard and the model server (--keep-server to leave it up).\n',
    )
  } else {
    // The port actually bound, not the one asked for — they differ whenever
    // something else already had it. With a token configured the URL is a
    // credential, and under launchd stdout is a 0644 log file, so the link
    // itself stays in the 0600 url file.
    console.log(
      `MLX Console GUI listening on 127.0.0.1:${new URL(url).port} — run \`mlx-console url\` for the link.`,
    )
  }

  const shutdown = () => {
    const done = () => process.exit(0)
    void daemon.stop({ keepServer }).then(done)
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
