/**
 * One-time authorisation for per-process GPU sampling.
 *
 * `powermetrics` is the only way macOS attributes GPU time to a process, and
 * it requires root. Polling it every 20 seconds cannot mean holding a password
 * — so this takes the password exactly once, uses it to install a sudoers rule
 * for that single command, and forgets it. Afterwards `sudo -n` succeeds
 * without any prompt and the sampler can run on a timer.
 *
 * What the rule grants is deliberately narrow:
 *
 *  - one absolute binary, `/usr/bin/powermetrics`, which is read-only telemetry
 *  - one exact argument list, with no wildcards, so it cannot be re-aimed
 *  - one output path we own, so the command cannot be pointed at a file it
 *    would otherwise have no business writing
 *
 * The password itself is written to a child process's stdin and never stored,
 * logged, echoed back, or included in any error. It exists in memory for the
 * length of one call.
 */
import * as os from 'node:os'
import * as path from 'node:path'

/** Where the drop-in rule lives. Removing this file revokes the grant. */
export const SUDOERS_PATH = '/etc/sudoers.d/mlx-console'

export const POWERMETRICS_BIN = '/usr/bin/powermetrics'
export const VISUDO_BIN = '/usr/sbin/visudo'
export const INSTALL_BIN = '/usr/bin/install'

/**
 * Where powermetrics writes its sample.
 *
 * Fixed, not per-process: the sudoers rule spells out the exact command, and a
 * path containing a pid would need a wildcard, which is precisely the loose
 * grant this is trying to avoid. It sits in our own directory rather than
 * /tmp, where any local user could pre-create the name.
 */
export function samplePath(home = os.homedir()): string {
  return path.join(home, '.mlx-console', 'powermetrics.txt')
}

/** The exact command the rule authorises, and the sampler runs. */
export function sampleCommand(home = os.homedir(), intervalMs = 1000): string[] {
  return [
    POWERMETRICS_BIN,
    '--samplers',
    'tasks',
    '--show-process-gpu',
    '-n',
    '1',
    '-i',
    String(intervalMs),
    '-o',
    samplePath(home),
  ]
}

/** What to run by hand when a host cannot prompt — the same command, verbatim. */
export function manualCommand(home = os.homedir()): string {
  return `sudo ${sampleCommand(home).join(' ')}`
}

/**
 * The sudoers drop-in.
 *
 * A trailing newline matters: visudo rejects a file without one. The command
 * is written in full, so sudo matches it exactly rather than by prefix.
 */
export function sudoersRule(user: string, command: string[] = sampleCommand()): string {
  return [
    '# Installed by MLX Console so per-process GPU sampling can run unattended.',
    '# Grants exactly one read-only telemetry command. Delete this file to revoke,',
    '# or use Disable in the Dashboard view.',
    `${user} ALL=(root) NOPASSWD: ${command.join(' ')}`,
    '',
  ].join('\n')
}

/**
 * Reject a username that could break out of the rule.
 *
 * The name comes from the OS rather than from input, but it is interpolated
 * into a privileged config file, so it is checked anyway.
 */
export function isSafeUserName(user: string): boolean {
  return /^[a-z_][a-z0-9_.-]*$/i.test(user) && user.length <= 32
}

/** True when `sudo -n -l <bin>` reports the command is allowed without a password. */
export function grantsPasswordless(exitCode: number | null): boolean {
  return exitCode === 0
}

/**
 * Strip anything that looks like a password from text destined for a log.
 *
 * Defence in depth: nothing here should ever receive one, and this makes a
 * mistake harmless rather than permanent.
 */
export function scrubForLog(text: string): string {
  return (
    text
      // Order matters, and the replacements must not contain the word the
      // second pattern looks for — otherwise it rewrites the first's output.
      .replace(/^\[?sudo\]? password.*$/gim, '[credential prompt]')
      .replace(/password[^\n]*/gi, '[redacted]')
  )
}
