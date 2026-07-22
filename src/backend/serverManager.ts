import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Emitter, disposeAll, type Disposable } from '../core/events'
import { log } from '../core/logging'
import { Config } from '../config'
import { mlxProcessEnv } from '../util/env'
import type { EnvironmentManager } from './environmentManager'
import { MlxClient } from './mlxClient'
import { buildServerArgs } from './serverArgs'
import {
  isUsableState,
  parseState,
  pidAlive,
  serializeState,
  type SharedServerState,
} from './serverRegistry'

export type ServerState = 'stopped' | 'starting' | 'ready' | 'error'

/**
 * Residency of weights inside the server process.
 *
 * `mlx_lm.server` keeps exactly one model live (`ModelProvider.model`) and
 * loads it lazily on the first request that names it. Loading happens inside
 * that request, so a switch stalls the first response for as long as the
 * weights take to read. There is no idle timeout or eviction: a model stays
 * resident until a different one displaces it or the process exits.
 */
export type ModelState = 'none' | 'loading' | 'loaded'

export interface ServerStatus {
  state: ServerState
  baseUrl: string
  activeModel?: string
  detail?: string
  /** Whether weights are resident, being read, or absent. */
  modelState: ModelState
  /** The model the server actually has in memory (confirmed by a response). */
  loadedModel?: string
  /** Epoch ms when the current load started — drives the elapsed counter. */
  loadStartedAt?: number
  /** Epoch ms when the resident model finished loading. */
  loadedAt?: number
  /** Seconds the last load took, for "switching takes ~N s" messaging. */
  lastLoadSeconds?: number
}

const READY_TIMEOUT_MS = 60_000
const READY_POLL_MS = 500
/** How long to wait for a clean exit before escalating to SIGKILL. */
const STOP_TIMEOUT_MS = 5000
const STOP_POLL_MS = 200

/** Spawns and supervises a single `mlx_lm.server` process and tracks its state. */
export class ServerManager {
  private proc: ChildProcess | undefined
  private _state: ServerState = 'stopped'
  private _activeModel: string | undefined
  private _detail: string | undefined
  private _modelState: ModelState = 'none'
  private _loadedModel: string | undefined
  private _loadStartedAt: number | undefined
  private _loadedAt: number | undefined
  private _lastLoadSeconds: number | undefined
  /** PID of a server this window did not spawn, learned from shared state. */
  private _externalPid: number | undefined
  private stateFile: string | undefined
  private readonly watcherSubs: Disposable[] = []
  private startPromise: Promise<boolean> | undefined

  private readonly _onDidChange = new Emitter<ServerStatus>()
  readonly onDidChange = this._onDidChange.event

  readonly client: MlxClient

  constructor(private readonly env: EnvironmentManager) {
    this.client = new MlxClient({
      baseUrl: () => this.baseUrl(),
      apiKey: () => Config.apiKey(),
    })
  }

  get state(): ServerState {
    return this._state
  }

  /** PID of the supervised server process, when we spawned it. */
  get pid(): number | undefined {
    return this.proc?.pid ?? this._externalPid
  }

  get activeModel(): string | undefined {
    return this._activeModel
  }

  get status(): ServerStatus {
    return {
      state: this._state,
      baseUrl: this.baseUrl(),
      activeModel: this._activeModel,
      detail: this._detail,
      modelState: this._modelState,
      loadedModel: this._loadedModel,
      loadStartedAt: this._loadStartedAt,
      loadedAt: this._loadedAt,
      lastLoadSeconds: this._lastLoadSeconds,
    }
  }

  /** The model currently resident in the server process, if any. */
  get loadedModel(): string | undefined {
    return this._loadedModel
  }

  get modelState(): ModelState {
    return this._modelState
  }

  /**
   * Call before a request is sent. If the target differs from what is resident,
   * the server will swap models inside that request — surface it as `loading`
   * so the UI can explain the stall instead of appearing hung.
   */
  beginModelUse(model: string): void {
    this.setActiveModel(model)
    if (this._loadedModel === model && this._modelState === 'loaded') return

    if (this._loadedModel && this._loadedModel !== model) {
      log.info(`Model switch: ${this._loadedModel} → ${model} (previous weights are dropped)`)
    } else {
      log.info(`Loading model ${model} into the server`)
    }
    this._modelState = 'loading'
    this._loadStartedAt = Date.now()
    this._loadedModel = undefined
    this._loadedAt = undefined
    this._onDidChange.fire(this.status)
  }

  /**
   * Point this manager at the file used to share server state across windows.
   * Adopts whatever is already recorded, then keeps watching for changes.
   */
  useSharedState(file: string): void {
    this.stateFile = file
    void this.adoptSharedState()

    // Watch the directory rather than the file: the file may not exist yet,
    // and an atomic rewrite replaces the inode a file watch was holding.
    const dir = path.dirname(file)
    try {
      fs.mkdirSync(dir, { recursive: true })
      const watcher = fs.watch(dir, (_event, name) => {
        if (name && name !== path.basename(file)) return
        if (fs.existsSync(file)) return void this.adoptSharedState()
        if (this.proc) return // we own it; our own state is authoritative
        this._modelState = 'none'
        this._loadedModel = undefined
        this._onDidChange.fire(this.status)
      })
      this.watcherSubs.push({ dispose: () => watcher.close() })
    } catch (err) {
      // Not fatal: without a watcher this window simply learns about another
      // window's model on its next read rather than immediately.
      log.warn(`Could not watch shared server state: ${String(err)}`)
    }
  }

  /** Take on the loaded-model state recorded by whichever window loaded it. */
  private async adoptSharedState(): Promise<void> {
    if (!this.stateFile || this.proc) return // owner's own state wins
    let text: string
    try {
      text = await fs.promises.readFile(this.stateFile, 'utf8')
    } catch {
      return
    }
    const shared = parseState(text)
    if (!isUsableState(shared, Config.serverPort(), pidAlive, Date.now())) return
    if (!shared?.loadedModel) return
    if (this._loadedModel === shared.loadedModel && this._modelState === 'loaded') return

    this._loadedModel = shared.loadedModel
    this._activeModel ??= shared.loadedModel
    this._modelState = 'loaded'
    this._loadedAt = shared.loadedAt
    this._lastLoadSeconds = shared.lastLoadSeconds
    this._externalPid = shared.pid
    log.info(`Adopted shared server state: ${shared.loadedModel} is loaded (pid ${shared.pid})`)
    this._onDidChange.fire(this.status)
  }

  /** Record our state so other windows can pick it up. */
  private async publishSharedState(): Promise<void> {
    if (!this.stateFile) return
    const state: SharedServerState = {
      pid: this.proc?.pid ?? this._externalPid,
      port: Config.serverPort(),
      loadedModel: this._loadedModel,
      loadedAt: this._loadedAt,
      lastLoadSeconds: this._lastLoadSeconds,
      updatedAt: Date.now(),
    }
    try {
      // Global storage is not created until something writes to it.
      await fs.promises.mkdir(path.dirname(this.stateFile), { recursive: true })
      await fs.promises.writeFile(this.stateFile, serializeState(state))
    } catch (err) {
      log.warn(`Could not publish shared server state: ${String(err)}`)
    }
  }

  /** Call on the first token of a response — proof the weights are resident. */
  confirmModelLoaded(model: string): void {
    if (this._modelState === 'loaded' && this._loadedModel === model) return
    const started = this._loadStartedAt
    this._lastLoadSeconds = started ? Math.round((Date.now() - started) / 100) / 10 : undefined
    this._modelState = 'loaded'
    this._loadedModel = model
    this._loadedAt = Date.now()
    this._loadStartedAt = undefined
    log.info(
      `Model ${model} resident${this._lastLoadSeconds !== undefined ? ` (loaded in ${this._lastLoadSeconds}s)` : ''}`,
    )
    this._onDidChange.fire(this.status)
    void this.publishSharedState()
  }

  /** A load that never completed (error/cancel) must not look resident. */
  abortModelLoad(): void {
    if (this._modelState !== 'loading') return
    this._modelState = this._loadedModel ? 'loaded' : 'none'
    this._loadStartedAt = undefined
    this._onDidChange.fire(this.status)
  }

  /** Base URL including the `/v1` suffix that clients POST to. */
  baseUrl(): string {
    return `http://${Config.clientHost()}:${Config.serverPort()}/v1`
  }

  /** The base URL to advertise to external tools (respects Expose to LAN). */
  advertisedBaseUrl(): string {
    const host = Config.exposeToLan() ? localIpOrHost() : Config.clientHost()
    return `http://${host}:${Config.serverPort()}/v1`
  }

  private setState(state: ServerState, detail?: string) {
    this._state = state
    this._detail = detail
    this._onDidChange.fire(this.status)
  }

  setActiveModel(model: string | undefined) {
    this._activeModel = model
    this._onDidChange.fire(this.status)
  }

  isRunning(): boolean {
    return this._state === 'ready' || this._state === 'starting'
  }

  /** Ensure the environment is ready and the server is up; returns true when reachable. */
  async ensureRunning(interactive = false): Promise<boolean> {
    if (this._state === 'ready') return true
    if (this.startPromise) return this.startPromise
    this.startPromise = this.start(interactive).finally(() => {
      this.startPromise = undefined
    })
    return this.startPromise
  }

  private async start(interactive: boolean): Promise<boolean> {
    const ready = await this.env.ensureReady(interactive)
    if (!ready) {
      this.setState('error', 'Environment not ready')
      return false
    }

    // If a server is already answering on this port (e.g. started externally), adopt it.
    if (await this.client.ping()) {
      this.setState('ready', 'Connected to existing server')
      return true
    }

    this.setState('starting')
    const bin = this.env.binPath('mlx_lm.server')
    // Shared with the headless CLI so the two cannot start the same server
    // with different flags.
    const args = buildServerArgs({
      bindHost: Config.bindHost(),
      port: Config.serverPort(),
      promptCacheSize: Config.promptCacheSize(),
      promptCacheBytes: Config.promptCacheBytes(),
      decodeConcurrency: Config.decodeConcurrency(),
      promptConcurrency: Config.promptConcurrency(),
      prefillStepSize: Config.prefillStepSize(),
      draftModel: Config.draftModel(),
      numDraftTokens: Config.numDraftTokens(),
      extraArgs: Config.serverExtraArgs(),
    })
    log.info(`Starting mlx_lm.server: ${bin} ${args.join(' ')}`)

    try {
      // `detached` gives the server its own process group so it survives the
      // extension host exiting. Without it the child shares our group and dies
      // with VSCode, unloading a model that took minutes to read.
      this.proc = spawn(bin, args, { env: mlxProcessEnv(), detached: true })
    } catch (err) {
      log.error('Failed to spawn mlx_lm.server', err)
      this.setState('error', String(err))
      return false
    }

    this.proc.stdout?.on('data', (d) => log.info(`[server] ${d.toString().trimEnd()}`))
    this.proc.stderr?.on('data', (d) => log.info(`[server] ${d.toString().trimEnd()}`))
    this.proc.on('exit', (code, signal) => {
      log.warn(`mlx_lm.server exited (code=${code}, signal=${signal})`)
      this.proc = undefined
      if (this._state !== 'stopped') {
        this.setState('error', `Server exited (code ${code ?? signal})`)
      }
    })

    const ok = await this.waitForReady()
    if (ok) {
      this.setState('ready')
      log.info('mlx_lm.server ready')
    } else {
      this.setState('error', 'Server did not become ready in time')
      await this.stop()
    }
    return ok
  }

  private async waitForReady(): Promise<boolean> {
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (!this.proc) return false // exited early
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), READY_POLL_MS)
      const ok = await this.client.ping(controller.signal)
      clearTimeout(t)
      if (ok) return true
      await delay(READY_POLL_MS)
    }
    return false
  }

  /**
   * Pre-warm a model so the first chat is fast. The server loads a model on the
   * first request that references it; a tiny completion triggers that load.
   */
  async warmUp(model: string): Promise<boolean> {
    if (!(await this.ensureRunning(false))) return false
    try {
      this.setActiveModel(model)
      await this.client.chat({ model, messages: [{ role: 'user', content: 'ok' }], max_tokens: 1 })
      return true
    } catch (err) {
      log.warn(`warmUp failed for ${model}`, err)
      return false
    }
  }

  /**
   * Stop the server and confirm it is actually gone.
   *
   * Two things went wrong with the naive version. It only acted when this
   * window had spawned the process, so a server adopted from another window was
   * left running while the UI showed "stopped". And it cleared the handle
   * immediately after SIGTERM, so a wedged process — one that has stopped
   * servicing requests but not exited — survived with its model still resident.
   *
   * So: resolve a pid from either source, ask politely, then insist.
   */
  async stop(): Promise<void> {
    const pid = this.proc?.pid ?? this._externalPid
    if (pid !== undefined) {
      log.info(`Stopping mlx_lm.server (pid ${pid})`)
      this.signal(pid, 'SIGTERM')

      // Give it a moment to shut down cleanly, then stop asking.
      const deadline = Date.now() + STOP_TIMEOUT_MS
      while (Date.now() < deadline && pidAlive(pid)) {
        await delay(STOP_POLL_MS)
      }
      if (pidAlive(pid)) {
        log.warn(`pid ${pid} ignored SIGTERM after ${STOP_TIMEOUT_MS}ms; sending SIGKILL`)
        this.signal(pid, 'SIGKILL')
        const hardDeadline = Date.now() + STOP_TIMEOUT_MS
        while (Date.now() < hardDeadline && pidAlive(pid)) {
          await delay(STOP_POLL_MS)
        }
      }
      if (pidAlive(pid)) {
        // Do not claim it stopped when it plainly has not.
        log.error(`pid ${pid} is still running after SIGKILL`)
        this.setState('error', `Server process ${pid} would not stop`)
        return
      }
      log.info(`mlx_lm.server (pid ${pid}) stopped`)
    }

    this.proc = undefined
    this._externalPid = undefined
    // Weights live in the server process, so stopping it frees everything.
    this._modelState = 'none'
    this._loadedModel = undefined
    this._loadStartedAt = undefined
    this._loadedAt = undefined
    this.setActiveModel(undefined)
    this.setState('stopped')
    void this.publishSharedState()
  }

  /** Signal a pid, tolerating a process that has already exited. */
  private signal(pid: number, sig: NodeJS.Signals): void {
    try {
      process.kill(pid, sig)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') {
        log.warn(`Could not send ${sig} to ${pid}: ${String(err)}`)
      }
    }
  }

  async restart(): Promise<boolean> {
    await this.stop()
    await delay(300)
    return this.ensureRunning(false)
  }

  dispose() {
    disposeAll(this.watcherSubs)
    // Deliberately does NOT stop the server. Closing a window should not unload
    // a model that took minutes to read — the process is shared across windows
    // and outlives any one of them. Stopping is an explicit user action.
    if (this.proc) {
      log.info(`Extension deactivating; leaving mlx_lm.server (pid ${this.proc.pid}) running`)
      this.proc.unref()
    }
    this._onDidChange.dispose()
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function localIpOrHost(): string {
  // Best-effort LAN address for display in external-client snippets.
  try {
    const os = require('node:os') as typeof import('node:os')
    const nets = os.networkInterfaces()
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] ?? []) {
        if (net.family === 'IPv4' && !net.internal) return net.address
      }
    }
  } catch {
    // ignore
  }
  return '0.0.0.0'
}
