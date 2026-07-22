import * as os from 'node:os'
import { log } from '../../core/logging'
import { settings } from '../../core/settings'
import { RootSampler } from '../../services/rootSampler'

/** How often the privileged sampler runs once authorised. */
const PROCESS_GPU_INTERVAL_MS = 20_000
import type { Disposable } from '../../core/events'
import { Config } from '../../config'
import { fitVerdict } from '../../services/modelFit'
import type { EnvironmentManager } from '../../backend/environmentManager'
import type { ServerManager } from '../../backend/serverManager'
import type { HuggingFaceService } from '../../services/huggingFaceService'
import type { CacheService } from '../../services/cacheService'
import type { DownloadManager } from '../../services/downloadManager'
import type { MetricsService } from '../../services/metricsService'
import { selectDraftModel, type DraftCandidate } from '../../services/modelConfig'
import { ModelConfigReader } from '../../services/modelConfigReader'
import {
  buildSettingsCatalog,
  coerceSettingValue,
  type ConfigProperty,
} from '../../services/settingsCatalog'
import type {
  EnvStatusLite,
  ExternalClientsInfo,
  HostBound,
  LocalModel,
  MachineProfile,
  ModelConfigView,
  ModelProfile,
  RpcMethod,
  SearchQuery,
  ServerStatusLite,
  SettingSpec,
  ViewId,
  WebviewBound,
} from '../../shared/protocol'

const FALLBACK_MODEL = 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit'

export interface HubDeps {
  env: EnvironmentManager
  server: ServerManager
  hf: HuggingFaceService
  cache: CacheService
  downloads: DownloadManager
  metrics: MetricsService
  /** The extension manifest, used to derive the settings catalog. */
  packageJSON: {
    version?: string
    contributes?: { configuration?: { properties?: Record<string, ConfigProperty> } }
  }
  extensionUri: { fsPath: string }
  /** How to ask the user things. Omitted in headless, where nobody is asked. */
  host?: HubHost
}

/**
 * The interactive acts the hub cannot perform by itself.
 *
 * Deleting weights, restarting a server holding 60 GB, or changing a kernel
 * memory limit all deserve a confirmation, and confirmation is the one thing
 * that has to come from the host: a modal in VSCode, a prompt on a terminal,
 * or — in the daemon, where nobody may be watching — a policy.
 *
 * Every member is optional. Missing `confirm` means "proceed", which is the
 * right default for a caller that already clicked a button in a UI that said
 * what it would do.
 */
export interface HubHost {
  confirm?(args: { message: string; detail: string; action: string }): Promise<boolean>
  reportError?(message: string): void
  reportInfo?(message: string): void
  /** Run a privileged command where the user can see it and type their own password. */
  runElevated?(command: string, title: string): boolean
  /** Show a long operation; the default just runs it. */
  progress?<T>(title: string, task: () => Promise<T>): Promise<T>
  /** Open a URL outside the app. */
  openExternal?(url: string): void
  copy?(text: string): Promise<void>
  /** VSCode opens its settings editor; other hosts have nowhere to go. */
  openSettings?(query?: string): void
  /** Model conversion is an interactive flow that lives in the extension. */
  convertModel?(repo: string): void
}

/** Nothing to ask, nothing to show: used when a host supplies no UI. */
const SILENT_HOST: HubHost = {}

/**
 * Anything that can receive a host→client message.
 *
 * The hub only ever calls `postMessage` on a webview, so typing it this way
 * lets a browser client on the local dashboard attach to the exact same
 * message bus — same RPCs, same pushes, no second implementation to keep in
 * step. `vscode.Webview` satisfies this structurally.
 */
export interface MessageSink {
  postMessage(message: unknown): unknown
}

/** Central message router shared by all MLX Console webview views. */
export class WebviewHub {
  private readonly webviews = new Set<MessageSink>()
  private readonly disposables: Disposable[] = []
  private readonly modelConfig = new ModelConfigReader()
  private readonly rootSampler = new RootSampler()
  private processGpuTimer: NodeJS.Timeout | undefined
  /** Guards against re-profiling on every status tick for the same model. */
  private lastProfiled: string | undefined

  constructor(private readonly deps: HubDeps) {
    this.disposables.push(
      deps.server.onDidChange(() => this.pushServerStatus()),
      deps.env.onDidChange(() => this.pushEnvStatus()),
      deps.downloads.onDidChange((items) => this.broadcast({ type: 'push', name: 'downloads', data: items })),
      deps.downloads.onDidComplete(() => void this.refreshModels()),
      deps.metrics.onDidSample((m) => this.broadcast({ type: 'push', name: 'metrics', data: m })),
      // Recompute everything model-derived whenever the resident model changes.
      deps.server.onDidChange((s) => {
        const id = s.loadedModel ?? s.activeModel
        if (!id || id === this.lastProfiled) return
        this.lastProfiled = id
        void this.pushModelProfile(id)
      }),
    )
  }

  /**
   * Raise or reset the GPU wired-memory ceiling.
   *
   * `sysctl` needs root, so this runs in a visible terminal where the user
   * types their own password — the extension never handles credentials, and
   * the exact command stays auditable. The setting is volatile and resets on
   * reboot.
   */
  private async setWiredLimit(megabytes: number): Promise<{ ok: boolean }> {
    if (!Number.isFinite(megabytes) || megabytes < 0) {
      this.host.reportError?.('MLX: wired memory limit must be a non-negative number.')
      return { ok: false }
    }
    const mb = Math.floor(megabytes)
    const totalMb = Math.floor(os.totalmem() / (1024 * 1024))
    const label = mb === 0 ? 'the system default' : `${mb} MB`

    const detail =
      mb === 0
        ? 'Resets iogpu.wired_limit_mb to 0, letting macOS choose the ceiling.'
        : `Sets iogpu.wired_limit_mb=${mb} (${(mb / 1024).toFixed(1)} GB) of ${(totalMb / 1024).toFixed(0)} GB total.\n\n` +
          'Leaving too little for macOS can cause severe swapping or a hang. ' +
          'The value resets on reboot.'

    const confirmed = await this.confirm({
      message: `Set GPU wired memory limit to ${label}?`,
      detail: `${detail}\n\nRuns in a terminal so you can enter your password.`,
      action: 'Open Terminal',
    })
    if (!confirmed) return { ok: false }
    // Never run with our own privileges: the command is shown, the user
    // authenticates, and no password passes through this process.
    const ran = this.host.runElevated?.(
      `sudo sysctl iogpu.wired_limit_mb=${mb}`,
      'MLX: GPU memory limit',
    )
    return { ok: ran ?? false }
  }

  /**
   * Free the resident model and its KV caches.
   *
   * `mlx_lm.server` exposes no cache-flush or unload endpoint — its only routes
   * are the completion POSTs, `/v1/models` and `/health`, and `ModelProvider`
   * drops weights only when a different model displaces them. Restarting the
   * process is therefore the only way to release either.
   */
  async unloadModel(): Promise<{ ok: boolean }> {
    const loaded = this.deps.server.loadedModel ?? this.deps.server.activeModel
    const confirmed = await this.confirm({
      message: loaded ? `Clear caches and reload ${loaded}?` : 'Restart the server to clear caches?',
      detail:
        'mlx_lm.server has no unload or cache-flush endpoint, so this restarts the ' +
        'process — the only way to release the KV caches. ' +
        (loaded
          ? 'The same model is then loaded back, which takes as long as the original load.'
          : 'The server comes back up idle.'),
      action: 'Clear and reload',
    })
    if (!confirmed) return { ok: false }

    await this.deps.server.stop()
    log.info('Caches cleared (server stopped)')

    if (!(await this.deps.server.ensureRunning(false))) {
      this.host.reportError?.('MLX: the server did not come back up.')
      return { ok: false }
    }
    // Bring the model back so "clear" does not silently leave you with nothing
    // loaded; warmUp triggers the lazy load rather than waiting for a request.
    if (loaded) {
      log.info(`Reloading ${loaded} after cache clear`)
      void this.withProgress(`MLX: reloading ${loaded}`, () => this.deps.server.warmUp(loaded))
    }
    return { ok: true }
  }

  /**
   * Recommend a draft model for speculative decoding from what is downloaded.
   *
   * The hard constraint is an identical vocabulary: a draft proposing token ids
   * from a different tokenizer produces garbage, so this matches `vocab_size`
   * exactly rather than guessing by model family.
   */
  private async suggestDraftModel(): Promise<{
    modelId?: string
    reason: string
    configured: string
  }> {
    const configured = Config.draftModel()
    const targetId = this.deps.server.loadedModel ?? this.deps.server.activeModel
    if (!targetId) {
      return { reason: 'No model selected yet.', configured }
    }

    const reader = this.modelConfig
    const local = this.deps.env.status.ready ? await this.safeScan() : []
    const describe = (id: string): DraftCandidate => ({
      modelId: id,
      vocabSize: reader.vocabSize(id),
      weightBytes: reader.weightBytes(id),
    })

    const metrics = await this.deps.metrics.sampleOnce().catch(() => undefined)
    const ceiling = metrics?.wiredLimitBytes ?? metrics?.gpu.maxRecommendedWorkingSetBytes
    const headroomBytes = ceiling
      ? Math.max(0, ceiling - (metrics?.gpu.inUseBytes ?? 0))
      : undefined

    const result = selectDraftModel({
      target: describe(targetId),
      candidates: local.map((m) => describe(m.repo)),
      headroomBytes,
    })
    return { ...result, configured }
  }

  /**
   * Forget cached model metadata and re-profile. Called when the models
   * directory changes, since every lookup path is derived from it.
   */
  refreshModelProfile(): void {
    this.modelConfig.clear()
    this.lastProfiled = undefined
    const current = this.deps.server.loadedModel ?? this.deps.server.activeModel
    if (current) {
      this.lastProfiled = current
      void this.pushModelProfile(current)
    }
  }

  /** Compact state for the local web dashboard. */
  async webUiState(): Promise<unknown> {
    const s = this.deps.server.status
    const m = await this.deps.metrics.sampleOnce().catch(() => undefined)
    return {
      serverState: s.state,
      loadedModel: s.loadedModel ?? s.activeModel,
      modelState: s.modelState,
      baseUrl: s.baseUrl,
      occupiedBytes: m?.occupiedBytes,
      ceilingBytes: m?.wiredLimitBytes ?? m?.gpu.maxRecommendedWorkingSetBytes,
      cpuPercent: m?.cpu.percent,
      gpuPercent: m?.gpu.utilizationPercent,
    }
  }

  /**
   * The three layers of generation config for one model, unmerged.
   *
   * Kept separate on purpose: seeing that temperature came from the model's own
   * `generation_config.json` rather than from you is the difference between
   * trusting the number and wondering about it.
   */
  private modelConfigView(repo: string): ModelConfigView {
    const fromModel = this.modelConfig.generationDefaults(repo) as Record<string, number>
    const overrides = settings().get<Record<string, Record<string, number>>>('modelOverrides', {})
    const global = Config.sampling() as unknown as Record<string, number>

    return {
      modelId: repo,
      override: overrides?.[repo] ?? {},
      fromModel,
      global,
      effective: Config.samplingFor(repo, fromModel) as unknown as Record<string, number>,
      contextWindow: this.modelConfig.contextLength(repo),
      kvBytesPerToken: this.modelConfig.kvBytesPerToken(repo),
      weightBytes: this.modelConfig.weightBytes(repo),
      vocabSize: this.modelConfig.vocabSize(repo),
    }
  }

  /**
   * Write one model's overrides.
   *
   * A key set to undefined is removed rather than stored as null, so "unset"
   * genuinely falls back to the model's own recommendation instead of pinning
   * a value the user never chose.
   */
  private async setModelConfig(
    repo: string,
    patch: Record<string, unknown>,
  ): Promise<{ ok: boolean; config?: ModelConfigView; error?: string }> {
    try {
      const all = {
        ...settings().get<Record<string, Record<string, unknown>>>('modelOverrides', {}),
      }
      const next = { ...(all[repo] ?? {}) }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === null || value === '') delete next[key]
        else next[key] = Number(value)
      }
      if (Object.keys(next).length) all[repo] = next
      else delete all[repo]

      await settings().update('modelOverrides', all)
      log.info(`Model config updated for ${repo}`)
      return { ok: true, config: this.modelConfigView(repo) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Read a model's own files and broadcast the result. */
  /**
   * Poll per-process GPU while the grant is in place.
   *
   * Twenty seconds, not two: the privileged command samples for a full second
   * of wall clock, so running it in the metrics loop would keep a child
   * process alive half the time.
   */
  private startProcessGpuPolling(intervalMs = PROCESS_GPU_INTERVAL_MS): void {
    if (this.processGpuTimer) return
    const tick = async () => {
      const res = await this.rootSampler.sample()
      this.broadcast({
        type: 'push',
        name: 'processGpu',
        data: { at: Date.now(), enabled: res.ok, samples: res.samples, error: res.error },
      })
      // A revoked grant should stop the timer rather than fail every 20s.
      if (!res.ok && !(await this.rootSampler.isEnabled())) this.stopProcessGpuPolling()
    }
    void tick()
    this.processGpuTimer = setInterval(() => void tick(), intervalMs)
  }

  private stopProcessGpuPolling(): void {
    if (!this.processGpuTimer) return
    clearInterval(this.processGpuTimer)
    this.processGpuTimer = undefined
    this.broadcast({ type: 'push', name: 'processGpu', data: { at: Date.now(), enabled: false } })
  }

  /** Refcounted metrics sampling, for hosts that tie it to visibility. */
  sampleMetrics(): Disposable {
    return this.deps.metrics.subscribe()
  }

  private get host(): HubHost {
    return this.deps.host ?? SILENT_HOST
  }

  /** Ask, when there is someone to ask; otherwise the caller already meant it. */
  private confirm(args: { message: string; detail: string; action: string }): Promise<boolean> {
    return this.host.confirm?.(args) ?? Promise.resolve(true)
  }

  private withProgress<T>(title: string, task: () => Promise<T>): Promise<T> {
    return this.host.progress ? this.host.progress(title, task) : task()
  }

  private async pushModelProfile(modelId: string): Promise<void> {
    try {
      const gen = this.modelConfig.generationDefaults(modelId)
      const profile: ModelProfile = {
        modelId,
        contextWindow: this.modelConfig.contextLength(modelId),
        vocabSize: this.modelConfig.vocabSize(modelId),
        weightBytes: this.modelConfig.weightBytes(modelId),
        kvBytesPerToken: this.modelConfig.kvBytesPerToken(modelId),
        generation: Object.keys(gen).length ? (gen as Record<string, number>) : undefined,
        draft: await this.suggestDraftModel(),
      }
      log.info(
        `Model profile for ${modelId}: context=${profile.contextWindow ?? '?'} ` +
          `vocab=${profile.vocabSize ?? '?'} draft=${profile.draft.modelId ?? 'none'}`,
      )
      this.broadcast({ type: 'push', name: 'modelProfile', data: profile })
    } catch (err) {
      log.warn(`Could not profile ${modelId}: ${String(err)}`)
    }
  }

  /** All contributed settings with their effective values. */
  settingsCatalog(): SettingSpec[] {
    return buildSettingsCatalog(
      this.deps.packageJSON.contributes?.configuration?.properties,
      (short) => settings().get(short, undefined),
    )
  }

  /**
   * Write one setting to the user (global) scope.
   *
   * Values are coerced against the declared type first so a malformed JSON
   * blob is reported rather than persisted.
   */
  async updateSetting(params: {
    key?: string
    value?: unknown
  }): Promise<{ ok: boolean; error?: string; settings?: SettingSpec[] }> {
    const key = params?.key
    if (typeof key !== 'string' || !key.startsWith('mlxConsole.')) {
      return { ok: false, error: 'Unknown setting.' }
    }
    const spec = this.settingsCatalog().find((s) => s.key === key)
    if (!spec) return { ok: false, error: `Unknown setting: ${key}` }

    const coerced = coerceSettingValue(spec, params.value)
    if (!coerced.ok) return { ok: false, error: coerced.error }

    try {
      await settings().update(spec.short, coerced.value)
      log.info(`Setting updated: ${key}`)
      return { ok: true, settings: this.settingsCatalog() }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      log.error(`Failed to update ${key}`, err)
      return { ok: false, error }
    }
  }

  /**
   * Attach a non-webview client (the local dashboard in a browser).
   *
   * Returns a detach function. Metrics sampling is subscribed for as long as
   * the client is connected, the same bargain the panel makes when visible.
   */
  attach(sink: MessageSink): () => void {
    const sub = this.connect(sink)
    return () => sub.dispose()
  }

  /** Handle one client→host message. Public so non-webview clients can route. */
  handleMessage(sink: MessageSink, raw: unknown): Promise<void> {
    return this.onMessage(sink, raw)
  }

  /**
   * Connect a client that manages its own lifetime.
   *
   * Returns a disposer. Metrics sampling is tied to the connection rather than
   * subscribed globally, so a collapsed panel or a closed browser tab costs
   * nothing — which is the whole reason the sampler is refcounted.
   */
  connect(sink: MessageSink, opts: { sampleMetrics?: boolean } = {}): Disposable {
    this.webviews.add(sink)
    const metricsSub = opts.sampleMetrics === false ? undefined : this.deps.metrics.subscribe()
    return {
      dispose: () => {
        this.webviews.delete(sink)
        metricsSub?.dispose()
      },
    }
  }

  private broadcast(msg: WebviewBound) {
    for (const w of this.webviews) void w.postMessage(msg)
  }

  private async onMessage(webview: MessageSink, raw: unknown) {
    const m = raw as HostBound
    switch (m.type) {
      case 'ready':
        await this.sendInitial(webview)
        break
      case 'openExternal':
        this.host.openExternal?.(m.url)
        break
      case 'copy':
        await this.host.copy?.(m.text)
        this.host.reportInfo?.('Copied to clipboard')
        break
      case 'openSettings':
        this.host.openSettings?.(m.query)
        break
      case 'rpc':
        try {
          const result = await this.handleRpc(m.method, m.params)
          void webview.postMessage({ type: 'rpcResult', id: m.id, ok: true, result })
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          void webview.postMessage({ type: 'rpcResult', id: m.id, ok: false, error })
        }
        break
    }
  }

  private async handleRpc(method: RpcMethod, params: unknown): Promise<unknown> {
    const repoOf = () => (params as { repo: string }).repo
    switch (method) {
      case 'search': {
        const query = params as SearchQuery
        const budget = this.machine().budgetBytes
        let results = (await this.deps.hf.search(query)).map((m) => ({
          ...m,
          fit: fitVerdict(m.sizeBytes, budget),
        }))
        if (query.onlyFits) results = results.filter((m) => m.fit !== 'too-large')
        const limit = query.limit ?? 30
        return {
          items: results.slice(0, limit),
          total: results.length,
          truncated: results.length > limit,
        }
      }
      case 'getMachine':
        return this.machine()
      case 'convertModel':
        this.host.convertModel?.(repoOf())
        return { ok: true }
      case 'getModelSize':
        return this.deps.hf.getModelSize(repoOf())
      case 'getModelSizes': {
        const repos = (params as { repos?: string[] }).repos ?? []
        const sizes = await this.deps.hf.getModelSizes(repos)
        const budget = this.machine().budgetBytes
        return Object.fromEntries(
          Object.entries(sizes).map(([repo, bytes]) => [
            repo,
            { bytes, fit: fitVerdict(bytes, budget) },
          ]),
        )
      }
      case 'listModels':
        return this.deps.env.status.ready ? this.deps.cache.list() : []
      case 'deleteModel': {
        const repo = repoOf()
        const confirmed = await this.confirm({
          message: `Delete "${repo}" from the model cache?`,
          detail: 'This permanently removes the downloaded files from disk.',
          action: 'Delete',
        })
        if (!confirmed) return { ok: false, canceled: true }
        const res = await this.deps.cache.delete(repo)
        await this.refreshModels()
        this.host.reportInfo?.(`MLX: deleted ${repo} (freed ${formatBytes(res.freedBytes)}).`)
        return { ok: true, ...res }
      }
      case 'startDownload':
        void this.deps.downloads.start(repoOf())
        return { ok: true }
      case 'cancelDownload':
        this.deps.downloads.cancel(repoOf())
        return { ok: true }
      case 'launchModel': {
        const ok = await this.deps.server.warmUp(repoOf())
        return { ok }
      }
      case 'setDefaultModel':
        await settings().update('defaultModel', repoOf())
        this.pushServerStatus()
        return { ok: true }
      case 'getModelConfig':
        return this.modelConfigView(repoOf())
      case 'setModelConfig': {
        const { repo, patch } = params as { repo: string; patch: Record<string, unknown> }
        return this.setModelConfig(repo, patch)
      }
      case 'startServer':
        return { ok: await this.deps.server.ensureRunning(true) }
      case 'stopServer':
        await this.deps.server.stop()
        return { ok: true }
      case 'restartServer':
        return { ok: await this.deps.server.restart() }
      case 'getServerStatus':
        return this.serverStatusLite()
      case 'getEnvStatus':
        return this.envStatusLite()
      case 'getExternalClients':
        return this.externalClients()
      case 'runSetup': {
        const ok = await this.deps.env.ensureReady(true)
        this.pushEnvStatus()
        return { ok }
      }
      case 'getSettings':
        return this.settingsCatalog()
      case 'updateSetting':
        return this.updateSetting(params as { key?: string; value?: unknown })
      case 'unloadModel':
        return this.unloadModel()
      case 'getMetrics':
        return this.deps.metrics.sampleOnce()
      case 'suggestDraftModel':
        return this.suggestDraftModel()
      case 'samplePerProcessGpu':
        return this.deps.metrics.samplePerProcessGpu()
      case 'rootGpuStatus':
        return { enabled: await this.rootSampler.isEnabled() }
      case 'enableRootGpu': {
        // Used here and nowhere else: not stored, not logged, not echoed back.
        const secret = String((params as { secret?: unknown })?.secret ?? '')
        if (!secret) return { ok: false, error: 'An account credential is required.' }
        const res = await this.rootSampler.enable(secret)
        if (res.ok) this.startProcessGpuPolling()
        return res
      }
      case 'disableRootGpu': {
        const given = (params as { secret?: unknown })?.secret
        const res = await this.rootSampler.disable(
          typeof given === 'string' && given ? given : undefined,
        )
        if (res.ok) this.stopProcessGpuPolling()
        return res
      }
      case 'setWiredLimit':
        return this.setWiredLimit(Number((params as { megabytes?: unknown })?.megabytes))
      default:
        throw new Error(`Unknown method: ${method}`)
    }
  }

  private async sendInitial(webview: MessageSink) {
    void webview.postMessage({ type: 'push', name: 'serverStatus', data: this.serverStatusLite() })
    void webview.postMessage({ type: 'push', name: 'envStatus', data: this.envStatusLite() })
    void webview.postMessage({ type: 'push', name: 'downloads', data: this.deps.downloads.list() })
    const models = await this.safeScan()
    void webview.postMessage({ type: 'push', name: 'models', data: models })
    const current = this.deps.server.loadedModel ?? this.deps.server.activeModel
    if (current) void this.pushModelProfile(current)
  }

  /** Unified-memory profile used to judge whether a model fits this machine. */
  private machine(): MachineProfile {
    const totalRamBytes = os.totalmem()
    return {
      totalRamBytes,
      // macOS reserves memory for the system; ~75% is a realistic ceiling for weights + runtime.
      budgetBytes: Math.floor(totalRamBytes * 0.75),
      cores: os.cpus().length,
    }
  }

  /** Re-push config-dependent status (call after settings change). */
  refreshStatus() {
    this.pushServerStatus()
    this.pushEnvStatus()
  }

  private pushServerStatus() {
    this.broadcast({ type: 'push', name: 'serverStatus', data: this.serverStatusLite() })
  }

  private pushEnvStatus() {
    this.broadcast({ type: 'push', name: 'envStatus', data: this.envStatusLite() })
  }

  private async refreshModels() {
    this.broadcast({ type: 'push', name: 'models', data: await this.safeScan() })
  }

  private async safeScan(): Promise<LocalModel[]> {
    if (!this.deps.env.status.ready) return []
    try {
      return await this.deps.cache.list()
    } catch (err) {
      log.warn('cache scan failed', err)
      return []
    }
  }

  private serverStatusLite(): ServerStatusLite {
    const s = this.deps.server.status
    return {
      state: s.state,
      baseUrl: s.baseUrl,
      advertisedBaseUrl: this.deps.server.advertisedBaseUrl(),
      activeModel: s.activeModel,
      detail: s.detail,
      exposeToLan: Config.exposeToLan(),
      hasApiKey: Boolean(Config.apiKey()),
      modelState: s.modelState,
      loadedModel: s.loadedModel,
      loadStartedAt: s.loadStartedAt,
      lastLoadSeconds: s.lastLoadSeconds,
    }
  }

  private envStatusLite(): EnvStatusLite {
    const s = this.deps.env.status
    return {
      extensionVersion: this.deps.packageJSON.version ?? 'dev',
      ready: s.ready,
      platformOk: s.platformOk,
      message: s.message,
      mlxVersion: s.mlxVersion,
      venvPath: s.venvPath,
      modelsDir: Config.modelsDir() || '~/.cache/huggingface (default)',
    }
  }

  private externalClients(): ExternalClientsInfo {
    const baseUrl = this.deps.server.advertisedBaseUrl()
    const model = this.deps.server.activeModel || Config.defaultModel() || FALLBACK_MODEL
    const hasApiKey = Boolean(Config.apiKey())
    const opencode = JSON.stringify(
      {
        provider: {
          mlx: {
            npm: '@ai-sdk/openai-compatible',
            name: 'MLX (local)',
            options: { baseURL: baseUrl },
            models: { [model]: {} },
          },
        },
      },
      null,
      2,
    )
    const copilot = [
      'GitHub Copilot Chat → model picker → Manage Models → Add provider',
      'Provider type: OpenAI-compatible',
      `Base URL: ${baseUrl}`,
      `API key: ${hasApiKey ? '(your configured key)' : 'any non-empty value'}`,
      '',
      'Note: BYOK in VS Code needs a Copilot Business/Enterprise seat.',
      'Otherwise just pick the "MLX (local)" models already in the model picker.',
    ].join('\n')
    return {
      baseUrl,
      activeModel: this.deps.server.activeModel,
      hasApiKey,
      exposeToLan: Config.exposeToLan(),
      snippets: { opencode, copilot },
    }
  }

  dispose() {
    this.stopProcessGpuPolling()
    for (const d of this.disposables) d.dispose()
  }
}

function formatBytes(n: number): string {
  if (!n || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}
