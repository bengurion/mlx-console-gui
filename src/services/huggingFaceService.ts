import { Config } from '../config'
import { log } from '../util/logger'
import { HF_API, buildSearchUrl, deriveQuant } from './hfQuery'
import { bytesFromSafetensors, classifyFormat, estimateBytes, isGguf } from './modelFit'
import type { ModelSummary, SearchQuery } from '../shared/protocol'

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
}

interface HfModelInfo {
  safetensors?: { parameters?: Record<string, number>; total?: number }
}

const SIZE_CONCURRENCY = 6

/** Read-only client for the public Hugging Face Hub search + model APIs. */
export class HuggingFaceService {
  private readonly sizeCache = new Map<string, number | undefined>()

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json' }
    const token = Config.hfToken()
    if (token) h['Authorization'] = `Bearer ${token}`
    return h
  }

  /**
   * Returns every match after filtering (not truncated to `query.limit`) so the
   * caller can report an accurate total. We over-fetch because the quant/GGUF
   * filters run client-side and would otherwise starve a limit-sized page.
   */
  async search(query: SearchQuery): Promise<ModelSummary[]> {
    const limit = query.limit ?? 30
    const fetchLimit = Math.min(1000, Math.max(limit, limit * 3))
    const url = buildSearchUrl({ ...query, limit: fetchLimit })
    log.info(`HF search: ${url}`)
    const res = await fetch(url, { headers: this.headers() })
    if (!res.ok) {
      throw new Error(`Hugging Face search failed (${res.status})`)
    }
    let items = (await res.json()) as HfModel[]
    if (query.quant) {
      const q = query.quant.toLowerCase()
      items = items.filter((m) => deriveQuant(m.id ?? m.modelId ?? '', m.tags)?.toLowerCase() === q)
    }
    let summaries = items.map(toSummary)
    // Drop what mlx-lm can neither run nor convert (GGUF, or no safetensors).
    if (query.hideGguf !== false) {
      summaries = summaries.filter((m) => m.format !== 'unsupported')
    }
    return summaries
  }

  /**
   * Exact weight bytes for a repo, derived from `safetensors.parameters`
   * (per-dtype element counts x width). HF never returns per-file sizes, so this
   * is the only accurate source short of downloading.
   */
  async getModelSize(repo: string): Promise<number | undefined> {
    if (this.sizeCache.has(repo)) return this.sizeCache.get(repo)
    try {
      const url = `${HF_API}/models/${repo}`
      const res = await fetch(url, { headers: this.headers() })
      if (!res.ok) throw new Error(`model info failed (${res.status})`)
      const json = (await res.json()) as HfModelInfo
      const bytes = bytesFromSafetensors(json.safetensors?.parameters)
      this.sizeCache.set(repo, bytes)
      return bytes
    } catch (err) {
      log.warn(`getModelSize(${repo}) failed`, err)
      this.sizeCache.set(repo, undefined)
      return undefined
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

function toSummary(m: HfModel): ModelSummary {
  const id = m.id ?? m.modelId ?? ''
  const tags = m.tags ?? []
  const quant = deriveQuant(id, tags)
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
    format: classifyFormat(id, tags, m.library_name),
    sizeBytes: estimateBytes(id, quant),
    sizeExact: false,
  }
}
