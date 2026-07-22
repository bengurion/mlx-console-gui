/**
 * The Python helper, run from the CLI.
 *
 * The extension already answers "what is on this machine" by running
 * `mlx_console_helper.py` inside the managed venv with `HF_HOME` pointing at
 * the configured models directory — `huggingface_hub.scan_cache_dir()` then
 * reports exactly what the server can load. None of that needs VSCode, so the
 * CLI runs the same script with the same environment rather than re-deriving
 * the cache layout in JavaScript, which would drift the moment the Hub changes
 * its on-disk format.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import type { LocalModel } from '../shared/protocol'
import { venvBin } from './hostPaths.ts'

/** Python tracebacks end with the useful line; surface that, not the dump. */
export function pythonError(stderr: string, code: number | null): Error {
  const lines = stderr
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return new Error(lines[lines.length - 1] || `helper exited with code ${code ?? '?'}`)
}

/**
 * The helper emits one JSON object per line and may log before it; the result
 * is the last line. Same contract the extension's PythonHelper relies on.
 */
export function lastJsonLine(stdout: string): unknown {
  const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '{}'
  return JSON.parse(line)
}

/**
 * Where the helper script lives, relative to the running CLI.
 *
 * `dist/cli.js` sits beside `resources/` in both layouts that matter — a clone
 * of the repo and the unpacked extension — so one relative walk covers both.
 */
export function helperCandidates(scriptPath: string): string[] {
  const dir = path.dirname(scriptPath)
  return [
    path.join(dir, '..', 'resources', 'py', 'mlx_console_helper.py'),
    path.join(dir, '..', '..', 'resources', 'py', 'mlx_console_helper.py'),
  ].map((p) => path.normalize(p))
}

export function findHelper(
  scriptPath: string,
  exists: (p: string) => boolean = (p) => fs.existsSync(p),
): string | undefined {
  return helperCandidates(scriptPath).find(exists)
}

export interface PythonBridgeOptions {
  venv: string
  env: NodeJS.ProcessEnv
  helper: string
}

export class PythonBridge {
  private readonly opts: PythonBridgeOptions

  constructor(opts: PythonBridgeOptions) {
    this.opts = opts
  }

  /**
   * Local models, read from the configured cache directory.
   *
   * Note this is the *download* cache, not what is resident in memory — the
   * server holds at most one model and does not report which through its API.
   */
  async scan(): Promise<LocalModel[]> {
    const res = (await this.run(['scan'])) as { ok: boolean; models?: LocalModel[]; error?: string }
    if (!res.ok) throw new Error(res.error ?? 'scan failed')
    return res.models ?? []
  }

  async delete(repo: string): Promise<{ freedBytes: number }> {
    const res = (await this.run(['delete', '--repo', repo])) as {
      ok: boolean
      freedBytes?: number
      error?: string
    }
    if (!res.ok) throw new Error(res.error ?? 'delete failed')
    return { freedBytes: res.freedBytes ?? 0 }
  }

  private run(args: string[]): Promise<unknown> {
    const python = venvBin(this.opts.venv, 'python')
    return new Promise((resolve, reject) => {
      execFile(
        python,
        [this.opts.helper, ...args],
        // A cold scan of a large cache is slow; 5 minutes is generous but
        // finite, so a wedged helper cannot hang the dashboard forever.
        { env: this.opts.env, maxBuffer: 32 * 1024 * 1024, timeout: 5 * 60_000 },
        (err, stdout, stderr) => {
          if (err && !stdout.trim()) return reject(pythonError(stderr, (err as { code?: number }).code ?? null))
          try {
            resolve(lastJsonLine(stdout))
          } catch (parseErr) {
            reject(new Error(`Could not read helper output: ${String(parseErr)}`))
          }
        },
      )
    })
  }
}
