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

export async function stopAllServers(): Promise<{
  stopped: number[]
  forced: number[]
  /** Alive after SIGKILL — stuck in uninterruptible GPU work, still holding wired memory. */
  survivors: number[]
}> {
  const pids = await findPids()
  const stopped: number[] = []
  const forced: number[] = []
  if (!pids.length) return { stopped, forced, survivors: [] }

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
    } catch {
      /* raced us */
    }
  }

  /*
   * SIGKILL is not the end of the story on this hardware: a process wedged in
   * an uninterruptible Metal/IOKit call survives it until the driver returns,
   * still holding the port and the wired weights. Claiming "stopped" here is
   * how zombies holding 40 GB went unnoticed — so verify, and name what
   * refused to die.
   */
  const killDeadline = Date.now() + STOP_TIMEOUT_MS
  while (remaining.length && Date.now() < killDeadline) {
    await new Promise((r) => setTimeout(r, 200))
    forced.push(...remaining.filter((pid) => !alive(pid)))
    remaining = remaining.filter(alive)
  }
  if (remaining.length) {
    log.error(
      `Still alive after SIGKILL: ${remaining.join(', ')} — likely stuck in GPU work; ` +
        'wired memory stays held until the kernel finishes the call.',
    )
  }
  return { stopped, forced, survivors: remaining }
}
