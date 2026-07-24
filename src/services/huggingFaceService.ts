import { Config } from '../config.ts'
import { log } from '../core/logging.ts'
import { HF_API, MAX_PAGE, buildSearchUrl, deriveQuant, nextPageUrl } from './hfQuery.ts'
import {
  baseModelFromTags,
  bytesFromSafetensors,
  classifyFormat,
  estimateBytes,
  estimateBytesFromParams,
  hubCountsLogicalParams,
  isGguf,
  effectiveParamsB,
  paramsBFromSafetensors,
  withinParams,
} from './modelFit.ts'
import type { ModelSummary, SearchQuery, SearchResult } from '../shared/protocol'

interface HfModel {
  id?: string
  modelId?: string
  likes?: number
  downloads?: number
  lastModified?: string
  tags?: string[]
  pipeline_tag?: string
  gated?: boolean | string
  library_name?: string
  /** Present via `expand[]=safetensors`; absent means the repo has none. */
  safetensors?: { parameters?: Record<string, number>; total?: number }
  cardData?: { base_model?: string | string[] }
}

interface HfModelInfo {
  tags?: string[]
  safetensors?: { parameters?: Record<string, number>; total?: number }
}

const SIZE_CONCURRENCY = 6

/**
 * How many pages one search may fetch.
 *
 * A ceiling on effort, not on correctness: when it is reached the result says
 * how many entries were examined, so "3 results" never masquerades as "3 exist".
 */
const MAX_PAGES = 5

/** Ask for a big page when filtering client-side; there is no extra round trip. */
function pageSize(limit: number): number {
  return Math.min(MAX_PAGE, Math.max(100, limit * 4))
}

/** Read-only client for the public Hugging Face Hub search + model APIs. */
/**
 * How long an identical search stays fresh.
 *
 * The Hub's rankings do not move minute to minute, and the default query —
 * every mlx model by downloads — is issued whenever the search view opens. A
 * short cache makes reopening it instant instead of a second-long round trip
 * for the same answer.
 */
const SEARCH_TTL_MS = 60_000

export class HuggingFaceService {
  private readonly sizeCache = new Map<string, number | undefined>()
  private readonly paramsCache = new Map<string, number | undefined>()
  private readonly searchCache = new Map<string, { at: number; results: SearchResult }>()
  /**
   * Searches currently in flight, so two callers asking the same thing at once
   * make one request. A double-clicked button and React's development
   * double-mount both land here.
   */
  private readonly inFlight = new Map<string, Promise<SearchResult>>()

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json' }
    const token = Config.hfToken()
    if (token) h['Authorization'] = `Bearer ${token}`
    return h
  }

  /**
   * Every match found, with how much of the Hub was looked at to find them.
   *
   * Not truncated to `query.limit`: the caller reports the total and decides
   * how many to show.
   */
  async search(query: SearchQuery): Promise<SearchResult> {
    const key = JSON.stringify(query)
    const cached = this.searchCache.get(key)
    if (cached && Date.now() - cached.at < SEARCH_TTL_MS) return cached.results

    const running = this.inFlight.get(key)
    if (running) return running

    const request = this.runSearch(query).then(
      (results) => {
        this.searchCache.set(key, { at: Date.now(), results })
        this.inFlight.delete(key)
        return results
      },
      (err) => {
        // Never cache a failure: the next attempt should really retry.
        this.inFlight.delete(key)
        throw err
      },
    )
    this.inFlight.set(key, request)
    return request
  }

  /**
   * Pages until the request is genuinely satisfied.
   *
   * The old behaviour fetched one window of `limit * 3` and filtered that,
   * which quietly conflated "there are few matches" with "we only looked at
   * 150 rows". A parameter-size or quantization filter would then show a
   * handful of results while thousands existed further down the ranking. So
   * this follows the Hub's cursor until it has enough to fill the page with
   * room to spare, the results run out, or the page budget is reached — and
   * reports which of those happened rather than implying the first.
   */
  private async runSearch(query: SearchQuery): Promise<SearchResult> {
    const limit = query.limit ?? 30
    // Enough beyond the page to make "N more" meaningful without paging the
    // whole Hub for a filter that matches almost everything.
    const wanted = limit * 2
    const items: ModelSummary[] = []
    const seen = new Set<string>()
    let scanned = 0
    let url: string | undefined = buildSearchUrl({ ...query, limit: pageSize(limit) })
    let exhausted = false

    for (let page = 0; page < MAX_PAGES && url; page++) {
      log.info(`HF search: ${url}`)
      const res: Response = await fetch(url, { headers: this.headers() })
      if (!res.ok) throw new Error(`Hugging Face search failed (${res.status})`)

      const rows = (await res.json()) as HfModel[]
      scanned += rows.length
      for (const row of rows) {
        const summary = toSummary(row)
        if (!summary.id || seen.has(summary.id)) continue
        if (!matches(summary, query)) continue
        seen.add(summary.id)
        items.push(summary)
      }

      url = nextPageUrl(res.headers.get('link'))
      if (!url) exhausted = true
      if (items.length >= wanted) break
    }

    return { items, total: items.length, truncated: items.length > limit, scanned, exhausted }
  }

  /**
   * Exact weight bytes for a repo, derived from `safetensors.parameters`
   * (per-dtype element counts x width). HF never returns per-file sizes, so this
   * is the only accurate source short of downloading.
   */
  async getModelSize(repo: string): Promise<number | undefined> {
    if (!this.sizeCache.has(repo)) await this.fetchModelInfo(repo)
    return this.sizeCache.get(repo)
  }

  /**
   * Exact parameter count in billions, from `safetensors.total`. The convert
   * plan prefers this over parsing "7B" out of the repo name — many repos
   * name no size at all, and a name is a convention where this is a count.
   */
  async getParamsB(repo: string): Promise<number | undefined> {
    if (!this.paramsCache.has(repo)) await this.fetchModelInfo(repo)
    return this.paramsCache.get(repo)
  }

  private readonly typeCache = new Map<string, string | undefined>()

  /**
   * The repo's `model_type` from its config.json — what mlx-lm dispatches on.
   * The convert plan checks it against mlx-lm's registry before the download,
   * because "safetensors present" only means the weights are readable, not
   * that any MLX runtime exists for them.
   */
  async getModelType(repo: string): Promise<string | undefined> {
    if (this.typeCache.has(repo)) return this.typeCache.get(repo)
    let type: string | undefined
    try {
      const res = await fetch(`https://huggingface.co/${repo}/raw/main/config.json`, {
        headers: this.headers(),
      })
      if (res.ok) {
        const json = (await res.json()) as { model_type?: string }
        type = typeof json.model_type === 'string' ? json.model_type : undefined
      }
    } catch (err) {
      log.warn(`getModelType(${repo}) failed`, err)
    }
    this.typeCache.set(repo, type)
    return type
  }

  /** One fetch fills both caches: bytes and parameter count share a response. */
  private async fetchModelInfo(repo: string): Promise<void> {
    try {
      const url = `${HF_API}/models/${repo}`
      const res = await fetch(url, { headers: this.headers() })
      if (!res.ok) throw new Error(`model info failed (${res.status})`)
      const json = (await res.json()) as HfModelInfo
      const quant = deriveQuant(repo, json.tags)
      // Same split as toSummary: the AWQ/GPTQ/bnb family reports logical
      // counts, everything else reports stored elements.
      if (hubCountsLogicalParams(repo, json.tags)) {
        const paramsB = paramsBFromSafetensors(json.safetensors?.total)
        this.paramsCache.set(repo, paramsB)
        this.sizeCache.set(repo, paramsB !== undefined ? estimateBytesFromParams(paramsB, quant) : undefined)
      } else {
        this.sizeCache.set(repo, bytesFromSafetensors(json.safetensors?.parameters))
        this.paramsCache.set(
          repo,
          effectiveParamsB(json.safetensors?.total, json.safetensors?.parameters, repo, quant),
        )
      }
    } catch (err) {
      log.warn(`model info (${repo}) failed`, err)
      this.sizeCache.set(repo, undefined)
      this.paramsCache.set(repo, undefined)
    }
  }

  /** Resolve exact sizes for many repos with bounded concurrency. */
  async getModelSizes(repos: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {}
    const queue = [...repos]
    const workers = Array.from({ length: Math.min(SIZE_CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const repo = queue.shift()
        if (!repo) return
        const bytes = await this.getModelSize(repo)
        if (bytes) out[repo] = bytes
      }
    })
    await Promise.all(workers)
    return out
  }
}

/**
 * Does this row satisfy the filters that cannot be expressed to the Hub?
 *
 * Scope, quantization and parameter size are all decided here, from the
 * metadata the expanded search already returned — no second request per repo.
 */
function matches(m: ModelSummary, query: SearchQuery): boolean {
  if (query.scope !== 'all' && m.format === 'unsupported') return false
  if (query.quant && m.quant?.toLowerCase() !== query.quant.toLowerCase()) return false
  if (!withinParams(m.paramsB, query.params)) return false
  return true
}

function toSummary(m: HfModel): ModelSummary {
  const id = m.id ?? m.modelId ?? ''
  const tags = m.tags ?? []
  const quant = deriveQuant(id, tags)
  // The Hub reports per-dtype element counts, so weight bytes are exact rather
  // than inferred from "7B" in the name — including for the mixed-precision
  // repos where a name-based guess is worst. Except the AWQ/GPTQ/bnb family,
  // where the Hub counts logical parameters: there `total` is the parameter
  // count and the bytes have to be estimated from it instead.
  const logical = hubCountsLogicalParams(id, tags)
  const exactBytes = logical ? undefined : bytesFromSafetensors(m.safetensors?.parameters)
  const paramsB = logical
    ? (paramsBFromSafetensors(m.safetensors?.total) ??
      effectiveParamsB(m.safetensors?.total, m.safetensors?.parameters, id, quant))
    : effectiveParamsB(m.safetensors?.total, m.safetensors?.parameters, id, quant)
  const base = m.cardData?.base_model
  return {
    id,
    likes: m.likes ?? 0,
    downloads: m.downloads ?? 0,
    updatedAt: m.lastModified,
    tags,
    pipelineTag: m.pipeline_tag,
    gated: Boolean(m.gated),
    quant,
    gguf: isGguf(id, tags),
    // Present proves safetensors; absent proves nothing — the Hub omits the
    // block for gated and unusual repos — so fall back to the tag rather than
    // taking silence as a no.
    format: classifyFormat(id, tags, m.library_name, m.safetensors ? true : undefined),
    preQuantized: logical || undefined,
    paramsB,
    baseModel: (Array.isArray(base) ? base[0] : base) ?? baseModelFromTags(tags),
    sizeBytes:
      exactBytes ??
      (paramsB !== undefined ? estimateBytesFromParams(paramsB, quant) : estimateBytes(id, quant)),
    sizeExact: exactBytes !== undefined,
  }
}
