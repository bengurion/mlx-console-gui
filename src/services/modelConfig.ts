/**
 * Reads a model's real context length from its own `config.json`, so the window
 * advertised to VSCode matches the model rather than one global guess.
 *
 * Pure parsing lives here; filesystem lookup is in `modelConfigReader.ts`.
 */

/**
 * Keys that carry the trained context length, most authoritative first.
 * Different architectures spell it differently, and multimodal configs nest the
 * text model's value under `text_config`.
 */
const LENGTH_KEYS = [
  'max_position_embeddings',
  'n_positions',
  'max_sequence_length',
  'max_seq_len',
  'seq_length',
] as const

/** Anything outside this is a parse artefact, not a real window. */
const MIN_CONTEXT = 512
const MAX_CONTEXT = 10_000_000

function pick(obj: Record<string, unknown> | undefined): number | undefined {
  if (!obj) return undefined
  for (const key of LENGTH_KEYS) {
    const v = obj[key]
    if (typeof v === 'number' && Number.isFinite(v) && v >= MIN_CONTEXT && v <= MAX_CONTEXT) {
      return Math.floor(v)
    }
  }
  return undefined
}

/**
 * Context length from a parsed `config.json`.
 *
 * Note `sliding_window` is deliberately ignored: models with interleaved local
 * attention (gpt-oss reports `sliding_window: 128`) still accept the full
 * `max_position_embeddings`, so treating it as the window would be wildly wrong.
 */
export function parseContextLength(text: string): number | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== 'object') return undefined
  const cfg = raw as Record<string, unknown>

  return (
    pick(cfg) ??
    pick(cfg.text_config as Record<string, unknown> | undefined) ??
    pick(cfg.llm_config as Record<string, unknown> | undefined)
  )
}

/**
 * Hugging Face cache directory name for a repo:
 * `owner/name` -> `models--owner--name`.
 */
export function cacheDirName(repo: string): string {
  return `models--${repo.replace(/\//g, '--')}`
}

/** A repo id is `owner/name`; anything else is treated as a local path. */
export function isLocalPath(modelId: string): boolean {
  return modelId.startsWith('/') || modelId.startsWith('.') || modelId.startsWith('~')
}

/**
 * Resolve the effective window.
 *
 * Precedence: an explicit user setting wins (they asked for it), otherwise the
 * model's own metadata, otherwise the configured default.
 */
export function effectiveContextWindow(args: {
  userConfigured?: number
  fromModel?: number
  fallback: number
}): { value: number; source: 'user' | 'model' | 'default' } {
  if (args.userConfigured !== undefined && args.userConfigured > 0) {
    return { value: args.userConfigured, source: 'user' }
  }
  if (args.fromModel !== undefined && args.fromModel > 0) {
    return { value: args.fromModel, source: 'model' }
  }
  return { value: args.fallback, source: 'default' }
}

/** Attention shape needed to size the KV cache. */
export interface AttentionShape {
  layers: number
  /** Grouped-query models cache far less than `num_attention_heads` suggests. */
  kvHeads: number
  headDim: number
}

export function parseAttentionShape(text: string): AttentionShape | undefined {
  let cfg: Record<string, unknown>
  try {
    cfg = JSON.parse(text) as Record<string, unknown>
  } catch {
    return undefined
  }
  const nested = (cfg.text_config ?? {}) as Record<string, unknown>
  const num = (k: string): number | undefined => {
    const v = cfg[k] ?? nested[k]
    return typeof v === 'number' && v > 0 ? v : undefined
  }

  const layers = num('num_hidden_layers')
  // GQA/MQA: fall back to attention heads only when kv heads are unstated.
  const kvHeads = num('num_key_value_heads') ?? num('num_attention_heads')
  const hidden = num('hidden_size')
  const heads = num('num_attention_heads')
  const headDim = num('head_dim') ?? (hidden && heads ? hidden / heads : undefined)

  if (!layers || !kvHeads || !headDim) return undefined
  return { layers, kvHeads, headDim }
}

/**
 * Bytes of KV cache per token: K and V, per layer, per kv head.
 * `bytesPerElement` is 2 for the fp16 caches mlx-lm uses by default.
 */
export function kvBytesPerToken(shape: AttentionShape, bytesPerElement = 2): number {
  return 2 * shape.layers * shape.kvHeads * shape.headDim * bytesPerElement
}

/**
 * Reduce an advertised context window so its KV cache fits available memory.
 *
 * A model's trained window is a capability claim, not a memory guarantee: at
 * 131072 tokens a large model's KV cache is many GB on top of the weights.
 * Only `fraction` of the headroom is offered to KV, leaving room for
 * activations. Returns the model window unchanged when it already fits.
 */
export function clampContextToHeadroom(args: {
  modelWindow: number
  headroomBytes?: number
  kvBytesPerToken?: number
  fraction?: number
  floor?: number
}): { window: number; clamped: boolean } {
  const { modelWindow, headroomBytes, kvBytesPerToken: perToken } = args
  const fraction = args.fraction ?? 0.5
  const floor = args.floor ?? 8192
  if (!headroomBytes || !perToken || perToken <= 0) return { window: modelWindow, clamped: false }

  const affordable = Math.floor((headroomBytes * fraction) / perToken)
  if (affordable >= modelWindow) return { window: modelWindow, clamped: false }
  // Never clamp below a usable window; if memory is that tight the pre-flight
  // check is the right place to complain, not a silently tiny context.
  return { window: Math.max(floor, affordable), clamped: true }
}

export type PreflightVerdict = 'ok' | 'tight' | 'will-not-fit'

/**
 * Whether loading a model is advisable given live memory.
 *
 * Only `will-not-fit` is treated as blocking by callers: exceeding the ceiling
 * means the allocation cannot succeed. Everything short of that is a warning,
 * because over-committing is the user's call.
 */
export function preflightCheck(args: {
  weightBytes?: number
  ceilingBytes?: number
  gpuInUseBytes?: number
  /** Weights of the model currently resident, which will be dropped on load. */
  residentWeightBytes?: number
  alreadyResident?: boolean
}): { verdict: PreflightVerdict; message?: string } {
  const {
    weightBytes,
    ceilingBytes,
    gpuInUseBytes = 0,
    residentWeightBytes = 0,
    alreadyResident,
  } = args
  // Already loaded: the memory is spent, nothing to predict.
  if (alreadyResident || !weightBytes || !ceilingBytes) return { verdict: 'ok' }

  const needed = weightBytes * RUNTIME_OVERHEAD
  const available = availableFor(ceilingBytes, gpuInUseBytes, residentWeightBytes)

  if (needed > available) {
    return {
      verdict: 'will-not-fit',
      message:
        `This model needs about ${gib(needed)} at runtime but only ${gib(available)} is ` +
        `available (${gib(gpuInUseBytes)} of the ${gib(ceilingBytes)} ceiling is already in ` +
        'use, some by other apps). Close other GPU users, use a smaller quantization, or ' +
        'raise iogpu.wired_limit_mb in Metrics.',
    }
  }
  if (needed > available * 0.9) {
    return {
      verdict: 'tight',
      message:
        `This model needs about ${gib(needed)} but only ${gib(available)} is free ` +
        `(${gib(gpuInUseBytes)} of the ${gib(ceilingBytes)} ceiling is in use). ` +
        'Expect swapping at long context.',
    }
  }
  return { verdict: 'ok' }
}

/**
 * Memory a newly loaded model can actually claim.
 *
 * `occupiedBytes` must be the *true* occupancy, not `ioreg`'s GPU in-use
 * figure: on unified memory an idle model sits in RAM without being mapped by
 * the GPU, so in-use can read ~2 GB while the server process still holds 50+.
 * See `occupancyBytes()` — the caller is expected to pass that.
 *
 * Our own resident model will be dropped before a new one loads, so its weights
 * are added back; anything else holding memory will not be freed and must come
 * off the budget.
 */
export function availableFor(
  ceilingBytes: number,
  occupiedBytes: number,
  residentWeightBytes: number,
): number {
  const heldByOthers = Math.max(0, occupiedBytes - residentWeightBytes)
  return Math.max(0, ceilingBytes - heldByOthers)
}

/**
 * How much memory is really spoken for right now.
 *
 * `ioreg`'s "In use system memory" only counts what the GPU has mapped at that
 * instant — it collapses to near zero when a resident model is idle, which
 * would make every headroom figure wildly optimistic. The server process's RSS
 * is the honest measure of what its model is holding, so take whichever is
 * larger: RSS covers the idle case, GPU in-use covers transient allocations
 * that have not yet shown up in RSS.
 */
export function occupancyBytes(args: {
  gpuInUseBytes?: number
  serverRssBytes?: number
}): number | undefined {
  const { gpuInUseBytes, serverRssBytes } = args
  if (gpuInUseBytes === undefined && serverRssBytes === undefined) return undefined
  return Math.max(gpuInUseBytes ?? 0, serverRssBytes ?? 0)
}

/** Runtime multiplier over raw weights: KV cache, activations, framework overhead. */
const RUNTIME_OVERHEAD = 1.15

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

/** Generation defaults a model ships in `generation_config.json`. */
export interface GenerationDefaults {
  temperature?: number
  topP?: number
  topK?: number
  minP?: number
  repetitionPenalty?: number
  maxTokens?: number
}

/**
 * Read the model's own recommended sampling settings.
 *
 * Not every model ships these — gpt-oss-120b's generation_config.json carries
 * only token ids — so every field is optional and absent ones fall through to
 * the extension defaults.
 */
export function parseGenerationDefaults(text: string): GenerationDefaults {
  let cfg: Record<string, unknown>
  try {
    cfg = JSON.parse(text) as Record<string, unknown>
  } catch {
    return {}
  }
  const num = (k: string): number | undefined => {
    const v = cfg[k]
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
  }
  // `do_sample: false` means greedy decoding, which is temperature 0.
  const greedy = cfg.do_sample === false

  const out: GenerationDefaults = {
    temperature: greedy ? 0 : num('temperature'),
    topP: num('top_p'),
    topK: num('top_k'),
    minP: num('min_p'),
    repetitionPenalty: num('repetition_penalty'),
    maxTokens: num('max_new_tokens') ?? num('max_length'),
  }
  for (const k of Object.keys(out) as (keyof GenerationDefaults)[]) {
    if (out[k] === undefined) delete out[k]
  }
  return out
}

/**
 * Default output budget when nothing else specifies one.
 *
 * Derived from the context window so a small model does not advertise a
 * response longer than it can hold, bounded to stay useful either way.
 */
export function defaultMaxOutputTokens(contextWindow: number): number {
  const eighth = Math.floor(contextWindow / 8)
  return Math.max(1024, Math.min(8192, eighth))
}

/** `mlx_lm.server`'s own defaults, read from its argparse definitions. */
export const SERVER_DEFAULTS = {
  decodeConcurrency: 32,
  promptConcurrency: 8,
  prefillStepSize: 2048,
  numDraftTokens: 3,
} as const

/**
 * How many sequences can be decoded in parallel before KV cache exhausts memory.
 *
 * Each concurrent sequence keeps its own KV cache, so the server default of 32
 * is sized for a shared inference host, not a single-user editor: at 72 KiB per
 * token and a 131072-token window, one sequence alone is ~9.7 GB.
 */
export function recommendConcurrency(args: {
  headroomBytes?: number
  contextWindow?: number
  kvBytesPerToken?: number
  fraction?: number
  serverDefault?: number
}): { recommended?: number; perSequenceBytes?: number; reason: string } {
  const { headroomBytes, contextWindow, kvBytesPerToken: perToken } = args
  const fraction = args.fraction ?? 0.5
  const cap = args.serverDefault ?? SERVER_DEFAULTS.decodeConcurrency

  if (!headroomBytes || !contextWindow || !perToken) {
    return { reason: 'Needs a loaded model and live memory figures to size this.' }
  }
  const perSequenceBytes = contextWindow * perToken
  const affordable = Math.floor((headroomBytes * fraction) / perSequenceBytes)
  const recommended = Math.max(1, Math.min(cap, affordable))

  return {
    recommended,
    perSequenceBytes,
    reason:
      `Each parallel sequence holds its own KV cache — about ${humanBytes(perSequenceBytes)} ` +
      `at the current context window. The server default of ${cap} assumes a shared host.`,
  }
}

/** Bytes as MB/GB/TB. Sizes in this UI are always shown this way, never raw. */
export function humanBytes(n?: number): string {
  if (n === undefined || !Number.isFinite(n)) return '—'
  if (n === 0) return '0 MB'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  // Number() strips a trailing .0 so 8 GB reads "8 GB", not "8.0 GB".
  return `${Number(v.toFixed(v < 10 && i > 1 ? 1 : 0))} ${units[i]}`
}

/** Parse "8 GB", "512mb", "2048" (bare = MB) into bytes. */
export function parseHumanBytes(text: string): number | undefined {
  const m = text.trim().match(/^([\d.]+)\s*(b|kb|mb|gb|tb)?$/i)
  if (!m) return undefined
  const n = Number(m[1])
  if (!Number.isFinite(n) || n < 0) return undefined
  const mult: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4,
  }
  // A bare number means MB — the unit people actually type for cache sizes.
  return Math.floor(n * mult[(m[2] ?? 'mb').toLowerCase()])
}

/** Vocabulary size — draft and target must match exactly to share tokens. */
export function parseVocabSize(text: string): number | undefined {
  try {
    const cfg = JSON.parse(text) as Record<string, unknown>
    const nested = (cfg.text_config ?? {}) as Record<string, unknown>
    const v = cfg.vocab_size ?? nested.vocab_size
    return typeof v === 'number' && v > 0 ? v : undefined
  } catch {
    return undefined
  }
}

export interface DraftCandidate {
  modelId: string
  vocabSize?: number
  weightBytes?: number
}

/**
 * Pick a draft model for speculative decoding.
 *
 * Two hard requirements: the draft must share the target's **exact vocabulary**
 * (otherwise proposed token ids mean different things and output is garbage),
 * and it must be small enough to be worth running — a draft near the target's
 * size costs as much as it saves. Its weights load *in addition* to the
 * target's, so the pair must also fit the ceiling.
 */
export function selectDraftModel(args: {
  target: DraftCandidate
  candidates: DraftCandidate[]
  headroomBytes?: number
  /** Largest draft, as a fraction of target weights, still worth using. */
  maxRelativeSize?: number
}): { modelId?: string; reason: string } {
  const { target, candidates, headroomBytes } = args
  const maxRelative = args.maxRelativeSize ?? 0.2

  if (!target.vocabSize) {
    return { reason: "The active model's vocabulary size is unknown — cannot match a draft." }
  }

  const sameVocab = candidates.filter(
    (c) => c.modelId !== target.modelId && c.vocabSize === target.vocabSize,
  )
  if (sameVocab.length === 0) {
    return {
      reason:
        `No downloaded model shares this vocabulary (${target.vocabSize} tokens). ` +
        'A draft model must use the identical tokenizer.',
    }
  }

  const smallEnough = sameVocab.filter(
    (c) =>
      c.weightBytes !== undefined &&
      target.weightBytes !== undefined &&
      c.weightBytes <= target.weightBytes * maxRelative,
  )
  if (smallEnough.length === 0) {
    return {
      reason:
        'Vocabulary-compatible models exist, but none is small enough to speed generation up ' +
        `(a draft should be under ${Math.round(maxRelative * 100)}% of the target's size).`,
    }
  }

  // Prefer the largest draft that still fits the size budget: bigger drafts
  // propose better tokens, so more speculations are accepted.
  const best = [...smallEnough].sort((a, b) => (b.weightBytes ?? 0) - (a.weightBytes ?? 0))[0]

  if (headroomBytes !== undefined && (best.weightBytes ?? 0) > headroomBytes) {
    return {
      reason:
        `${best.modelId} matches, but its weights (${humanBytes(best.weightBytes)}) exceed the ` +
        `${humanBytes(headroomBytes)} of headroom left after the main model.`,
    }
  }

  return {
    modelId: best.modelId,
    reason:
      `Shares the target vocabulary (${target.vocabSize} tokens) and is ` +
      `${humanBytes(best.weightBytes)} against the target's ${humanBytes(target.weightBytes)}.`,
  }
}
