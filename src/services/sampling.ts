/**
 * Generation parameters and per-model overrides.
 * Pure module (no VS Code imports) so the merge/serialize logic is unit-testable.
 */

export interface SamplingParams {
  temperature: number
  topP: number
  topK: number
  minP: number
  repetitionPenalty: number
  maxTokens: number
}

export type SamplingOverride = Partial<SamplingParams>

export const SAMPLING_DEFAULTS: SamplingParams = {
  temperature: 0.7,
  topP: 1.0,
  topK: 0, // 0 disables top-k
  minP: 0, // 0 disables min-p
  repetitionPenalty: 1.0, // 1.0 disables the penalty
  maxTokens: 2048,
}

/** Per-model overrides win over the global defaults; unknown keys are ignored. */
export function mergeSampling(
  defaults: SamplingParams,
  override?: SamplingOverride,
): SamplingParams {
  if (!override) return { ...defaults }
  const merged = { ...defaults }
  for (const key of Object.keys(defaults) as (keyof SamplingParams)[]) {
    const value = override[key]
    if (typeof value === 'number' && Number.isFinite(value)) merged[key] = value
  }
  return merged
}

/**
 * Map to OpenAI-compatible request fields, omitting knobs left at their
 * disabling value so we never pin a sampler the user did not ask for.
 */
export function toRequestFields(s: SamplingParams): {
  temperature: number
  top_p: number
  max_tokens: number
  top_k?: number
  min_p?: number
  repetition_penalty?: number
} {
  const out = {
    temperature: s.temperature,
    top_p: s.topP,
    max_tokens: s.maxTokens,
  } as ReturnType<typeof toRequestFields>
  if (s.topK > 0) out.top_k = s.topK
  if (s.minP > 0) out.min_p = s.minP
  if (s.repetitionPenalty !== 1) out.repetition_penalty = s.repetitionPenalty
  return out
}
