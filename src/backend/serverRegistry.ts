/**
 * Cross-window shared state for the single mlx_lm.server process.
 *
 * Each VSCode window runs its own extension host, so every window has its own
 * ServerManager. The *server* is already global — one process bound to one
 * port, shared by every window and every external client — but each window's
 * view of it starts empty. In particular `/v1/models` reports what is in the
 * Hugging Face cache, not what is resident, so a second window cannot learn
 * the loaded model by asking the server.
 *
 * The window that loads a model records it in a small JSON file under the
 * extension's global storage (shared across windows for the same user). Other
 * windows read it, validate the pid is still alive, and adopt the state.
 */

export interface SharedServerState {
  /** PID of the server process, used to detect stale files. */
  pid?: number
  port: number
  loadedModel?: string
  loadedAt?: number
  lastLoadSeconds?: number
  /** Epoch ms of the last write, for staleness reporting. */
  updatedAt: number
}

/** A record older than this with a dead pid is discarded outright. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000

export function serializeState(state: SharedServerState): string {
  return JSON.stringify(state, null, 2)
}

export function parseState(text: string): SharedServerState | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const port = typeof o.port === 'number' ? o.port : undefined
  if (port === undefined) return undefined

  return {
    pid: typeof o.pid === 'number' ? o.pid : undefined,
    port,
    loadedModel: typeof o.loadedModel === 'string' ? o.loadedModel : undefined,
    loadedAt: typeof o.loadedAt === 'number' ? o.loadedAt : undefined,
    lastLoadSeconds: typeof o.lastLoadSeconds === 'number' ? o.lastLoadSeconds : undefined,
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
  }
}

/**
 * Whether a shared record describes a server this window should adopt.
 *
 * The port must match — a record for a differently configured port belongs to
 * another server. A dead pid means the process is gone, so the record is
 * discarded even if it is recent.
 */
export function isUsableState(
  state: SharedServerState | undefined,
  port: number,
  isAlive: (pid: number) => boolean,
  now: number,
): boolean {
  if (!state || state.port !== port) return false
  if (state.pid !== undefined && !isAlive(state.pid)) return false
  if (now - state.updatedAt > STALE_AFTER_MS) return false
  return true
}

/** Signal-0 liveness probe: no signal is sent, only permission is checked. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but is owned by someone else.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}
