import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Config } from '../config.ts'
import { log } from '../core/logging.ts'

/**
 * Process env for every Python subprocess we spawn (server + helper).
 * - `HF_HOME` points model downloads / cache / scans at the configured models
 *   directory (the cache itself lives under `<modelsDir>/hub`).
 * - `HF_TOKEN` unlocks higher rate limits and gated repos.
 *
 * The `hub/` folder is created up front: huggingface_hub raises CacheNotFound
 * when scanning a directory that does not exist yet.
 */
/**
 * Where converted models are written, and the one place that decides it.
 *
 * Both the converter and the scan that has to find the results read this, so a
 * conversion cannot land somewhere the Models page never looks.
 */
export function convertedRoot(): string {
  const modelsDir = Config.modelsDir()
  return modelsDir ? path.join(modelsDir, 'mlx-converted') : path.join(os.homedir(), 'mlx-models')
}

/**
 * Where the download list is remembered between runs.
 *
 * Beside the cache it describes, so every host pointed at the same models
 * directory sees the same interrupted downloads — plain JSON, not a database:
 * a handful of records, one writer at a time, and human-readable when
 * something needs debugging.
 */
export function downloadsStateFile(): string | undefined {
  const modelsDir = Config.modelsDir()
  if (modelsDir) return path.join(modelsDir, '.mlx-downloads.json')
  // No configured models directory (the shipped default) used to mean no
  // persistence at all — interrupted downloads silently vanished on restart.
  try {
    return path.join(os.homedir(), '.mlx-console', 'downloads.json')
  } catch {
    return undefined
  }
}

export function mlxProcessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }

  const modelsDir = Config.modelsDir()
  if (modelsDir) {
    ensureDir(path.join(modelsDir, 'hub'))
    env.HF_HOME = modelsDir
  }

  const token = Config.hfToken()
  if (token) {
    env.HF_TOKEN = token
    env.HUGGING_FACE_HUB_TOKEN = token
  }

  // hf_xet's chunk cache is what makes an interrupted download resumable
  // across process restarts (hub ≥1.x names its .incomplete files per-attempt,
  // so the partial file itself is never reused). The 10 GB default cannot
  // cover one large model's weights; 64 GiB covers everything up to a
  // gpt-oss-120b-8bit. LRU-evicted, so it only fills while downloading.
  if (!env.HF_XET_CHUNK_CACHE_SIZE_BYTES) {
    env.HF_XET_CHUNK_CACHE_SIZE_BYTES = String(64 * 1024 ** 3)
  }
  return env
}

function ensureDir(dir: string) {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    log.warn(`Could not create models directory ${dir}`, err)
  }
}
