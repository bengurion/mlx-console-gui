import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { log } from '../core/logging'
import { Config } from '../config'
import {
  cacheDirName,
  isLocalPath,
  kvBytesPerToken,
  parseAttentionShape,
  parseContextLength,
  parseGenerationDefaults,
  parseVocabSize,
  type GenerationDefaults,
} from './modelConfig'

/**
 * Finds a model's `config.json` in the Hugging Face cache (or a converted
 * model's directory) and reads its context length.
 *
 * Results are memoised per model id, including misses, so the lookup runs once
 * rather than on every `provideLanguageModelChatInformation` call.
 */
export class ModelConfigReader {
  private readonly cache = new Map<string, number | undefined>()
  private readonly kvCache = new Map<string, number | undefined>()
  private readonly weightCache = new Map<string, number | undefined>()
  private readonly genCache = new Map<string, GenerationDefaults>()
  private readonly vocabCache = new Map<string, number | undefined>()

  /** Root of the HF cache: `<modelsDir>/hub`, else the default location. */
  private hubRoot(): string {
    const dir = Config.modelsDir()
    return dir
      ? path.join(dir, 'hub')
      : path.join(os.homedir(), '.cache', 'huggingface', 'hub')
  }

  /** Candidate `config.json` paths for a model id, best first. */
  private candidates(modelId: string): string[] {
    if (isLocalPath(modelId)) return [path.join(modelId, 'config.json')]

    const repoDir = path.join(this.hubRoot(), cacheDirName(modelId))
    const snapshots = path.join(repoDir, 'snapshots')
    let revisions: string[] = []
    try {
      revisions = fs.readdirSync(snapshots)
    } catch {
      return []
    }
    return revisions.map((rev) => path.join(snapshots, rev, 'config.json'))
  }

  /** Trained context length for a model, or undefined when unknown. */
  contextLength(modelId: string): number | undefined {
    if (this.cache.has(modelId)) return this.cache.get(modelId)

    let found: number | undefined
    for (const file of this.candidates(modelId)) {
      let text: string
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        continue
      }
      found = parseContextLength(text)
      if (found !== undefined) {
        log.info(`Context length for ${modelId}: ${found} (from ${path.basename(file)})`)
        break
      }
    }
    if (found === undefined) {
      log.info(`No context length found for ${modelId}; using the configured default`)
    }
    this.cache.set(modelId, found)
    return found
  }

  /**
   * KV cache bytes per token, from the model's attention shape.
   * Undefined when the config cannot be read or lacks the needed fields.
   */
  kvBytesPerToken(modelId: string): number | undefined {
    if (this.kvCache.has(modelId)) return this.kvCache.get(modelId)
    let result: number | undefined
    for (const file of this.candidates(modelId)) {
      let text: string
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const shape = parseAttentionShape(text)
      if (shape) {
        result = kvBytesPerToken(shape)
        log.info(
          `KV cache for ${modelId}: ${(result / 1024).toFixed(0)} KiB/token ` +
            `(${shape.layers}L x ${shape.kvHeads}kv x ${shape.headDim}d)`,
        )
        break
      }
    }
    this.kvCache.set(modelId, result)
    return result
  }

  /**
   * On-disk weight bytes, summed from the snapshot's safetensors shards.
   * Cache snapshots are symlinks into `blobs/`, so sizes are followed through.
   */
  weightBytes(modelId: string): number | undefined {
    if (this.weightCache.has(modelId)) return this.weightCache.get(modelId)
    let total = 0
    for (const file of this.candidates(modelId)) {
      const dir = path.dirname(file)
      let entries: string[]
      try {
        entries = fs.readdirSync(dir)
      } catch {
        continue
      }
      for (const name of entries) {
        if (!name.endsWith('.safetensors')) continue
        try {
          total += fs.statSync(path.join(dir, name)).size
        } catch {
          /* dangling link */
        }
      }
      if (total > 0) break
    }
    const result = total > 0 ? total : undefined
    this.weightCache.set(modelId, result)
    return result
  }

  /**
   * Sampling defaults the model ships in `generation_config.json`, if any.
   * Sits between the extension defaults and the user's own settings.
   */
  generationDefaults(modelId: string): GenerationDefaults {
    const hit = this.genCache.get(modelId)
    if (hit) return hit

    let result: GenerationDefaults = {}
    for (const file of this.candidates(modelId)) {
      const genFile = path.join(path.dirname(file), 'generation_config.json')
      let text: string
      try {
        text = fs.readFileSync(genFile, 'utf8')
      } catch {
        continue
      }
      result = parseGenerationDefaults(text)
      if (Object.keys(result).length > 0) {
        log.info(`Generation defaults for ${modelId}: ${JSON.stringify(result)}`)
      }
      break
    }
    this.genCache.set(modelId, result)
    return result
  }

  /** Vocabulary size, required to match a draft model to a target. */
  vocabSize(modelId: string): number | undefined {
    if (this.vocabCache.has(modelId)) return this.vocabCache.get(modelId)
    let result: number | undefined
    for (const file of this.candidates(modelId)) {
      try {
        result = parseVocabSize(fs.readFileSync(file, 'utf8'))
      } catch {
        continue
      }
      if (result !== undefined) break
    }
    this.vocabCache.set(modelId, result)
    return result
  }

  /** Drop memoised values, e.g. after the models directory changes. */
  clear(): void {
    this.cache.clear()
    this.kvCache.clear()
    this.weightCache.clear()
    this.genCache.clear()
    this.vocabCache.clear()
  }
}
