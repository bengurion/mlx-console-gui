/**
 * Stopping every mlx_lm.server, including ones nothing is tracking.
 *
 * Shared by the extension command and the CLI so "stop everything" means the
 * same thing in both. The discovery is by process, not by registry: a server
 * outlives the window that spawned it by design, so a crash or a forced quit
 * leaves one reparented to init holding the port and the weights.
 */
import { execFile } from 'node:child_process'
import { log } from '../core/logging'
import { parsePgrepPids } from '../headless/serverControl'

/** How long a polite signal gets before insisting. */
const STOP_TIMEOUT_MS = 5000

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means it exists and is someone else's, which still counts.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

function findPids(): Promise<number[]> {
  return new Promise((resolve) => {
    execFile('pgrep', ['-f', 'mlx_lm.server'], (err, stdout) => {
      if (err && !stdout) return resolve([])
      resolve(parsePgrepPids(stdout, process.pid))
    })
  })
}

export async function stopAllServers(): Promise<{ stopped: number[]; forced: number[] }> {
  const pids = await findPids()
  const stopped: number[] = []
  const forced: number[] = []
  if (!pids.length) return { stopped, forced }

  log.info(`Stopping ${pids.length} mlx_lm.server process(es): ${pids.join(', ')}`)
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS
  let remaining = pids
  while (remaining.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
    stopped.push(...remaining.filter((pid) => !alive(pid)))
    remaining = remaining.filter(alive)
  }

  // A server mid-load ignores SIGTERM until it has finished reading weights.
  for (const pid of remaining) {
    try {
      process.kill(pid, 'SIGKILL')
      forced.push(pid)
    } catch {
      /* raced us */
    }
  }
  return { stopped, forced }
}
