import type { SearchQuery } from '../shared/protocol'

/** Pure Hugging Face query helpers (no VS Code dependency, so unit-testable). */

export const HF_API = 'https://huggingface.co/api'

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
  if (/\b(4[-_ ]?bit|q4|int4)\b/.test(hay)) return '4bit'
  if (/\b(8[-_ ]?bit|q8|int8)\b/.test(hay)) return '8bit'
  if (/\b(6[-_ ]?bit)\b/.test(hay)) return '6bit'
  if (/\b(3[-_ ]?bit)\b/.test(hay)) return '3bit'
  if (/\b(2[-_ ]?bit)\b/.test(hay)) return '2bit'
  if (/\bbf16\b/.test(hay)) return 'bf16'
  if (/\bfp16\b/.test(hay)) return 'fp16'
  return undefined
}

export function buildSearchUrl(query: SearchQuery, base = HF_API): string {
  const url = new URL(`${base}/models`)
  if (query.text) url.searchParams.set('search', query.text)
  if (query.libraryMlx) url.searchParams.append('filter', 'mlx')
  if (query.mlxCommunity) url.searchParams.set('author', 'mlx-community')
  url.searchParams.set('sort', mapSort(query.sort))
  url.searchParams.set('direction', '-1')
  url.searchParams.set('limit', String(query.limit ?? 30))
  url.searchParams.set('full', 'true')
  return url.toString()
}
