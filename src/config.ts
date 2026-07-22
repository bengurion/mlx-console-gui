import * as vscode from 'vscode'
import {
  SAMPLING_DEFAULTS,
  mergeSampling,
  type SamplingOverride,
  type SamplingParams,
} from './services/sampling'

const SECTION = 'mlxConsole'

function cfg() {
  return vscode.workspace.getConfiguration(SECTION)
}

/** Typed accessors over the `mlxConsole.*` settings. */
export const Config = {
  pythonPath(): string {
    return cfg().get<string>('pythonPath', '').trim()
  },
  /** Explicit venv directory override (empty = auto: workspace .venv or global storage). */
  venvPath(): string {
    return cfg().get<string>('venvPath', '').trim()
  },
  /** Models/cache directory; when set it becomes HF_HOME (cache at <dir>/hub). */
  modelsDir(): string {
    return cfg().get<string>('modelsDir', '').trim()
  },
  /** The host mlx_lm.server binds to. 0.0.0.0 when Expose to LAN is enabled. */
  bindHost(): string {
    if (cfg().get<boolean>('server.exposeToLan', false)) return '0.0.0.0'
    return cfg().get<string>('server.host', '127.0.0.1')
  },
  /** The host clients (and the extension itself) connect to. Always loopback. */
  clientHost(): string {
    return '127.0.0.1'
  },
  serverPort(): number {
    return cfg().get<number>('server.port', 8080)
  },
  autoStart(): boolean {
    return cfg().get<boolean>('server.autoStart', true)
  },
  exposeToLan(): boolean {
    return cfg().get<boolean>('server.exposeToLan', false)
  },
  apiKey(): string {
    return cfg().get<string>('server.apiKey', '').trim()
  },
  /** Extra CLI args passed through to mlx_lm.server for machine-specific tuning. */
  serverExtraArgs(): string[] {
    return cfg().get<string[]>('server.extraArgs', []).filter((a) => a.trim().length > 0)
  },
  /** Context window advertised to VSCode; gates how many tools it will send. */
  contextWindow(): number {
    const n = cfg().get<number>('contextWindow', 131072)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 131072
  },
  /**
   * The context window only if the user set it explicitly. Undefined means
   * "auto", which lets the model's own metadata decide.
   */
  contextWindowOverride(): number | undefined {
    const i = cfg().inspect<number>('contextWindow')
    const set = i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue
    return typeof set === 'number' && set > 0 ? Math.floor(set) : undefined
  },
  /** Only when the user set it explicitly; undefined means "derive it". */
  maxOutputTokensOverride(): number | undefined {
    const i = cfg().inspect<number>('maxOutputTokens')
    const set = i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue
    return typeof set === 'number' && set > 0 ? Math.floor(set) : undefined
  },
  maxOutputTokens(): number {
    const n = cfg().get<number>('maxOutputTokens', 4096)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4096
  },
  /** Concurrency / speculative-decoding knobs; 0 or '' means "server default". */
  decodeConcurrency(): number {
    return positive(cfg().get<number>('server.decodeConcurrency', 0))
  },
  promptConcurrency(): number {
    return positive(cfg().get<number>('server.promptConcurrency', 0))
  },
  prefillStepSize(): number {
    return positive(cfg().get<number>('server.prefillStepSize', 0))
  },
  draftModel(): string {
    return cfg().get<string>('server.draftModel', '').trim()
  },
  numDraftTokens(): number {
    return positive(cfg().get<number>('server.numDraftTokens', 0))
  },
  /** Local dashboard: loopback only, opt-in. */
  webUiEnabled(): boolean {
    return cfg().get<boolean>('webUi.enabled', false)
  },
  webUiPort(): number {
    const n = cfg().get<number>('webUi.port', 8090)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 8090
  },
  defaultModel(): string {
    return cfg().get<string>('defaultModel', '').trim()
  },
  hfToken(): string {
    return cfg().get<string>('huggingFace.token', '').trim()
  },
  /** Global generation defaults. */
  sampling(): SamplingParams {
    return {
      temperature: cfg().get<number>('sampling.temperature', SAMPLING_DEFAULTS.temperature),
      topP: cfg().get<number>('sampling.topP', SAMPLING_DEFAULTS.topP),
      topK: cfg().get<number>('sampling.topK', SAMPLING_DEFAULTS.topK),
      minP: cfg().get<number>('sampling.minP', SAMPLING_DEFAULTS.minP),
      repetitionPenalty: cfg().get<number>(
        'sampling.repetitionPenalty',
        SAMPLING_DEFAULTS.repetitionPenalty,
      ),
      maxTokens: cfg().get<number>('sampling.maxTokens', SAMPLING_DEFAULTS.maxTokens),
    }
  },
  /** Generation settings for a specific model (per-model overrides win). */
  samplingFor(model?: string, fromModel?: SamplingOverride): SamplingParams {
    // Values the user changed explicitly outrank anything the model suggests;
    // untouched settings fall through to the model's own generation_config.
    const base = mergeSampling(this.sampling(), pickExplicit(fromModel))
    if (!model) return base
    const overrides = cfg().get<Record<string, SamplingOverride>>('modelOverrides', {})
    return mergeSampling(base, overrides?.[model])
  },
  /** Max distinct KV caches held in the prompt cache (0 = server default). */
  promptCacheSize(): number {
    return cfg().get<number>('server.promptCacheSize', 0)
  },
  /** Max bytes of KV cache — the practical ceiling on cached context (0 = server default). */
  promptCacheBytes(): number {
    return cfg().get<number>('server.promptCacheBytes', 0)
  },
}

/** 0 / non-numeric means "leave the flag off and use the server default". */
function positive(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/**
 * Drop model-suggested sampling values the user has explicitly configured, so
 * an untouched setting takes the model's recommendation and a deliberate one
 * is never silently overridden.
 */
function pickExplicit(fromModel?: SamplingOverride): SamplingOverride | undefined {
  if (!fromModel) return undefined
  const c = cfg()
  const keys: Array<[keyof SamplingOverride, string]> = [
    ['temperature', 'sampling.temperature'],
    ['topP', 'sampling.topP'],
    ['topK', 'sampling.topK'],
    ['minP', 'sampling.minP'],
    ['repetitionPenalty', 'sampling.repetitionPenalty'],
    ['maxTokens', 'sampling.maxTokens'],
  ]
  const out: SamplingOverride = {}
  for (const [field, key] of keys) {
    const i = c.inspect<number>(key)
    const userSet =
      i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue
    if (userSet === undefined && fromModel[field] !== undefined) out[field] = fromModel[field]
  }
  return Object.keys(out).length ? out : undefined
}
