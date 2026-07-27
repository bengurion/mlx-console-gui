import * as os from 'node:os'
import * as fs from 'node:fs'
import { log } from '../../core/logging'
import { applyToEditor, desiredEnv, detectEditors } from '../../services/vscodeIntegration'
import { settings } from '../../core/settings'
import { RootSampler } from '../../services/rootSampler'
import { manualCommand } from '../../services/rootAccess'

/** How often the privileged sampler runs once authorised. */
const PROCESS_GPU_INTERVAL_MS = 20_000
import type { Disposable } from '../../core/events'
import { Config } from '../../config'
import { bytesForBits, fitVerdict } from '../../services/modelFit'
import { staleNotice } from './buildStamp'
import type { EnvironmentManager } from '../../backend/environmentManager'
import type { ServerManager } from '../../backend/serverManager'
import type { HuggingFaceService } from '../../services/huggingFaceService'
import type { CacheService } from '../../services/cacheService'
import type { DownloadManager } from '../../services/downloadManager'
import type { ConvertManager } from '../../services/convertManager'
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
  VsCodeIntegrationApplyParams,
  VsCodeIntegrationInfo,
  VsCodeIntegrationResult,
  WebviewBound,
} from '../../shared/protocol'

const FALLBACK_MODEL = 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit'

/** Pipelines mlx-lm cannot serve — embedding models and kin. */
const EMBEDDING_PIPELINES = new Set([
  'feature-extraction',
  'sentence-similarity',
  'fill-mask',
  'text-classification',
  'token-classification',
  'zero-shot-classification',
])


export interface HubDeps {
  env: EnvironmentManager
  server: ServerManager
  hf: HuggingFaceService
  cache: CacheService
  downloads: DownloadManager
  convert: ConvertManager
  metrics: MetricsService
  /** The extension manifest, used to derive the settings catalog. */
  packageJSON: {
    version?: string
    contributes?: { configuration?: { properties?: Record<string, ConfigProperty> } }
  }
  extensionUri: { fsPath: string }
  /** URL of the harmony-filtering endpoint, when the host runs one. */
  cleanEndpointUrl?(): string | undefined
  /**
   * Which `mlxConsole.*` keys the VS Code cleanup may remove.
   *
   * Only the daemon supplies this: for it, keys in the editor's settings.json
   * are stale remnants. For the embedded extension they are live
   * configuration, so it must not offer to strip them — leaving this unset
   * limits cleanup to the retired `mlxServe.*` prefix.
   */
  vscodeCleanupKeys?(): string[]
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

/** Central message router shared by all MLX Console GUI webview views. */
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
      deps.convert.onDidChange((items) => this.broadcast({ type: 'push', name: 'converts', data: items })),
      // A converted model is a new local model; the Models page should not need
      // a manual refresh to see what the user just spent an hour making.
      deps.convert.onDidComplete(() => void this.refreshModels()),
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
        data: {
          at: Date.now(),
          enabled: res.ok,
          samples: res.samples,
          power: res.power,
          error: res.error,
        },
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
      // A value equal to the default is stored as *unset*, not as an explicit
      // copy of it: explicitly-set settings override per-model recommendations
      // (generation_config defaults), so Reset must truly return to "unset".
      const value =
        JSON.stringify(coerced.value) === JSON.stringify(spec.default) ? undefined : coerced.value
      await settings().update(spec.short, value)
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
        // A page from a different build than this process may send fields this
        // host has never heard of, which it would drop without complaint.
        {
          const stale = staleNotice(m.build)
          if (stale) void webview.postMessage({ type: 'push', name: 'stale', data: stale })
        }
        await this.sendInitial(webview)
        break
      case 'openExternal':
        this.host.openExternal?.(m.url)
        break
      case 'copy':
        await this.host.copy?.(m.text)
        this.host.reportInfo?.('Copied to clipboard')
        break
      case 'openSettings': {
        // Two halves: the host brings its settings view forward (a focused
        // panel in VSCode, a tab switch in the browser), and the push tells
        // that view which setting to reveal once it is there.
        const short = (m.query ?? '').replace(/^mlxConsole\./, '')
        this.host.openSettings?.(m.query)
        this.broadcast({ type: 'push', name: 'revealSetting', data: { short } })
        break
      }
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
        const found = await this.deps.hf.search(query)
        // Fit is the one filter the service cannot apply: it depends on this
        // machine's memory, which is the host's knowledge, not the Hub's.
        // A convertible repo is judged by what conversion would produce, not
        // by its full-precision bytes — the 70B bf16 that "doesn't fit" is
        // the archetypal convert candidate, and hiding it defeated the point.
        let results = found.items.map((m) => {
          // mlx-lm implements text generation only. The README long promised
          // that embedding repos say so on their card; the pipeline tag was
          // fetched all along and never read.
          const embedding = m.pipelineTag !== undefined && EMBEDDING_PIPELINES.has(m.pipelineTag)
          const format = embedding && m.format !== 'mlx' ? ('unsupported' as const) : m.format
          const convertBytes =
            format === 'convertible' && m.paramsB ? bytesForBits(m.paramsB, 4) : undefined
          const basis = convertBytes !== undefined ? Math.min(m.sizeBytes ?? Infinity, convertBytes) : m.sizeBytes
          return {
            ...m,
            format,
            fit: fitVerdict(Number.isFinite(basis) ? basis : undefined, budget),
            fitBasis: convertBytes !== undefined ? ('4bit' as const) : ('as-is' as const),
          }
        })
        if (query.onlyFits) results = results.filter((m) => m.fit !== 'too-large')
        const limit = query.limit ?? 30
        return {
          items: results.slice(0, limit),
          total: results.length,
          truncated: results.length > limit,
          // Counted over the full filtered set: computing these from the
          // sliced page next to the unsliced total mixed two scopes.
          mlxTotal: results.filter((m) => m.format === 'mlx').length,
          convertibleTotal: results.filter((m) => m.format === 'convertible').length,
          scanned: found.scanned,
          exhausted: found.exhausted,
        }
      }
      case 'getMachine':
        return this.machine()
      case 'getConvertPlan': {
        // The Hub's exact parameter count beats parsing "7B" out of the name;
        // cached after the first ask, and the name-guess remains the fallback.
        const repo = repoOf()
        const [paramsB, facts] = await Promise.all([
          this.deps.hf.getParamsB(repo),
          this.deps.hf.getConfigFacts(repo),
        ])
        // mlx-lm itself answers whether the architecture exists; unanswerable
        // (env not ready, config missing) means no gate rather than a refusal.
        const supported = facts.modelType
          ? await this.deps.cache.archSupported(facts.modelType).catch(() => undefined)
          : undefined
        return this.deps.convert.plan(repo, paramsB, {
          modelType: facts.modelType,
          supported,
          prequantized: facts.prequantized,
        })
      }
      case 'convertModel': {
        const { repo, bits } = params as { repo: string; bits?: number }
        return this.deps.convert.start(repo, bits)
      }
      case 'cancelConvert':
        this.deps.convert.cancel(repoOf())
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
      case 'topProcesses':
        return this.deps.env.status.ready ? this.deps.cache.top() : { processes: [] }
      case 'deleteModel': {
        const repo = repoOf()
        // Deleting under a live worker tears the directory out from beneath
        // it — the helper recreates files and the "freed" number is a lie.
        if (this.deps.downloads.isActive(repo)) {
          return { ok: false, error: 'This repo is downloading — cancel the download first.' }
        }
        if (this.deps.convert.isActive(repo)) {
          return { ok: false, error: 'This repo is converting — cancel the conversion first.' }
        }
        const isPath = repo.startsWith('/')
        const resident = this.deps.server.loadedModel === repo
        const isDefault = Config.defaultModel() === repo
        const confirmed = await this.confirm({
          message: isPath ? `Delete the converted model at ${repo}?` : `Delete "${repo}" from the model cache?`,
          detail:
            'This permanently removes the files from disk.' +
            (resident ? ' It is the RESIDENT model — the server keeps serving it from memory until restarted.' : '') +
            (isDefault ? ' It is also your default model; clear or change that setting after.' : ''),
          action: 'Delete',
        })
        if (!confirmed) return { ok: false, canceled: true }
        const res = await this.deps.cache.delete(repo)
        // The record of having downloaded/converted it goes with the files —
        // a "Complete" card pointing at a deleted directory helped nobody.
        this.deps.downloads.remove(repo)
        this.deps.convert.removeByOutput?.(repo)
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
      case 'dismissDownload':
        this.deps.downloads.remove(repoOf())
        return { ok: true }
      case 'dismissConvert': {
        const p = params as { repo: string; bits?: number }
        this.deps.convert.remove(p.repo, p.bits)
        return { ok: true }
      }
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
      case 'samplePerProcessGpu': {
        /*
         * One path, not two. This used to run the metrics service's own
         * elevation attempt, which in a browser could only ever come back
         * "needs auth" — so the button and the 20-second poll disagreed about
         * whether sampling was possible. Both now go through the sampler that
         * the one-time authorisation actually enables.
         */
        if (!(await this.rootSampler.isEnabled())) return { ok: false, needsAuth: true }
        const res = await this.rootSampler.sample()
        // A manual sample is also a good moment to start the timer, if the
        // grant was installed outside this session.
        if (res.ok) this.startProcessGpuPolling()
        return res
      }
      case 'rootGpuStatus': {
        // The command travels with the status so the copy-and-run fallback is
        // the exact command the grant covers, not an approximation of it.
        const enabled = await this.rootSampler.isEnabled()
        // Authorised in an earlier session: start the timer now rather than
        // waiting for someone to press a button that has nothing to fix.
        if (enabled) this.startProcessGpuPolling()
        return { enabled, command: manualCommand() }
      }
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
      case 'getVsCodeIntegration':
        return this.vsCodeIntegration()
      case 'applyVsCodeIntegration':
        return this.applyVsCodeIntegration(params as VsCodeIntegrationApplyParams)
      default:
        throw new Error(`Unknown method: ${method}`)
    }
  }

  /**
   * What a "wire Claude Code" write would do, per installed editor.
   *
   * Recomputed on every call rather than cached: the right base URL and model
   * follow the clean endpoint and the resident model around.
   */
  private vsCodeIntegration(): VsCodeIntegrationInfo {
    const cleanUrl = this.deps.cleanEndpointUrl?.()
    const endpointPort = cleanUrl ? Number(new URL(cleanUrl).port) : Config.cleanEndpointPort()
    const model = this.deps.server.activeModel || Config.defaultModel() || FALLBACK_MODEL
    const env = desiredEnv({
      anthropicBaseUrl: cleanUrl ?? `http://127.0.0.1:${endpointPort}`,
      model,
    })
    const editors = detectEditors({
      desired: env,
      cleanupKeys: this.deps.vscodeCleanupKeys?.(),
      io: { exists: fs.existsSync, read: (p) => fs.readFileSync(p, 'utf8') },
    })
    const snippet = env.map((e) => `export ${e.name}="${e.value}"`).join('\n') + '\nclaude'
    return { editors, env, endpointRunning: Boolean(cleanUrl), endpointPort, model, snippet }
  }

  private async applyVsCodeIntegration(
    params: VsCodeIntegrationApplyParams,
  ): Promise<VsCodeIntegrationResult> {
    // Desired state is recomputed at apply time; the info the page rendered
    // may be minutes old and a different model resident by now.
    const info = this.vsCodeIntegration()
    const chosen = info.editors.filter((e) => params.editors?.includes(e.id) && e.installed)
    if (!chosen.length) return { results: [] }

    const what = params.wire
      ? 'Write Claude Code settings into'
      : params.unwire
        ? 'Remove the Claude Code wiring from'
        : 'Remove stale MLX settings from'
    const confirmed = await this.confirm({
      message: `${what} ${chosen.map((e) => e.label).join(', ')}?`,
      detail:
        (params.wire
          ? 'While wired, Claude Code talks only to this server — its own Anthropic ' +
            'models are unavailable until the wiring is removed. '
          : '') +
        'A timestamped backup is written next to each settings.json first. ' +
        'If an editor has unsaved changes open in its settings editor, save or close ' +
        'them before continuing — editors merge external edits otherwise.',
      action: params.wire ? 'Write settings' : params.unwire ? 'Remove wiring' : 'Clean up',
    })
    if (!confirmed) return { results: [] }

    const io = {
      exists: fs.existsSync,
      read: (p: string) => fs.readFileSync(p, 'utf8'),
      write: (p: string, t: string) => fs.writeFileSync(p, t),
    }
    const results = chosen.map((e) => ({
      editor: e.id,
      ...applyToEditor({
        settingsPath: e.settingsPath,
        env: params.wire ? info.env : undefined,
        unwire: params.unwire,
        removeKeys: params.cleanup ? e.staleKeys : undefined,
        io,
      }),
    }))
    return { results }
  }

  private async sendInitial(webview: MessageSink) {
    void webview.postMessage({ type: 'push', name: 'serverStatus', data: this.serverStatusLite() })
    void webview.postMessage({ type: 'push', name: 'envStatus', data: this.envStatusLite() })
    void webview.postMessage({ type: 'push', name: 'downloads', data: this.deps.downloads.list() })
    void webview.postMessage({ type: 'push', name: 'converts', data: this.deps.convert.list() })
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
    // Prefer the filtered endpoint in the snippets when it is running: for a
    // gpt-oss model it is the difference between an answer and an answer with
    // the model's reasoning stapled to the front.
    const cleanUrl = this.deps.cleanEndpointUrl?.()
    const clientUrl = cleanUrl ?? baseUrl
    const model = this.deps.server.activeModel || Config.defaultModel() || FALLBACK_MODEL
    const hasApiKey = Boolean(Config.apiKey())
    const opencode = JSON.stringify(
      {
        provider: {
          mlx: {
            npm: '@ai-sdk/openai-compatible',
            name: 'MLX (local)',
            options: { baseURL: clientUrl },
            models: { [model]: {} },
          },
        },
      },
      null,
      2,
    )
    const key = hasApiKey ? '(your configured key)' : 'any non-empty value'

    /*
     * The UI, not a settings file.
     *
     * `github.copilot.chat.customOAIModels` is read only as a deprecated value
     * in current Copilot builds — it is migrated into the extension's own
     * storage and no longer declared as a setting — so hand-editing
     * settings.json quietly does nothing. Manage Models is the route that
     * works, and it stores the provider itself.
     */
    const copilot = [
      'Chat model picker → Manage Models → OpenAI Compatible',
      '',
      `Base URL: ${clientUrl}`,
      `API key:  ${key}`,
      `Model id: ${model}`,
      '',
      'The URL ends at /v1 — VS Code appends /chat/completions itself.',
      '',
      'Do not use github.copilot.chat.customOAIModels in settings.json: it is',
      'deprecated and migrated away, so entries there are ignored.',
      'BYOK also needs a Copilot Business or Enterprise seat; without one, use',
      'the Continue route above, which has no such requirement.',
    ].join('\n')

    /*
     * VSCode without this extension.
     *
     * Worth spelling out separately: the server is an ordinary
     * OpenAI-compatible endpoint, and nothing about reaching it from an editor
     * depends on the extension being installed. Continue is the route that
     * needs no Copilot seat.
     */
    const vscode = [
      '# Continue (marketplace: Continue.continue) — no Copilot seat needed.',
      '# Add to ~/.continue/config.yaml:',
      '',
      'models:',
      '  - name: MLX (local)',
      '    provider: openai',
      `    model: ${model}`,
      `    apiBase: ${clientUrl}`,
      `    apiKey: ${hasApiKey ? '<your configured key>' : 'unused'}`,
      '',
      '# Cline, Roo and most other extensions: choose the "OpenAI Compatible"',
      `# provider and give it the same base URL and model id.`,
    ].join('\n')

    const curl = [
      `curl ${clientUrl}/chat/completions \\`,
      "  -H 'Content-Type: application/json' \\",
      `  -H 'Authorization: Bearer ${hasApiKey ? '<your configured key>' : 'x'}' \\`,
      `  -d '${JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }] })}'`,
    ].join('\n')

    /*
     * Two things that make a correct configuration look broken.
     *
     * Both were diagnosed from a real failure: a client pointed here timed
     * out on its first request and its log showed 404s it never explained.
     */
    const gotchas = [
      'The first request loads the model — minutes for a large one — and most',
      'clients give up long before that, leaving a broken pipe in the server log.',
      'Load the model from the Dashboard first; once resident, requests answer',
      'immediately.',
      '',
      'Repeated 404s for /api/version mean something is probing this server as if',
      "it were Ollama. mlx_lm.server does not speak Ollama's API — point the",
      'OpenAI-compatible provider at it instead, and clear any Ollama endpoint',
      'setting aimed here.',
      '',
      'gpt-oss models answer in the harmony format, so raw content arrives as',
      '<|channel|>analysis...<|channel|>final. This extension strips it; enable',
      'cleanEndpoint to strip it for every other client too.',
      '',
      'A 404 from /v1/chat/completions is usually not a missing route:',
      'mlx_lm.server answers 404 for any error during generation, with the real',
      'message in the response body. If a client only shows the status, check the',
      'server log. Sending tools to a model whose template does not support them',
      'is one way to land here — turn tool calling off for that model.',
    ].join('\n')

    return {
      baseUrl,
      cleanUrl,
      activeModel: this.deps.server.activeModel,
      hasApiKey,
      exposeToLan: Config.exposeToLan(),
      snippets: { opencode, copilot, vscode, curl, gotchas },
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
