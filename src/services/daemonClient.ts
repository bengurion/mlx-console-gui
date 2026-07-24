/**
 * Finding the desktop app's daemon from another process.
 *
 * The daemon leaves its URL — token included, when one is required — in a
 * 0600 file that `mlx-console url` also reads. Discovery is: an explicit
 * setting first, then that file, then the default port as a last resort; each
 * candidate is probed with a real request, because a URL file can outlive the
 * process that wrote it.
 *
 * No vscode imports: the extension host uses this, but so could anything.
 */
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'

export interface DaemonEndpoint {
  /** e.g. `http://127.0.0.1:8090` — no path, no query. */
  origin: string
  token?: string
}

export function parseDaemonUrl(raw: string): DaemonEndpoint | undefined {
  try {
    const u = new URL(raw.trim())
    return { origin: u.origin, token: u.searchParams.get('t') ?? undefined }
  } catch {
    return undefined
  }
}

/** The URL a running daemon (CLI or desktop app) recorded for itself. */
function urlFromFile(home = os.homedir()): DaemonEndpoint | undefined {
  try {
    return parseDaemonUrl(fs.readFileSync(path.join(home, '.mlx-console', 'url'), 'utf8'))
  } catch {
    return undefined
  }
}

/** One request, one verdict. The endpoint is only real if it answers. */
export function probe(ep: DaemonEndpoint, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      `${ep.origin}/api/state`,
      { headers: ep.token ? { 'x-mlx-token': ep.token } : {}, timeout: timeoutMs },
      (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      },
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => resolve(false))
  })
}

/**
 * The first candidate that actually answers, or undefined.
 *
 * The bare default port comes last: another VS Code window's embedded
 * dashboard could be squatting on it, and the URL file — written only by the
 * daemon — is the more trustworthy witness.
 */
export async function discover(configuredUrl?: string): Promise<DaemonEndpoint | undefined> {
  const candidates: DaemonEndpoint[] = []
  const configured = configuredUrl?.trim() ? parseDaemonUrl(configuredUrl) : undefined
  if (configured) candidates.push(configured)
  const fromFile = urlFromFile()
  if (fromFile) candidates.push(fromFile)
  candidates.push({ origin: 'http://127.0.0.1:8090' })

  for (const ep of candidates) {
    if (await probe(ep)) return ep
  }
  return undefined
}

export const APP_PATH = '/Applications/MLX Console GUI.app'

export function appInstalled(): boolean {
  return fs.existsSync(APP_PATH)
}

/** Start the desktop app without stealing focus; resolves once `open` returns. */
export function launchApp(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('open', ['-a', 'MLX Console GUI', '--background'], (err) => resolve(!err))
  })
}
