import * as fs from 'node:fs'
import * as path from 'node:path'
import { Config } from '../config'
import { log } from './logger'

/**
 * Process env for every Python subprocess we spawn (server + helper).
 * - `HF_HOME` points model downloads / cache / scans at the configured models
 *   directory (the cache itself lives under `<modelsDir>/hub`).
 * - `HF_TOKEN` unlocks higher rate limits and gated repos.
 *
 * The `hub/` folder is created up front: huggingface_hub raises CacheNotFound
 * when scanning a directory that does not exist yet.
 */
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
  return env
}

function ensureDir(dir: string) {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    log.warn(`Could not create models directory ${dir}`, err)
  }
}
