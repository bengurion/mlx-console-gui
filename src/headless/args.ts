/**
 * Command-line parsing for `mlx-console`.
 *
 * Split from the CLI entry point so it can be tested without importing the
 * whole program (and everything the program spawns).
 */
export interface ParsedArgs {
  command: string
  port?: number
  help: boolean
  json: boolean
}

/** Tiny flag parser — a dependency for this would be silly. */
export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { command: 'help', help: false, json: false }
  const rest: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--json') out.json = true
    else if (a === '--port' || a === '-p') {
      const n = Number(argv[++i])
      if (Number.isFinite(n) && n >= 0) out.port = Math.floor(n)
    } else if (a.startsWith('--port=')) {
      const n = Number(a.slice(7))
      if (Number.isFinite(n) && n >= 0) out.port = Math.floor(n)
    } else if (!a.startsWith('-')) rest.push(a)
  }

  if (rest.length) out.command = rest[0]
  else if (!out.help) out.command = 'help'
  return out
}
