import type { SearchQuery } from '../shared/protocol'

/** Pure Hugging Face query helpers (no VS Code dependency, so unit-testable). */

export const HF_API = 'https://huggingface.co/api'

/**
 * Fields asked for explicitly.
 *
 * `full=true` returns the whole record including every file name, but *not*
 * `safetensors` — so parameter counts had to be fetched one repo at a time,
 * which is why sizes were guessed from the repo id first and refined by a
 * second round of requests. `expand[]` returns exactly these fields and does
 * include it, so one request now carries exact parameter counts for a whole
 * page of results.
 */
const EXPAND = [
  'safetensors',
  'tags',
  'downloads',
  'likes',
  'lastModified',
  'pipeline_tag',
  'library_name',
  'gated',
  'cardData',
]

/** The Hub's ceiling for one page. */
export const MAX_PAGE = 1000

/**
 * Widest a packing can shrink a reported parameter count.
 *
 * The Hub's `num_parameters` filter reads the same `safetensors.total` we do,
 * which counts stored elements — so a 4-bit repo packing eight weights into a
 * uint32 is measured at an eighth of its real size. Asking the Hub for a band
 * eight times wider at the bottom cannot miss such a model; the exact check
 * afterwards removes whatever that lets through. The reported count is never
 * *larger* than the true one, so the upper bound needs no such allowance.
 */
const PACKING_SLACK = 8

/**
 * The Hub's own parameter-count filter, widened to stay complete.
 *
 * Worth using even though the same test runs client-side: it applies across
 * the whole Hub rather than only the pages fetched, which is the difference
 * between "the 40B models among the top 200 downloads" and "the 40B models".
 */
export function paramsFilter(range: { minB?: number; maxB?: number } | undefined): string | undefined {
  if (!range) return undefined
  const parts: string[] = []
  if (range.minB !== undefined) parts.push(`min:${range.minB / PACKING_SLACK}B`)
  if (range.maxB !== undefined) parts.push(`max:${range.maxB}B`)
  return parts.length ? parts.join(',') : undefined
}

export function mapSort(sort: SearchQuery['sort']): string {
  switch (sort) {
    case 'likes':
      return 'likes'
    case 'lastModified':
      return 'lastModified'
    case 'trending':
      return 'trendingScore'
    case 'downloads':
    default:
      return 'downloads'
  }
}

export function deriveQuant(id: string, tags?: string[]): string | undefined {
  const hay = (id + ' ' + (tags ?? []).join(' ')).toLowerCase()
  // mxfp4 before the 4-bit family: it is 4-bit-shaped but sized differently
  // (block scales), and gpt-oss ships in it.
  if (/\bmxfp4\b/.test(hay)) return 'mxfp4'
  // q4 must tolerate GGUF spellings like Q4_K_M, where `_` defeats \b.
  if (/\b(4[-_ ]?bit|int4|nf4|w4a16|awq|gptq)\b/.test(hay) || /\bi?q4(?!\d)/.test(hay)) return '4bit'
  if (/\b(8[-_ ]?bit|int8)\b/.test(hay) || /\bq8(?!\d)/.test(hay)) return '8bit'
  if (/\b(6[-_ ]?bit)\b/.test(hay) || /\bq6(?!\d)/.test(hay)) return '6bit'
  if (/\b(3[-_ ]?bit)\b/.test(hay) || /\bq3(?!\d)/.test(hay)) return '3bit'
  if (/\b(2[-_ ]?bit)\b/.test(hay) || /\bq2(?!\d)/.test(hay)) return '2bit'
  if (/\bbf16\b/.test(hay)) return 'bf16'
  if (/\b(fp16|f16|float16)\b/.test(hay)) return 'fp16'
  if (/\bfp8\b/.test(hay)) return 'fp8'
  if (/\b(fp32|f32|float32)\b/.test(hay)) return 'fp32'
  return undefined
}

export function buildSearchUrl(query: SearchQuery, base = HF_API): string {
  const url = new URL(`${base}/models`)
  if (query.text) url.searchParams.set('search', query.text)
  // Only the `mlx` scope narrows server-side. Anything wider is decided from
  // each row's own metadata, because "has safetensors" is a fact about the
  // files rather than a tag someone is obliged to set.
  if (query.scope === 'mlx') url.searchParams.append('filter', 'mlx')
  if (query.mlxCommunity) url.searchParams.set('author', 'mlx-community')
  const params = paramsFilter(query.params)
  if (params) url.searchParams.set('num_parameters', params)
  url.searchParams.set('sort', mapSort(query.sort))
  url.searchParams.set('direction', '-1')
  url.searchParams.set('limit', String(Math.min(MAX_PAGE, query.limit ?? 30)))
  for (const field of EXPAND) url.searchParams.append('expand[]', field)
  return url.toString()
}

/**
 * The next page, from the response's `Link` header.
 *
 * The Hub paginates by cursor, not offset — `skip` is answered with a 400 — so
 * following this header is the only way past the first page. Its absence is
 * itself information: it distinguishes "no more matches" from "we stopped
 * looking", which is the difference between an honest result count and a
 * misleading one.
 */
export function nextPageUrl(linkHeader: string | null | undefined): string | undefined {
  if (!linkHeader) return undefined
  for (const part of linkHeader.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part.trim())
    if (m) return m[1]
  }
  return undefined
}
