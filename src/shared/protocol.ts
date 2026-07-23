/**
 * Message contract shared between the extension host and the webview UI.
 * Types only — safe to import from both the Node and browser bundles.
 */

export type ViewId = 'dashboard' | 'models' | 'search' | 'downloads' | 'settings' | 'clients' | 'setup'

export type FitVerdict = 'fits' | 'tight' | 'too-large' | 'unknown'

/** `mlx` = run directly, `convertible` = safetensors -> mlx_lm.convert, `unsupported` = GGUF/no safetensors. */
export type ModelFormat = 'mlx' | 'convertible' | 'unsupported'

export interface ModelSummary {
  id: string
  likes: number
  downloads: number
  updatedAt?: string
  tags: string[]
  quant?: string
  pipelineTag?: string
  gated?: boolean
  /** Weight bytes: exact when resolved from safetensors dtype counts, else estimated. */
  sizeBytes?: number
  sizeExact?: boolean
  fit?: FitVerdict
  /** GGUF repos cannot be run by mlx-lm (llama.cpp format). */
  gguf?: boolean
  format?: ModelFormat
  /** Parameter count in billions, exact when the Hub reports safetensors metadata. */
  paramsB?: number
  /** The source repo a quantization was made from, when the Hub records one. */
  baseModel?: string
}

export interface SearchResult {
  items: ModelSummary[]
  /** Matches after filtering, before the display limit is applied. */
  total: number
  truncated: boolean
  /** How many Hub entries were examined to find them. */
  scanned: number
  /** True when the search reached the end of the Hub's results. */
  exhausted: boolean
}

export interface MachineProfile {
  totalRamBytes: number
  /** Practical ceiling for model weights + runtime (a fraction of total RAM). */
  budgetBytes: number
  cores: number
}

export type SortKey = 'downloads' | 'likes' | 'lastModified' | 'trending'

/**
 * How much of the Hub to look at.
 *
 *  - `mlx`         only repos already in MLX format — run them as they are
 *  - `convertible` those, plus anything with safetensors, which can be converted
 *  - `all`         everything, GGUF included, which mlx-lm can neither run nor convert
 */
export type SearchScope = 'mlx' | 'convertible' | 'all'

/** A parameter-count window, in billions. Both ends optional. */
export interface ParamRange {
  minB?: number
  maxB?: number
}

export interface SearchQuery {
  text: string
  scope: SearchScope
  mlxCommunity: boolean
  quant?: string
  sort: SortKey
  limit: number
  /** Hide models whose estimated footprint exceeds the machine's memory budget. */
  onlyFits?: boolean
  /** Parameter count window, from the Hub's own safetensors metadata. */
  params?: ParamRange
}

export interface LocalModel {
  /** Repo id, or — for a converted model, which has no repo — its path. */
  repo: string
  sizeBytes: number
  nbFiles: number
  lastModified?: string
  path: string
  /** Converted locally rather than downloaded: lives outside the HF cache. */
  local?: boolean
}

export type DownloadState = 'queued' | 'downloading' | 'done' | 'error' | 'canceled'

export interface DownloadItem {
  repo: string
  state: DownloadState
  progress: number // 0..1
  downloadedBytes?: number
  totalBytes?: number
  message?: string
}

export interface ServerStatusLite {
  state: 'stopped' | 'starting' | 'ready' | 'error'
  baseUrl: string
  advertisedBaseUrl: string
  activeModel?: string
  detail?: string
  exposeToLan: boolean
  hasApiKey: boolean
  /** Weight residency inside the server process. */
  modelState: 'none' | 'loading' | 'loaded'
  loadedModel?: string
  loadStartedAt?: number
  lastLoadSeconds?: number
}

/** One poll of system metrics. Every field is best-effort. */
export interface MetricsSnapshot {
  at: number
  cpu: { percent?: number; cores: number; load1: number; perCore?: number[] }
  memory?: {
    totalBytes: number
    wiredBytes: number
    activeBytes: number
    compressedBytes: number
    freeBytes: number
    usedBytes: number
  }
  gpu: {
    utilizationPercent?: number
    inUseBytes?: number
    allocatedBytes?: number
    rendererPercent?: number
    tilerPercent?: number
    deviceName?: string
    architecture?: string
    memoryBytes?: number
    maxRecommendedWorkingSetBytes?: number
    maxBufferBytes?: number
  }
  /** Explicit `iogpu.wired_limit_mb` override, when one is set. */
  wiredLimitBytes?: number
  /** Swap in use. Non-zero while a model is resident means it cost you. */
  swap?: { totalBytes: number; usedBytes: number; freeBytes: number }
  /**
   * Paging rates since the previous sample. Sustained swap-outs are the
   * clearest evidence that the machine is being squeezed rather than merely
   * being busy.
   */
  paging?: {
    swapOutBytesPerSec?: number
    swapInBytesPerSec?: number
    pageOutBytesPerSec?: number
  }
  /**
   * Memory genuinely spoken for: the larger of GPU in-use and the server's RSS.
   * GPU in-use alone collapses when a resident model is idle.
   */
  occupiedBytes?: number
  /** Live sizing advice for `server.promptCacheBytes`. Advisory only. */
  promptCache: {
    recommendedBytes?: number
    headroomBytes?: number
    reason: string
    /** The value currently configured (0 = unbounded / server default). */
    configuredBytes: number
  }
  /** Live sizing advice for `server.decodeConcurrency`. Advisory only. */
  concurrency: {
    recommended?: number
    perSequenceBytes?: number
    reason: string
    configured: number
    serverDefault: number
  }
  process?: { pid: number; rssBytes: number; cpuPercent: number }
}

/**
 * Everything derived from a model's own files, refreshed whenever the resident
 * model changes. Computed host-side so the UI never has to ask.
 */
export interface ModelProfile {
  modelId: string
  contextWindow?: number
  vocabSize?: number
  weightBytes?: number
  kvBytesPerToken?: number
  /** Sampling the model recommends in its generation_config.json. */
  generation?: Record<string, number>
  /** Speculative-decoding candidate found among downloaded models. */
  draft: { modelId?: string; reason: string; configured: string }
}

/**
 * Per-process GPU time, pushed on a timer once sampling is authorised.
 *
 * Separate from MetricsSnapshot because it is sampled far less often — the
 * privileged command takes a second of wall clock, so it runs every 20s rather
 * than in the 2s metrics loop.
 */
export interface ProcessGpuPush {
  at: number
  enabled: boolean
  samples?: { name: string; pid: number; gpuMsPerS: number }[]
  /** Device power and clocks, sampled in the same privileged run. */
  power?: {
    milliwatts?: number
    frequencyMhz?: number
    idleResidencyPercent?: number
    activeResidencyPercent?: number
  }
  error?: string
}

/**
 * Per-model generation settings, as the Models view sees them.
 *
 * Three layers, reported separately rather than merged, because which one a
 * value came from is the useful part: what the model recommends in its own
 * `generation_config.json`, what you set globally, and what you set for this
 * model specifically.
 */
export interface ModelConfigView {
  modelId: string
  /** Only the keys this model has an explicit override for. */
  override: Record<string, number>
  /** The model's own recommendation, where it ships one. */
  fromModel: Record<string, number>
  /** The global defaults, used when neither of the above applies. */
  global: Record<string, number>
  /** What a request will actually use, after all three are applied. */
  effective: Record<string, number>
  contextWindow?: number
  kvBytesPerToken?: number
  weightBytes?: number
  vocabSize?: number
}

/** One editable setting, derived from the package.json contribution schema. */
export interface SettingSpec {
  key: string
  /** Key without the `mlxConsole.` prefix, e.g. `server.port`. */
  short: string
  /** Group heading derived from the key, e.g. `server`. */
  group: string
  label: string
  description?: string
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  default?: unknown
  value: unknown
  enum?: string[]
  /** Render as a password field (tokens and keys). */
  secret?: boolean
  /** Byte-valued: render as MB/GB rather than a raw number. */
  unit?: 'bytes'
}

export interface EnvStatusLite {
  /** Version of this extension, shown in the Environment card. */
  extensionVersion: string
  ready: boolean
  platformOk: boolean
  message: string
  mlxVersion?: string
  venvPath?: string
  modelsDir: string
}

export interface ExternalClientsInfo {
  baseUrl: string
  /**
   * A second endpoint that strips the harmony format, when enabled.
   *
   * Advertised separately from `baseUrl` because which one a client should use
   * depends on the model: only gpt-oss-family models emit harmony, and for
   * everything else the two are identical.
   */
  cleanUrl?: string
  activeModel?: string
  hasApiKey: boolean
  exposeToLan: boolean
  snippets: { opencode: string; copilot: string; vscode: string; curl: string; gotchas: string }
}

export type ConvertState = 'downloading' | 'converting' | 'done' | 'error' | 'canceled'

/** One conversion job, shaped like a download because it behaves like one. */
export interface ConvertItem {
  repo: string
  bits: number
  outPath: string
  state: ConvertState
  progress: number // 0..1, from mlx_lm.convert's own progress bars
  message?: string
}

/** One quantization the user can pick, with what it costs. */
export interface ConvertOption {
  bits: number
  recommended: boolean
  /** Estimated weight bytes; absent when the repo id does not name a size. */
  estBytes?: number
  /** Finer-grained than FitVerdict: 'over-budget' still loads with nothing else open. */
  fit: 'fits' | 'tight' | 'over-budget' | 'too-large' | 'unknown'
  summary: string
  detail: string
}

export interface ConvertPlan {
  repo: string
  /** Parameters in billions, parsed from the repo id. */
  paramsB?: number
  budgetBytes: number
  totalBytes: number
  options: ConvertOption[]
  /** Set when conversion is impossible, or possible but pointless. */
  error?: string
}

/** One process as psutil sees it, for the "who is eating the memory" table. */
export interface TopProcess {
  pid: number
  name: string
  rssBytes: number
  cpuPercent: number
}

/** Answer to the `topProcesses` RPC. Best-effort: absent without psutil. */
export interface TopInfo {
  processes: TopProcess[]
  /** The volume holding the models directory. */
  disk?: { path: string; totalBytes: number; freeBytes: number }
}

/**
 * What first-run onboarding found on the machine, so the page can offer to
 * adopt an existing install instead of building a second one.
 */
export interface SetupDetection {
  /** System Python, or absent when none was found. */
  python?: { path: string; version: string }
  /** A venv with mlx-lm already in it (the extension's, usually). */
  existingVenv?: string
  /** A models directory configured in VS Code or the CLI config. */
  existingModelsDir?: string
  /** Suggested install root when the user has no preference. */
  defaultRoot: string
  /** Free bytes on the home volume, for the "models are large" warning. */
  freeBytes?: number
}

export interface SetupInstallParams {
  root: string
  /** Keep using this venv rather than creating `<root>/venv`. */
  adoptVenv?: string
  /** Keep models where they are rather than under `<root>/models`. */
  adoptModelsDir?: string
}

/** One line of install progress, streamed while `setupInstall` runs. */
export interface SetupProgress {
  message: string
}

export type RpcMethod =
  | 'search'
  | 'getModelSize'
  | 'getModelSizes'
  | 'getMachine'
  | 'getConvertPlan'
  | 'convertModel'
  | 'cancelConvert'
  | 'listModels'
  | 'deleteModel'
  | 'startDownload'
  | 'cancelDownload'
  | 'launchModel'
  | 'setDefaultModel'
  | 'getModelConfig'
  | 'setModelConfig'
  | 'getSettings'
  | 'updateSetting'
  | 'getMetrics'
  | 'samplePerProcessGpu'
  | 'rootGpuStatus'
  | 'enableRootGpu'
  | 'disableRootGpu'
  | 'suggestDraftModel'
  | 'setWiredLimit'
  | 'startServer'
  | 'stopServer'
  | 'restartServer'
  | 'unloadModel'
  | 'getServerStatus'
  | 'getEnvStatus'
  | 'getExternalClients'
  | 'runSetup'
  | 'topProcesses'
  | 'setupDetect'
  | 'setupPickRoot'
  | 'setupInstall'

/** webview → host */
export type HostBound =
  /** `build` is the id stamped into the page bundle; see the `stale` push. */
  | { type: 'ready'; view: ViewId; build?: string }
  | { type: 'rpc'; id: number; method: RpcMethod; params?: unknown }
  | { type: 'openExternal'; url: string }
  | { type: 'copy'; text: string }
  | { type: 'openSettings'; query?: string }

/** host → webview */
export type WebviewBound =
  | { type: 'rpcResult'; id: number; ok: true; result: unknown }
  | { type: 'rpcResult'; id: number; ok: false; error: string }
  | { type: 'push'; name: 'serverStatus'; data: ServerStatusLite }
  | { type: 'push'; name: 'envStatus'; data: EnvStatusLite }
  | { type: 'push'; name: 'downloads'; data: DownloadItem[] }
  | { type: 'push'; name: 'converts'; data: ConvertItem[] }
  | { type: 'push'; name: 'models'; data: LocalModel[] }
  | { type: 'push'; name: 'metrics'; data: MetricsSnapshot }
  | { type: 'push'; name: 'modelProfile'; data: ModelProfile }
  | { type: 'push'; name: 'processGpu'; data: ProcessGpuPush }
  /** Reveal one setting in the settings view, wherever that view lives. */
  | { type: 'push'; name: 'revealSetting'; data: { short: string } }
  /**
   * The page and the host came from different builds.
   *
   * The dashboard reads its bundle from disk per request while the host is
   * whatever was loaded at startup, so rebuilding without restarting leaves a
   * new UI talking to an old host. Nothing errors — the old host simply
   * ignores fields it has never heard of, so a filter silently does nothing.
   * Better to say so.
   */
  | { type: 'push'; name: 'stale'; data: { host: string; client: string } }
  /** Install progress for the first-run Setup page. */
  | { type: 'push'; name: 'setupProgress'; data: SetupProgress }
