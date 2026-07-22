import * as vscode from 'vscode'
import * as os from 'node:os'
import { log } from '../../util/logger'
import { Config } from '../../config'
import { getWebviewHtml } from './html'
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
  ModelProfile,
  RpcMethod,
  SearchQuery,
  ServerStatusLite,
  SettingSpec,
  ViewId,
  WebviewBound,
} from '../../shared/protocol'

const VIEW_IDS: Record<ViewId, string> = {
  search: 'mlxConsole.search',
  models: 'mlxConsole.models',
  downloads: 'mlxConsole.downloads',
  server: 'mlxConsole.server',
}

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
  extensionUri: vscode.Uri
}

/** Central message router shared by all MLX Console webview views. */
export class WebviewHub {
  private readonly webviews = new Set<vscode.Webview>()
  private readonly disposables: vscode.Disposable[] = []
  private readonly modelConfig = new ModelConfigReader()
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
      void vscode.window.showErrorMessage('MLX: wired memory limit must be a non-negative number.')
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

    const choice = await vscode.window.showWarningMessage(
      `Set GPU wired memory limit to ${label}?`,
      { modal: true, detail: `${detail}\n\nRuns in a terminal so you can enter your password.` },
      'Open Terminal',
    )
    if (choice !== 'Open Terminal') return { ok: false }

    const term = vscode.window.createTerminal('MLX: GPU memory limit')
    term.show()
    term.sendText(`sudo sysctl iogpu.wired_limit_mb=${mb}`)
    return { ok: true }
  }

  /**
   * Free the resident model and its KV caches.
   *
   * `mlx_lm.server` exposes no cache-flush or unload endpoint — its only routes
   * are the completion POSTs, `/v1/models` and `/health`, and `ModelProvider`
   * drops weights only when a different model displaces them. Restarting the
   * process is therefore the only way to release either.
   */
  private async unloadModel(): Promise<{ ok: boolean }> {
    const loaded = this.deps.server.loadedModel
    const pick = await vscode.window.showWarningMessage(
      loaded ? `Unload ${loaded} and clear its cache?` : 'Restart the server to clear caches?',
      {
        modal: true,
        detail:
          'The server has no unload or cache-clear endpoint, so this restarts the process. ' +
          'That frees the model weights and every KV/prompt cache. The next request reloads ' +
          'the model, which can take minutes for a large one.',
      },
      'Unload',
    )
    if (pick !== 'Unload') return { ok: false }

    this.deps.server.stop()
    log.info('Model unloaded and caches cleared (server stopped)')
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

  /** Read a model's own files and broadcast the result. */
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
  private settingsCatalog(): SettingSpec[] {
    const cfg = vscode.workspace.getConfiguration('mlxConsole')
    return buildSettingsCatalog(
      this.deps.packageJSON.contributes?.configuration?.properties,
      (short) => cfg.get(short),
    )
  }

  /**
   * Write one setting to the user (global) scope.
   *
   * Values are coerced against the declared type first so a malformed JSON
   * blob is reported rather than persisted.
   */
  private async updateSetting(params: {
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
      await vscode.workspace
        .getConfiguration('mlxConsole')
        .update(spec.short, coerced.value, vscode.ConfigurationTarget.Global)
      log.info(`Setting updated: ${key}`)
      return { ok: true, settings: this.settingsCatalog() }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      log.error(`Failed to update ${key}`, err)
      return { ok: false, error }
    }
  }

  register(view: vscode.WebviewView) {
    const webview = view.webview
    this.webviews.add(webview)
    const sub = webview.onDidReceiveMessage((m) => void this.onMessage(webview, m))

    // Sample metrics only while this view is actually visible, so a collapsed
    // panel costs nothing.
    let metricsSub: vscode.Disposable | undefined
    const syncMetrics = () => {
      if (view.visible && !metricsSub) metricsSub = this.deps.metrics.subscribe()
      else if (!view.visible && metricsSub) {
        metricsSub.dispose()
        metricsSub = undefined
      }
    }
    syncMetrics()
    const visSub = view.onDidChangeVisibility(syncMetrics)

    view.onDidDispose(() => {
      this.webviews.delete(webview)
      sub.dispose()
      visSub.dispose()
      metricsSub?.dispose()
    })
  }

  private broadcast(msg: WebviewBound) {
    for (const w of this.webviews) void w.postMessage(msg)
  }

  private async onMessage(webview: vscode.Webview, raw: unknown) {
    const m = raw as HostBound
    switch (m.type) {
      case 'ready':
        await this.sendInitial(webview)
        break
      case 'openExternal':
        void vscode.env.openExternal(vscode.Uri.parse(m.url))
        break
      case 'copy':
        await vscode.env.clipboard.writeText(m.text)
        void vscode.window.showInformationMessage('Copied to clipboard')
        break
      case 'openSettings':
        void vscode.commands.executeCommand('workbench.action.openSettings', m.query ?? 'mlxConsole')
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
        void vscode.commands.executeCommand('mlxConsole.convertModel', repoOf())
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
        const pick = await vscode.window.showWarningMessage(
          `Delete "${repo}" from the model cache?`,
          { modal: true, detail: 'This permanently removes the downloaded files from disk.' },
          'Delete',
        )
        if (pick !== 'Delete') return { ok: false, canceled: true }
        const res = await this.deps.cache.delete(repo)
        await this.refreshModels()
        void vscode.window.showInformationMessage(
          `MLX: deleted ${repo} (freed ${formatBytes(res.freedBytes)}).`,
        )
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
        await vscode.workspace
          .getConfiguration('mlxConsole')
          .update('defaultModel', repoOf(), vscode.ConfigurationTarget.Global)
        this.pushServerStatus()
        return { ok: true }
      case 'startServer':
        return { ok: await this.deps.server.ensureRunning(true) }
      case 'stopServer':
        this.deps.server.stop()
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
      case 'setWiredLimit':
        return this.setWiredLimit(Number((params as { megabytes?: unknown })?.megabytes))
      default:
        throw new Error(`Unknown method: ${method}`)
    }
  }

  private async sendInitial(webview: vscode.Webview) {
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

class MlxWebviewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly view: ViewId,
    private readonly hub: WebviewHub,
    private readonly extensionUri: vscode.Uri,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.extensionUri, 'resources'),
      ],
    }
    webviewView.webview.html = getWebviewHtml(webviewView.webview, this.extensionUri, this.view)
    this.hub.register(webviewView)
  }
}

/** Registers all four webview view providers. */
export function registerWebviews(
  context: vscode.ExtensionContext,
  hub: WebviewHub,
): void {
  for (const view of Object.keys(VIEW_IDS) as ViewId[]) {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        VIEW_IDS[view],
        new MlxWebviewProvider(view, hub, context.extensionUri),
        { webviewOptions: { retainContextWhenHidden: true } },
      ),
    )
  }
}
