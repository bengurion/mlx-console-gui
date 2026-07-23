import { spawn } from 'node:child_process'
import * as readline from 'node:readline'
import { log } from '../core/logging'
import { convertedRoot, mlxProcessEnv } from '../util/env'
import type { EnvironmentManager } from './environmentManager'
import type { LocalModel } from '../shared/protocol'

/** Python tracebacks end with the useful line; surface that, not the whole dump. */
function pythonError(stderr: string, code: number | null): Error {
  const lines = stderr
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return new Error(lines[lines.length - 1] || `helper exited with code ${code}`)
}

export interface DownloadProgress {
  event: 'start' | 'progress' | 'done' | 'error'
  total?: number
  downloaded?: number
  nbFiles?: number
  file?: string
  message?: string
}

/** Invokes resources/py/mlx_console_helper.py inside the managed venv. */
export class PythonHelper {
  constructor(
    private readonly env: EnvironmentManager,
    private readonly scriptPath: string,
  ) {}

  private spawnEnv(): NodeJS.ProcessEnv {
    return mlxProcessEnv()
  }

  private async runJson<T>(args: string[]): Promise<T> {
    const python = this.env.venvPython
    return new Promise<T>((resolve, reject) => {
      const child = spawn(python, [this.scriptPath, ...args], { env: this.spawnEnv() })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (d) => (stdout += d.toString()))
      child.stderr?.on('data', (d) => (stderr += d.toString()))
      child.on('error', reject)
      child.on('close', (code) => {
        if (code !== 0 && !stdout.trim()) {
          if (stderr.trim()) log.error(`helper stderr:\n${stderr.trimEnd()}`)
          reject(pythonError(stderr, code))
          return
        }
        const lastLine = stdout.trim().split('\n').filter(Boolean).pop() ?? '{}'
        try {
          resolve(JSON.parse(lastLine) as T)
        } catch (err) {
          reject(new Error(`Failed to parse helper output: ${String(err)}\n${stdout}\n${stderr}`))
        }
      })
    })
  }

  async scan(): Promise<LocalModel[]> {
    // Converted models live outside the HF cache; the scan is told where to
    // look so they show up alongside downloaded ones.
    const res = await this.runJson<{ ok: boolean; models?: LocalModel[]; error?: string }>([
      'scan',
      '--local',
      convertedRoot(),
    ])
    if (!res.ok) throw new Error(res.error ?? 'scan failed')
    return res.models ?? []
  }

  async delete(repo: string): Promise<{ freedBytes: number }> {
    const res = await this.runJson<{ ok: boolean; freedBytes?: number; error?: string }>([
      'delete',
      '--repo',
      repo,
      '--local',
      convertedRoot(),
    ])
    if (!res.ok) throw new Error(res.error ?? 'delete failed')
    return { freedBytes: res.freedBytes ?? 0 }
  }

  /** Streams NDJSON progress; resolves on 'done', rejects on 'error' or abort. */
  download(
    repo: string,
    onProgress: (p: DownloadProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const python = this.env.venvPython
    return new Promise<void>((resolve, reject) => {
      const child = spawn(python, [this.scriptPath, 'download', '--repo', repo], {
        env: this.spawnEnv(),
      })
      const onAbort = () => child.kill('SIGTERM')
      signal?.addEventListener('abort', onAbort)

      const rl = readline.createInterface({ input: child.stdout! })
      let sawError: string | undefined
      rl.on('line', (line) => {
        const trimmed = line.trim()
        if (!trimmed) return
        try {
          const evt = JSON.parse(trimmed) as DownloadProgress
          onProgress(evt)
          if (evt.event === 'error') sawError = evt.message ?? 'download error'
        } catch {
          log.warn(`download: non-JSON line: ${trimmed}`)
        }
      })
      child.stderr?.on('data', (d) => log.info(`[download ${repo}] ${d.toString().trimEnd()}`))
      child.on('error', (err) => {
        signal?.removeEventListener('abort', onAbort)
        reject(err)
      })
      child.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort)
        if (signal?.aborted) return reject(new Error('canceled'))
        if (sawError) return reject(new Error(sawError))
        if (code === 0) resolve()
        else reject(new Error(`download exited with code ${code}`))
      })
    })
  }
}
