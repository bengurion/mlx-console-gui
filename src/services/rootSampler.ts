/**
 * Running the privileged sampler, and asking for the password once.
 *
 * See rootAccess.ts for what the grant covers and why it is shaped that way.
 * This is the part that actually spawns things; it is kept apart so the policy
 * — the rule text, the paths, the redaction — stays testable without spawning
 * anything at all.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { log } from '../core/logging'
import { parseProcessGpu, type ProcessGpuSample } from './powermetrics'
import {
  INSTALL_BIN,
  POWERMETRICS_BIN,
  SUDOERS_PATH,
  VISUDO_BIN,
  isSafeUserName,
  sampleCommand,
  samplePath,
  scrubForLog,
  sudoersRule,
} from './rootAccess'

export interface RootResult {
  ok: boolean
  error?: string
}

export interface SampleResult {
  ok: boolean
  samples?: ProcessGpuSample[]
  error?: string
}

/**
 * Run a command, optionally feeding a password to `sudo -S` on stdin.
 *
 * `-p ''` suppresses sudo's own prompt so nothing waits on a terminal that is
 * not there. The password is written once and the stream closed immediately.
 */
function run(
  bin: string,
  args: string[],
  password?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', (err) => resolve({ code: null, stdout, stderr: String(err) }))
    child.on('close', (code) => resolve({ code, stdout, stderr }))

    if (password !== undefined) child.stdin.write(password + '\n')
    child.stdin.end()
  })
}

export class RootSampler {
  private readonly home: string

  constructor(home = os.homedir()) {
    this.home = home
  }

  /** Is the grant already in place? Cheap enough to call on every page load. */
  async isEnabled(): Promise<boolean> {
    const { code } = await run('sudo', ['-n', '-l', POWERMETRICS_BIN])
    return code === 0
  }

  /**
   * Install the sudoers rule, using the password exactly once.
   *
   * Validated with visudo before it is installed: a malformed drop-in can lock
   * sudo out entirely, and that is not a state to leave someone's machine in.
   */
  async enable(password: string): Promise<RootResult> {
    const user = os.userInfo().username
    if (!isSafeUserName(user)) return { ok: false, error: `Unusable account name: ${user}` }

    const staging = path.join(this.home, '.mlx-console', 'sudoers.staged')
    try {
      fs.mkdirSync(path.dirname(staging), { recursive: true })
      fs.writeFileSync(staging, sudoersRule(user), { mode: 0o600 })

      // First call carries the password and also warms sudo's timestamp, so
      // the install below needs no second prompt.
      const check = await run('sudo', ['-S', '-p', '', VISUDO_BIN, '-cf', staging], password)
      if (check.code !== 0) {
        const why = /incorrect password|Sorry, try again/i.test(check.stderr)
          ? 'That password was not accepted.'
          : `Rule rejected by visudo: ${scrubForLog(check.stderr || check.stdout).trim()}`
        return { ok: false, error: why }
      }

      const install = await run('sudo', [
        '-n',
        INSTALL_BIN,
        '-m',
        '0440',
        '-o',
        'root',
        '-g',
        'wheel',
        staging,
        SUDOERS_PATH,
      ])
      if (install.code !== 0) {
        return { ok: false, error: scrubForLog(install.stderr).trim() || 'Could not install the rule.' }
      }

      if (!(await this.isEnabled())) {
        return { ok: false, error: 'The rule installed but sudo still asks for a password.' }
      }
      log.info(`Per-process GPU sampling authorised for ${user} (${SUDOERS_PATH})`)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: scrubForLog(String(err)) }
    } finally {
      // The staged copy is not a secret, but it has no reason to persist.
      try {
        fs.unlinkSync(staging)
      } catch {
        /* already gone */
      }
    }
  }

  /** Revoke the grant. Needs the password again — removing it is privileged. */
  async disable(password?: string): Promise<RootResult> {
    const args = ['-S', '-p', '', '/bin/rm', '-f', SUDOERS_PATH]
    const res = await run('sudo', password === undefined ? ['-n', '/bin/rm', '-f', SUDOERS_PATH] : args, password)
    if (res.code !== 0) {
      return { ok: false, error: scrubForLog(res.stderr).trim() || 'Could not remove the rule.' }
    }
    log.info('Per-process GPU sampling authorisation removed')
    return { ok: true }
  }

  /**
   * Take one sample. Requires the grant; never prompts.
   *
   * The output file is removed first so a stale sample cannot be mistaken for
   * a fresh one if powermetrics fails to write.
   */
  private inFlight: Promise<SampleResult> | undefined

  async sample(): Promise<SampleResult> {
    /*
     * One at a time. The output path is fixed — it has to be, because the
     * sudoers rule names it exactly and a wildcard would widen the grant — so
     * two concurrent samples delete and rewrite the same file underneath each
     * other. That produced a truncated file and an empty result whenever the
     * 20-second timer overlapped a manual sample.
     */
    if (this.inFlight) return this.inFlight
    this.inFlight = this.sampleNow().finally(() => {
      this.inFlight = undefined
    })
    return this.inFlight
  }

  private async sampleNow(): Promise<SampleResult> {
    const out = samplePath(this.home)
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true })
      fs.rmSync(out, { force: true })
    } catch {
      /* first run */
    }

    const res = await run('sudo', ['-n', ...sampleCommand(this.home)])
    if (res.code !== 0) {
      return { ok: false, error: scrubForLog(res.stderr).trim() || 'powermetrics failed.' }
    }
    try {
      const text = fs.readFileSync(out, 'utf8')
      const samples = parseProcessGpu(text)
      // powermetrics writes a preamble before the task table. A file with the
      // preamble and nothing else means the run was cut short — reporting that
      // as "no process used the GPU" would be a lie.
      if (!samples.length && !/GPU\s*ms\/s/i.test(text)) {
        return { ok: false, error: 'powermetrics produced no task table; try sampling again.' }
      }
      return { ok: true, samples }
    } catch (err) {
      return { ok: false, error: `Could not read the sample: ${String(err)}` }
    }
  }
}
