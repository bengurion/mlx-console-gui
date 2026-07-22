/**
 * One log, whichever host is running.
 *
 * The extension routes this to an output channel, the CLI to stdout. Kept as a
 * swappable sink rather than an injected parameter because logging threads
 * through every layer, and passing a logger to everything to satisfy a purity
 * rule would be worse code than a module-level default.
 */

export interface LogSink {
  write(level: string, message: string): void
  show?(): void
}

function fmt(v: unknown): string {
  if (v instanceof Error) return v.stack ?? v.message
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** Until a host installs its own, log to the console. */
let sink: LogSink = {
  write: (level, message) => {
    const out = level === 'ERROR' ? console.error : console.log
    out(`[${level}] ${message}`)
  },
}

export function setLogSink(next: LogSink): void {
  sink = next
}

function write(level: string, msg: string, rest: unknown[]) {
  const stamp = new Date().toISOString()
  const extra = rest.length ? ' ' + rest.map(fmt).join(' ') : ''
  sink.write(level, `[${stamp}] [${level}] ${msg}${extra}`)
}

export const log = {
  info(msg: string, ...rest: unknown[]) {
    write('INFO', msg, rest)
  },
  warn(msg: string, ...rest: unknown[]) {
    write('WARN', msg, rest)
  },
  error(msg: string, ...rest: unknown[]) {
    write('ERROR', msg, rest)
  },
  show() {
    sink.show?.()
  },
}
