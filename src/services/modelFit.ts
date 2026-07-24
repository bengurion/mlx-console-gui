/**
 * Pure helpers for estimating a model's memory footprint and whether it fits the
 * machine. No VS Code / Node dependencies, so this is unit-testable directly.
 */

export type FitVerdict = 'fits' | 'tight' | 'too-large' | 'unknown'

/** Bytes per element for the dtypes Hugging Face reports in `safetensors.parameters`. */
export const DTYPE_BYTES: Record<string, number> = {
  F64: 8,
  I64: 8,
  U64: 8,
  F32: 4,
  I32: 4,
  U32: 4,
  F16: 2,
  BF16: 2,
  I16: 2,
  U16: 2,
  F8_E4M3: 1,
  F8_E5M2: 1,
  F8_E8M0: 1,
  I8: 1,
  U8: 1,
  BOOL: 1,
  // Sub-byte float dtypes (mxfp4 and friends store weights as F4 + E8M0 scales).
  F6_E2M3: 0.75,
  F6_E3M2: 0.75,
  F4: 0.5,
}

/** Headroom for KV cache, activations and framework overhead on top of weights. */
export const RUNTIME_OVERHEAD = 1.15

/** Extra allowance when estimating from parameter count (packing/scales are unknown). */
const ESTIMATE_OVERHEAD = 1.2

/**
 * Exact weight bytes from HF's per-dtype element counts.
 * MLX 4-bit models pack weights into U32, so counting elements x width is accurate.
 */
export function bytesFromSafetensors(parameters: Record<string, number> | undefined): number | undefined {
  if (!parameters) return undefined
  let total = 0
  for (const [dtype, count] of Object.entries(parameters)) {
    if (!Number.isFinite(count) || count <= 0) continue
    total += count * (DTYPE_BYTES[dtype.toUpperCase()] ?? 2)
  }
  return total > 0 ? total : undefined
}

/**
 * Parse a parameter count in billions out of a model id.
 * Handles "7B", "120b", "0.6b" and mixture-of-experts "8x7B"; ignores
 * "4bit"/"8bit". Falls back to "135M"-style millions — only when no B-count
 * exists, so "Qwen2.5-7B-Instruct-1M" reads as 7B, not a 1M context window.
 */
export function parseParamsB(id: string): number | undefined {
  const s = id.toLowerCase()
  const moe = s.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*b(?!it)/)
  if (moe) {
    const n = parseInt(moe[1], 10) * parseFloat(moe[2])
    if (n > 0 && n < 5000) return n
  }
  const matches = [...s.matchAll(/(\d+(?:\.\d+)?)\s*b(?!it)/g)]
    .map((m) => parseFloat(m[1]))
    .filter((n) => n > 0 && n < 5000)
  if (matches.length) return Math.max(...matches)

  // 10M is the floor and 1B the ceiling: below that it is a version number,
  // above it the repo would say "1.3B" — and context lengths ("-1M") stay out.
  const millions = [...s.matchAll(/(\d+(?:\.\d+)?)\s*m\b/g)]
    .map((m) => parseFloat(m[1]))
    .filter((n) => n >= 10 && n < 1000)
  return millions.length ? Math.max(...millions) / 1000 : undefined
}

/** Bytes per parameter implied by a quantization label. */
export function bytesPerParam(quant?: string): number {
  switch ((quant ?? '').toLowerCase()) {
    case '2bit':
      return 0.25
    case '3bit':
      return 0.375
    case '4bit':
      return 0.5
    case '6bit':
      return 0.75
    case '8bit':
    case 'fp8':
      return 1
    case 'mxfp4':
      // 4-bit values plus one shared 8-bit scale per 32-element block.
      return 0.53125
    case 'bf16':
    case 'fp16':
      return 2
    case 'fp32':
      return 4
    default:
      return 2
  }
}

/** Rough weight-size estimate from a known parameter count. */
export function estimateBytesFromParams(paramsB: number, quant?: string): number {
  return paramsB * 1e9 * bytesPerParam(quant) * ESTIMATE_OVERHEAD
}

/** Rough weight-size estimate when exact dtype counts are unavailable. */
export function estimateBytes(id: string, quant?: string): number | undefined {
  const paramsB = parseParamsB(id)
  if (paramsB === undefined) return undefined
  return estimateBytesFromParams(paramsB, quant)
}

/** Memory a model needs at runtime, given its weight bytes. */
export function runtimeBytes(weightBytes: number): number {
  return weightBytes * RUNTIME_OVERHEAD
}

/**
 * Verdict against a memory budget.
 * `fits` under 70% of budget, `tight` up to the budget, `too-large` beyond it.
 */
export function fitVerdict(weightBytes: number | undefined, budgetBytes: number): FitVerdict {
  if (!weightBytes || !budgetBytes) return 'unknown'
  const needed = runtimeBytes(weightBytes)
  if (needed <= budgetBytes * 0.7) return 'fits'
  if (needed <= budgetBytes) return 'tight'
  return 'too-large'
}

export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

/**
 * How a candidate size lands against the machine, in more detail than `FitVerdict`.
 * `over-budget` is the interesting middle ground: too big for the budget we keep
 * free for the OS and other apps, but still under physical memory — it will load
 * if the machine is otherwise idle.
 */
export type ConvertFit = 'fits' | 'tight' | 'over-budget' | 'too-large'

/** Why a candidate size does or does not work, phrased for the convert picker. */
export function explainFit(
  weightBytes: number,
  budgetBytes: number,
  totalRamBytes: number,
): { verdict: ConvertFit; summary: string; detail: string } {
  const needed = runtimeBytes(weightBytes)
  const at = `≈ ${formatBytes(weightBytes)} on disk, ${formatBytes(needed)} in memory once loaded`

  if (needed <= budgetBytes * 0.7)
    return {
      verdict: 'fits',
      summary: 'fits comfortably',
      detail: `${at} — well inside the ${formatBytes(budgetBytes)} usable budget.`,
    }
  if (needed <= budgetBytes)
    return {
      verdict: 'tight',
      summary: 'tight',
      detail: `${at} — inside the ${formatBytes(budgetBytes)} usable budget, but with little room for a long context.`,
    }
  if (needed <= totalRamBytes)
    return {
      verdict: 'over-budget',
      summary: 'over budget — will only load on an idle machine',
      detail:
        `${at}. That is past the ${formatBytes(budgetBytes)} we keep usable, but still under this machine's ` +
        `${formatBytes(totalRamBytes)} of unified memory, so it can technically load — you would need to quit other apps, ` +
        `raise the GPU wired-memory limit (sudo sysctl iogpu.wired_limit_mb), and expect swapping under load.`,
    }
  return {
    verdict: 'too-large',
    summary: 'too large',
    detail: `${at} — more than this machine's ${formatBytes(totalRamBytes)} of unified memory. It cannot load.`,
  }
}

/**
 * GGUF is llama.cpp's format. `mx.load` can read gguf tensors, but mlx-lm has no
 * pipeline that maps gguf metadata/tokenizer onto a runnable model, and
 * `mlx_lm.convert` only accepts HF-format inputs — so gguf repos are not usable.
 */
export function isGguf(id: string, tags: string[] = []): boolean {
  return /gguf/i.test(id) || tags.some((t) => t.toLowerCase() === 'gguf')
}

export type ModelFormat = 'mlx' | 'convertible' | 'unsupported'

/**
 * What we can do with a repo:
 *  - `mlx`         already MLX — download and run directly
 *  - `convertible` ships safetensors — `mlx_lm.convert` can turn it into MLX
 *  - `unsupported` GGUF, or no safetensors (mlx-lm globs `model*.safetensors`
 *                  and fails with "No safetensors found")
 */
export function classifyFormat(
  id: string,
  tags: string[] = [],
  libraryName?: string,
  /**
   * True when the Hub reports a `safetensors` block for the repo — a fact
   * about the files, unlike the tag, which is merely usually present. Pass it
   * where it is known; the tag remains the fallback.
   */
  hasSafetensors?: boolean,
): ModelFormat {
  const lower = tags.map((t) => t.toLowerCase())
  if (libraryName?.toLowerCase() === 'mlx' || lower.includes('mlx')) return 'mlx'
  if (isGguf(id, tags)) return 'unsupported'
  if (hasSafetensors ?? lower.includes('safetensors')) return 'convertible'
  return 'unsupported'
}

/**
 * Parameter count in billions, from the Hub's safetensors metadata.
 *
 * `total` counts every parameter, experts included — a 35B-A3B mixture reports
 * 35.9B, not 3B — which is right for both filtering and memory, since all of
 * them have to be resident.
 */
export function paramsBFromSafetensors(total: number | undefined): number | undefined {
  if (!total || !Number.isFinite(total) || total <= 0) return undefined
  return total / 1e9
}

/** Integer dtypes: their presence means weights are packed, not stored per parameter. */
const PACKED_DTYPES = new Set(['U32', 'I32', 'U16', 'I16', 'U8', 'I8'])

/**
 * Repos whose integer tensors the Hub counts by *logical* parameters.
 *
 * For quantization_config formats — AWQ, GPTQ, bitsandbytes — the Hub's
 * parser unpacks: a 4-bit phi-4 reports 13.6e9 I32 "elements" where only
 * 1.7e9 int32s exist on disk (verified against the repos' file trees). So
 * `total` is the true parameter count, and elements x dtype-width would
 * overstate the weight bytes four to eight fold — the "53 GB · 113B" cards.
 * MLX packed repos are the opposite: their U32 counts are storage, and
 * elements x width is exact.
 */
export function hubCountsLogicalParams(id: string, tags: string[] = []): boolean {
  const hay = (id + ' ' + tags.join(' ')).toLowerCase()
  return /\b(awq|gptq|autoawq|auto-gptq|bnb|bitsandbytes|compressed-tensors)\b/.test(hay)
}

/**
 * The source repo, recovered from the Hub's structured tags when `cardData`
 * does not carry it — `base_model:quantized:Qwen/Qwen2.5-72B-Instruct` names
 * exactly the repo `mlx_lm.convert` should be pointed at.
 */
export function baseModelFromTags(tags: string[] = []): string | undefined {
  for (const t of tags) {
    const m = /^base_model:(?:quantized:|finetune:|adapter:)?(.+\/.+)$/.exec(t)
    if (m) return m[1]
  }
  return undefined
}

/**
 * How many parameters a model really has.
 *
 * The Hub's `safetensors.total` counts stored *elements*, which for a
 * quantized model is not the parameter count: MLX packs eight 4-bit weights
 * into one uint32, so an 8B model at 4-bit reports 1.3B. Filtering on that
 * puts an 8B model in the "under 2B" bucket and hides it from a 4–9B search —
 * exactly the model someone with limited memory is looking for.
 *
 * So a packed repo is measured by its name, which for quantized builds is
 * reliable (they are named after the model they quantize), and by the stored
 * bytes only as a fallback.
 *
 * The dtypes outrank the name: a repo *called* "-4bit" whose tensors are all
 * floats stores one element per parameter, so its `total` is exact — a
 * mislabelled phi-4 upload must read as 14.7B, not have its count octupled
 * on the theory that it is packed.
 */
export function effectiveParamsB(
  total: number | undefined,
  parameters: Record<string, number> | undefined,
  id: string,
  quant?: string,
): number | undefined {
  const dtypes = Object.keys(parameters ?? {}).map((d) => d.toUpperCase())
  const packed = dtypes.some((d) => PACKED_DTYPES.has(d))
  const trustTotal = dtypes.length > 0 ? !packed : !quant
  if (trustTotal) return paramsBFromSafetensors(total)

  const named = parseParamsB(id)
  if (named !== undefined) return named

  // No size in the name either: recover it from the weight bytes, which is
  // what the quantization was applied to.
  const bytes = bytesFromSafetensors(parameters)
  const per = bytesPerParam(quant)
  if (bytes && per > 0) return bytes / per / 1e9
  return paramsBFromSafetensors(total)
}

/** Whether a parameter count falls inside a requested window. */
export function withinParams(
  paramsB: number | undefined,
  range: { minB?: number; maxB?: number } | undefined,
): boolean {
  if (!range || (range.minB === undefined && range.maxB === undefined)) return true
  // An unknown size is never excluded by a size filter: silently dropping
  // everything the Hub has no metadata for is how results go missing.
  if (paramsB === undefined) return true
  if (range.minB !== undefined && paramsB < range.minB) return false
  if (range.maxB !== undefined && paramsB > range.maxB) return false
  return true
}

/** Bit widths `mlx_lm.convert --q-bits` accepts, highest quality first. */
export const CONVERT_BITS = [8, 6, 4, 3, 2]

/**
 * The no-quantization choice: convert to MLX at the original bf16 precision.
 * Not in CONVERT_BITS because it is not a `--q-bits` value — it drops `-q`
 * entirely — and must never be what chooseQuantBits recommends.
 */
export const BF16_BITS = 16

/** Estimated weight bytes if a model were quantized to `bits`. */
export function bytesForBits(paramsB: number, bits: number): number {
  return paramsB * 1e9 * (bits / 8) * ESTIMATE_OVERHEAD
}

/**
 * Highest quantization that comfortably fits the machine's memory budget.
 * Returns undefined when even 2-bit would not fit.
 */
export function chooseQuantBits(
  paramsB: number | undefined,
  budgetBytes: number,
): number | undefined {
  if (!paramsB || !budgetBytes) return undefined
  for (const bits of CONVERT_BITS) {
    if (runtimeBytes(bytesForBits(paramsB, bits)) <= budgetBytes * 0.7) return bits
  }
  return undefined
}
