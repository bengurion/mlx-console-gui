/**
 * Starting, stopping and inspecting mlx_lm.server without VSCode.
 *
 * Deliberately shares the extension's registry file and argument builder, so
 * the CLI and the extension see the same server rather than each starting
 * their own. Whichever one is running, the other adopts what it finds.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { buildServerArgs } from '../backend/serverArgs.ts'
import { isUsableState, parseState, pidAlive, type SharedServerState } from '../backend/serverRegistry.ts'
import { resolveVenv, venvBin, venvCandidates, userDirs, STORAGE_IDS } from './hostPaths.ts'
import { readInstallRoot } from './installRoot.ts'
import type { SettingsStore } from './settingsStore.ts'

/** How long a SIGTERM gets before SIGKILL. Matches the extension. */
export const STOP_TIMEOUT_MS = 5000

export interface HeadlessStatus {
  state: 'stopped' | 'ready'
  pid?: number
  port: number
  loadedModel?: string
  loadedAt?: number
  venv?: string
}

/** The extension writes its shared state here; the CLI reads the same file. */
export function stateFileCandidates(home = os.homedir()): string[] {
  // The install root first: once the desktop app owns the runtime, its
  // registry is the one every front end should adopt.
  const root = readInstallRoot(home)
  const fromRoot = root ? [path.join(root, 'server-state.json')] : []
  return [
    ...fromRoot,
    ...userDirs(home).flatMap((d) =>
      STORAGE_IDS.map((id) => path.join(d, 'globalStorage', id, 'server-state.json')),
    ),
  ]
}

export function readSharedState(files: string[]): SharedServerState | undefined {
  for (const f of files) {
    try {
      const s = parseState(fs.readFileSync(f, 'utf8'))
      if (s) return s
    } catch {
      // Missing or unreadable: try the next editor's storage.
    }
  }
  return undefined
}

/**
 * Every `mlx_lm.server` running for this user, however it was started.
 *
 * The registry only records the server we last knew about. Servers are spawned
 * detached so they survive the window that started them — which is deliberate,
 * but it means a crashed or timed-out owner leaves one reparented to init with
 * nobody tracking it. Those orphans hold the port and quietly hold gigabytes,
 * so cleaning up has to be able to find them by what they are, not by what we
 * remembered.
 */
export function findServerPids(): Promise<number[]> {
  return new Promise((resolve) => {
    // -f matches the full command line; the binary itself is a python shim.
    execFile('pgrep', ['-f', 'mlx_lm.server'], (err, stdout) => {
      if (err && !stdout) return resolve([])
      resolve(parsePgrepPids(stdout, process.pid))
    })
  })
}

/**
 * Pids from pgrep output, excluding our own.
 *
 * `pgrep -f mlx_lm.server` matches on the whole command line, so a process
 * whose arguments merely mention it — this CLI, a grep, an editor — would
 * match too. Excluding self is the one case that is both certain and fatal:
 * killing it mid-shutdown would leave the very orphans this is cleaning up.
 */
export function parsePgrepPids(stdout: string, selfPid: number): number[] {
  return stdout
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== selfPid)
}

/** Signal a pid, reporting whether it was there to signal. */
function signal(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig)
    return true
  } catch {
    return false
  }
}

export class HeadlessServer {
  private readonly settings: SettingsStore

  constructor(settings: SettingsStore) {
    this.settings = settings
  }

  get port(): number {
    const n = Number(this.settings.get('server.port', 8080))
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8080
  }

  private bindHost(): string {
    return this.settings.get<boolean>('server.exposeToLan', false)
      ? '0.0.0.0'
      : this.settings.get<string>('server.host', '127.0.0.1')
  }

  venv(): string | undefined {
    return resolveVenv({
      configured: this.settings.get<string>('venvPath', ''),
      candidates: venvCandidates(),
      exists: (p) => fs.existsSync(p),
    })
  }

  /** Is anything answering on the port? The only reliable liveness test. */
  async ping(timeoutMs = 1500): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/v1/models`, {
        signal: AbortSignal.timeout(timeoutMs),
      })
      return res.ok
    } catch {
      return false
    }
  }

  async status(): Promise<HeadlessStatus> {
    const up = await this.ping()
    const shared = readSharedState(stateFileCandidates())
    const usable = isUsableState(shared, this.port, pidAlive, Date.now())
    return {
      state: up ? 'ready' : 'stopped',
      pid: usable ? shared?.pid : undefined,
      port: this.port,
      loadedModel: up && usable ? shared?.loadedModel : undefined,
      loadedAt: up && usable ? shared?.loadedAt : undefined,
      venv: this.venv(),
    }
  }

  /** Start the server unless one is already answering. */
  async start(): Promise<{ ok: boolean; message: string }> {
    if (await this.ping()) return { ok: true, message: 'Already running — adopted it.' }

    const venv = this.venv()
    if (!venv) {
      return {
        ok: false,
        message:
          'No mlx-lm environment found. Run MLX: Setup in VS Code once, or set venvPath in ~/.mlx-console/config.json.',
      }
    }
    const bin = venvBin(venv, 'mlx_lm.server')
    if (!fs.existsSync(bin)) return { ok: false, message: `Not found: ${bin}` }

    const args = buildServerArgs({
      bindHost: this.bindHost(),
      port: this.port,
      promptCacheSize: num(this.settings.get('server.promptCacheSize')),
      promptCacheBytes: num(this.settings.get('server.promptCacheBytes')),
      decodeConcurrency: num(this.settings.get('server.decodeConcurrency')),
      promptConcurrency: num(this.settings.get('server.promptConcurrency')),
      prefillStepSize: num(this.settings.get('server.prefillStepSize')),
      draftModel: this.settings.get<string>('server.draftModel', ''),
      numDraftTokens: num(this.settings.get('server.numDraftTokens')),
      extraArgs: this.settings.get<string[]>('server.extraArgs', []),
    })

    // Detached, as in the extension: the server outlives whatever started it.
    const proc = spawn(bin, args, { env: this.processEnv(), detached: true, stdio: 'ignore' })
    proc.unref()
    return { ok: true, message: `Started mlx_lm.server (pid ${proc.pid}) on port ${this.port}.` }
  }

  async stop(): Promise<{ ok: boolean; message: string }> {
    const shared = readSharedState(stateFileCandidates())
    const pid = isUsableState(shared, this.port, pidAlive, Date.now()) ? shared?.pid : undefined
    if (pid === undefined) {
      return (await this.ping())
        ? { ok: false, message: 'A server is answering but its pid is unknown — stop it from VS Code.' }
        : { ok: true, message: 'Not running.' }
    }

    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      return { ok: true, message: 'Already gone.' }
    }
    const deadline = Date.now() + STOP_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (!pidAlive(pid)) return { ok: true, message: `Stopped (pid ${pid}).` }
      await new Promise((r) => setTimeout(r, 200))
    }
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Raced us to exit.
    }
    return { ok: true, message: `Force-stopped (pid ${pid}).` }
  }

  async restart(): Promise<{ ok: boolean; message: string }> {
    await this.stop()
    return this.start()
  }

  /**
   * Stop every mlx_lm.server, including ones nothing is tracking.
   *
   * Politely first, then not: a server mid-load ignores SIGTERM until it
   * finishes reading weights, and waiting minutes for that is not what someone
   * asking to shut everything down wants.
   */
  async stopAll(): Promise<{ stopped: number[]; forced: number[] }> {
    const pids = await findServerPids()
    const stopped: number[] = []
    const forced: number[] = []
    if (!pids.length) return { stopped, forced }

    for (const pid of pids) signal(pid, 'SIGTERM')

    const deadline = Date.now() + STOP_TIMEOUT_MS
    let remaining = pids
    while (remaining.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200))
      const gone = remaining.filter((pid) => !pidAlive(pid))
      stopped.push(...gone)
      remaining = remaining.filter((pid) => pidAlive(pid))
    }
    for (const pid of remaining) {
      if (signal(pid, 'SIGKILL')) forced.push(pid)
    }
    return { stopped, forced }
  }

  /**
   * Same environment the extension gives the server, minus the VSCode APIs.
   *
   * Public because the Python helper needs the identical HF_HOME: it scans
   * whatever `modelsDir` points at, and a helper pointed somewhere else would
   * report a different set of models than the server can actually load.
   */
  processEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env }
    const modelsDir = this.settings.get<string>('modelsDir', '').trim()
    if (modelsDir) {
      // huggingface_hub raises CacheNotFound when scanning a missing directory.
      fs.mkdirSync(path.join(modelsDir, 'hub'), { recursive: true })
      env.HF_HOME = modelsDir
    }
    const token = this.settings.get<string>('huggingFace.token', '').trim()
    if (token) {
      env.HF_TOKEN = token
      env.HUGGING_FACE_HUB_TOKEN = token
    }
    return env
  }
}

function num(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}
