/**
 * Learns a model's *transient* memory cost by watching real requests.
 *
 * Weights and KV cache can be computed from config.json, but prefill working
 * memory cannot: it depends on the step size, the batch, and mlx's allocator.
 * Rather than guess, this observes GPU in-use before and during generation and
 * fits a simple linear model:
 *
 *     peak - baseline  ≈  perToken * promptTokens  +  fixedOverhead
 *
 * Estimates are only offered once several observations agree, so a single
 * noisy sample (another app touching the GPU) cannot drive a recommendation.
 */

export interface Observation {
  /** Prompt tokens processed in this request. */
  promptTokens: number
  /** GPU bytes in use immediately before the request. */
  baselineBytes: number
  /** Highest GPU bytes in use seen during the request. */
  peakBytes: number
  /**
   * Known KV cost per token for this model, computed from its config.
   *
   * The observed delta contains KV cache growth *and* transient prefill
   * memory, and both scale with prompt length. Without removing the KV part
   * the fitted slope is really `kv + transient`, badly overestimating what
   * prefill actually costs.
   */
  kvBytesPerToken?: number
}

/** Minimum observations before an estimate is considered usable. */
export const MIN_OBSERVATIONS = 3
/** Keep a bounded history so the estimate tracks the current model. */
export const MAX_OBSERVATIONS = 20

export interface TransientEstimate {
  /** Transient bytes attributable to each prompt token. */
  bytesPerToken?: number
  /** Constant cost independent of prompt size. */
  fixedBytes?: number
  samples: number
  /** True once enough consistent samples exist to act on. */
  usable: boolean
  reason: string
}

/**
 * Ordinary least squares on (tokens, delta) pairs.
 *
 * Kept explicit rather than pulling in a stats dependency — two accumulators
 * and a slope are all this needs, and it stays unit-testable.
 */
function fitLine(points: Array<{ x: number; y: number }>): { slope: number; intercept: number } | undefined {
  const n = points.length
  if (n < 2) return undefined
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  for (const p of points) {
    sx += p.x
    sy += p.y
    sxx += p.x * p.x
    sxy += p.x * p.y
  }
  const denom = n * sxx - sx * sx
  // Every request had the same prompt size: slope is unidentifiable.
  if (denom === 0) return undefined
  const slope = (n * sxy - sx * sy) / denom
  return { slope, intercept: (sy - slope * sx) / n }
}

/** Accumulates observations for one model and reports the current estimate. */
export class MemoryObserver {
  private readonly byModel = new Map<string, Observation[]>()

  record(modelId: string, obs: Observation): void {
    // A negative delta means memory was freed during the request (another
    // process releasing, or a cache trim) — it tells us nothing about cost.
    if (obs.promptTokens <= 0 || obs.peakBytes < obs.baselineBytes) return

    const list = this.byModel.get(modelId) ?? []
    list.push(obs)
    if (list.length > MAX_OBSERVATIONS) list.shift()
    this.byModel.set(modelId, list)
  }

  observations(modelId: string): Observation[] {
    return this.byModel.get(modelId) ?? []
  }

  estimate(modelId: string): TransientEstimate {
    const list = this.observations(modelId)
    const samples = list.length

    if (samples < MIN_OBSERVATIONS) {
      return {
        samples,
        usable: false,
        reason: `Measuring — ${samples}/${MIN_OBSERVATIONS} requests observed so far.`,
      }
    }

    const fit = fitLine(
      list.map((o) => ({
        x: o.promptTokens,
        // Remove the KV cache growth this prompt necessarily caused; what is
        // left is transient working memory.
        y:
          o.peakBytes -
          o.baselineBytes -
          (o.kvBytesPerToken ?? 0) * o.promptTokens,
      })),
    )
    if (!fit) {
      return {
        samples,
        usable: false,
        reason: 'All observed prompts were the same size — cannot separate per-token cost.',
      }
    }

    // A negative slope is noise, not a measurement; report it as such rather
    // than emitting a nonsensical negative cost.
    if (fit.slope <= 0) {
      return {
        samples,
        usable: false,
        reason: 'Measurements are too noisy to attribute memory per token yet.',
      }
    }

    return {
      bytesPerToken: fit.slope,
      fixedBytes: Math.max(0, fit.intercept),
      samples,
      usable: true,
      reason: `Measured from ${samples} requests on this machine.`,
    }
  }

  /** Forget a model's history, e.g. after it is unloaded or settings change. */
  reset(modelId?: string): void {
    if (modelId) this.byModel.delete(modelId)
    else this.byModel.clear()
  }
}

/**
 * Largest prefill step whose transient cost fits the available headroom.
 *
 * Uses the measured per-token cost, so it only produces a number once enough
 * real requests have been seen.
 */
export function recommendPrefillStepSize(args: {
  estimate: TransientEstimate
  headroomBytes?: number
  fraction?: number
  serverDefault?: number
}): { recommended?: number; reason: string } {
  const { estimate, headroomBytes } = args
  const fraction = args.fraction ?? 0.25
  const serverDefault = args.serverDefault ?? 2048

  if (!estimate.usable || !estimate.bytesPerToken) {
    return { reason: estimate.reason }
  }
  if (!headroomBytes) return { reason: 'Live GPU headroom unknown.' }

  const budget = headroomBytes * fraction - (estimate.fixedBytes ?? 0)
  if (budget <= 0) {
    return { reason: 'No headroom left for prefill working memory — lower the context or cache.' }
  }

  const affordable = Math.floor(budget / estimate.bytesPerToken)
  // Round to a power-of-two-ish step; the server's own default is 2048.
  const stepped = Math.max(256, Math.min(8192, 1 << Math.floor(Math.log2(affordable))))
  return {
    recommended: stepped,
    reason:
      `Measured ${Math.round(estimate.bytesPerToken / 1024)} KiB of working memory per prompt ` +
      `token over ${estimate.samples} requests. Server default is ${serverDefault}.`,
  }
}
