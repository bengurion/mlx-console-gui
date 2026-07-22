/**
 * Message contract shared between the extension host and the webview UI.
 * Types only — safe to import from both the Node and browser bundles.
 */

export type ViewId = 'search' | 'models' | 'downloads' | 'server' | 'impact'

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
}

export interface SearchResult {
  items: ModelSummary[]
  /** Matches after filtering, before the display limit is applied. */
  total: number
  truncated: boolean
}

export interface MachineProfile {
  totalRamBytes: number
  /** Practical ceiling for model weights + runtime (a fraction of total RAM). */
  budgetBytes: number
  cores: number
}

export type SortKey = 'downloads' | 'likes' | 'lastModified' | 'trending'

export interface SearchQuery {
  text: string
  libraryMlx: boolean
  mlxCommunity: boolean
  quant?: string
  sort: SortKey
  limit: number
  /** Hide models whose estimated footprint exceeds the machine's memory budget. */
  onlyFits?: boolean
  /** Hide GGUF repos (default true — mlx-lm cannot run them). */
  hideGguf?: boolean
}

export interface LocalModel {
  repo: string
  sizeBytes: number
  nbFiles: number
  lastModified?: string
  path: string
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
  cpu: { percent?: number; cores: number; load1: number }
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
  activeModel?: string
  hasApiKey: boolean
  exposeToLan: boolean
  snippets: { opencode: string; copilot: string }
}

export type RpcMethod =
  | 'search'
  | 'getModelSize'
  | 'getModelSizes'
  | 'getMachine'
  | 'convertModel'
  | 'listModels'
  | 'deleteModel'
  | 'startDownload'
  | 'cancelDownload'
  | 'launchModel'
  | 'setDefaultModel'
  | 'getSettings'
  | 'updateSetting'
  | 'getMetrics'
  | 'samplePerProcessGpu'
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

/** webview → host */
export type HostBound =
  | { type: 'ready'; view: ViewId }
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
  | { type: 'push'; name: 'models'; data: LocalModel[] }
  | { type: 'push'; name: 'metrics'; data: MetricsSnapshot }
  | { type: 'push'; name: 'modelProfile'; data: ModelProfile }
