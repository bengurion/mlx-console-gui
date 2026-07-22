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
import { spawn } from 'node:child_process'
import { buildServerArgs } from '../backend/serverArgs'
import { isUsableState, parseState, pidAlive, type SharedServerState } from '../backend/serverRegistry'
import { resolveVenv, venvBin, venvCandidates, userDirs, EXTENSION_ID } from './hostPaths'
import type { SettingsStore } from './settingsStore'

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
  return userDirs(home).map((d) =>
    path.join(d, 'globalStorage', EXTENSION_ID, 'server-state.json'),
  )
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

export class HeadlessServer {
  constructor(private readonly settings: SettingsStore) {}

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
    const proc = spawn(bin, args, { env: this.env(), detached: true, stdio: 'ignore' })
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

  /** Same environment the extension gives the server, minus the VSCode APIs. */
  private env(): NodeJS.ProcessEnv {
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
