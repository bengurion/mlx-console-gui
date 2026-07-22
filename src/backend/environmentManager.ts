import * as vscode from 'vscode'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { log } from '../util/logger'
import { Config } from '../config'

export interface EnvStatus {
  platformOk: boolean
  pythonPath?: string
  pythonVersion?: string
  venvPath?: string
  venvPython?: string
  mlxInstalled: boolean
  mlxVersion?: string
  ready: boolean
  message: string
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env } })
    let stdout = ''
    let stderr = ''
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill()
        }, opts.timeoutMs)
      : undefined
    child.stdout?.on('data', (d) => (stdout += d.toString()))
    child.stderr?.on('data', (d) => (stderr += d.toString()))
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + String(err) })
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

const isWin = process.platform === 'win32'

/**
 * Detects the platform + Python, and owns a dedicated virtual environment
 * (under the extension's globalStorage) into which mlx-lm is installed.
 */
export class EnvironmentManager {
  private activeVenvDir: string
  private _status: EnvStatus = {
    platformOk: false,
    mlxInstalled: false,
    ready: false,
    message: 'Not checked yet',
  }
  private readonly _onDidChange = new vscode.EventEmitter<EnvStatus>()
  readonly onDidChange = this._onDidChange.event

  constructor(private readonly context: vscode.ExtensionContext) {
    this.activeVenvDir = this.managedVenvDir
  }

  /** Where the extension creates/installs its own venv (a configured override, else global storage). */
  private get managedVenvDir(): string {
    const custom = Config.venvPath()
    return custom || path.join(this.context.globalStorageUri.fsPath, 'venv')
  }

  get status(): EnvStatus {
    return this._status
  }

  get binDir(): string {
    return path.join(this.activeVenvDir, isWin ? 'Scripts' : 'bin')
  }

  get venvPython(): string {
    return path.join(this.binDir, isWin ? 'python.exe' : 'python')
  }

  /** Absolute path to a console script installed in the venv (e.g. `mlx_lm.server`). */
  binPath(name: string): string {
    return path.join(this.binDir, isWin ? `${name}.exe` : name)
  }

  private setStatus(patch: Partial<EnvStatus>) {
    this._status = { ...this._status, ...patch }
    this._onDidChange.fire(this._status)
  }

  platformOk(): boolean {
    return process.platform === 'darwin' && process.arch === 'arm64'
  }

  async detectSystemPython(): Promise<{ path: string; version: string } | undefined> {
    const override = Config.pythonPath()
    const candidates = override
      ? [override]
      : ['python3', 'python', '/opt/homebrew/bin/python3', '/usr/bin/python3']
    for (const c of candidates) {
      const r = await run(c, ['--version'], { timeoutMs: 5000 })
      if (r.code === 0) {
        return { path: c, version: (r.stdout || r.stderr).trim() }
      }
    }
    return undefined
  }

  venvExists(): boolean {
    return fs.existsSync(this.venvPython)
  }

  private venvPythonFor(dir: string): string {
    return path.join(dir, isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python')
  }

  /** Candidate venvs, most-preferred first: configured override, workspace .venv/venv, then managed. */
  private candidateVenvDirs(): string[] {
    const dirs: string[] = []
    const custom = Config.venvPath()
    if (custom) dirs.push(custom)
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      dirs.push(path.join(folder.uri.fsPath, '.venv'), path.join(folder.uri.fsPath, 'venv'))
    }
    dirs.push(this.managedVenvDir)
    return [...new Set(dirs)]
  }

  /** Adopt the first candidate venv that already has mlx-lm; else fall back to the managed venv. */
  private async resolveActiveVenv(): Promise<string> {
    for (const dir of this.candidateVenvDirs()) {
      const py = this.venvPythonFor(dir)
      if (fs.existsSync(py) && (await this.getMlxVersion(py))) {
        return dir
      }
    }
    return this.managedVenvDir
  }

  async getMlxVersion(python: string): Promise<string | undefined> {
    const r = await run(
      python,
      ['-c', 'import importlib.metadata as m; print(m.version("mlx-lm"))'],
      { timeoutMs: 8000 },
    )
    return r.code === 0 ? r.stdout.trim() : undefined
  }

  /** Re-probe platform / python / venv / mlx-lm and publish the status. */
  async refresh(): Promise<EnvStatus> {
    if (!this.platformOk()) {
      this.setStatus({
        platformOk: false,
        ready: false,
        mlxInstalled: false,
        message: 'MLX requires macOS on Apple Silicon (arm64).',
      })
      return this._status
    }
    const sys = await this.detectSystemPython()
    this.activeVenvDir = await this.resolveActiveVenv()
    const venvOk = this.venvExists()
    const mlxVersion = venvOk ? await this.getMlxVersion(this.venvPython) : undefined
    const ready = venvOk && !!mlxVersion
    this.setStatus({
      platformOk: true,
      pythonPath: sys?.path,
      pythonVersion: sys?.version,
      venvPath: venvOk ? this.activeVenvDir : undefined,
      venvPython: venvOk ? this.venvPython : undefined,
      mlxInstalled: !!mlxVersion,
      mlxVersion,
      ready,
      message: ready
        ? `Ready — mlx-lm ${mlxVersion}`
        : venvOk
          ? 'Virtual environment exists; mlx-lm is not installed.'
          : sys
            ? 'Python found; run setup to install mlx-lm.'
            : 'Python 3 not found.',
    })
    return this._status
  }

  /** Guided setup: ensure the venv exists and mlx-lm is installed. Returns true when ready. */
  async ensureReady(interactive = true): Promise<boolean> {
    if (!this.platformOk()) {
      if (interactive) {
        void vscode.window.showErrorMessage(
          'MLX Console requires macOS on Apple Silicon (arm64).',
        )
      }
      await this.refresh()
      return false
    }

    await this.refresh()
    if (this._status.ready) return true

    const sys = await this.detectSystemPython()
    if (!sys) {
      if (interactive) {
        const pick = await vscode.window.showErrorMessage(
          'MLX Console needs Python 3. Install it (e.g. `brew install python`) or set mlxConsole.pythonPath.',
          'Open Settings',
        )
        if (pick === 'Open Settings') {
          void vscode.commands.executeCommand('workbench.action.openSettings', 'mlxConsole.pythonPath')
        }
      }
      return false
    }

    if (interactive) {
      const proceed = await vscode.window.showInformationMessage(
        `MLX Console will create a Python virtual environment and install mlx-lm.\n\nPython: ${sys.version}\nLocation: ${this.managedVenvDir}`,
        { modal: true },
        'Install',
      )
      if (proceed !== 'Install') return false
    }

    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'MLX Console setup', cancellable: false },
      async (progress) => {
        try {
          this.activeVenvDir = this.managedVenvDir
          await fs.promises.mkdir(path.dirname(this.managedVenvDir), { recursive: true })

          if (!this.venvExists()) {
            progress.report({ message: 'Creating virtual environment…' })
            log.info(`Creating venv at ${this.managedVenvDir} using ${sys.path}`)
            const v = await run(sys.path, ['-m', 'venv', this.managedVenvDir], { timeoutMs: 120_000 })
            if (v.code !== 0 || !this.venvExists()) {
              log.error('venv creation failed', v.stderr)
              void vscode.window.showErrorMessage(
                'Failed to create the Python virtual environment. See MLX Console logs.',
              )
              log.show()
              return false
            }
          }

          progress.report({ message: 'Upgrading pip…' })
          await run(this.venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], {
            timeoutMs: 180_000,
          })

          progress.report({ message: 'Installing mlx-lm (this can take a few minutes)…' })
          log.info('Installing mlx-lm')
          const i = await run(this.venvPython, ['-m', 'pip', 'install', '--upgrade', 'mlx-lm'], {
            timeoutMs: 900_000,
          })
          if (i.code !== 0) {
            log.error('mlx-lm install failed', i.stderr)
            void vscode.window.showErrorMessage('Failed to install mlx-lm. See MLX Console logs.')
            log.show()
            return false
          }

          await this.refresh()
          if (this._status.ready) {
            void vscode.window.showInformationMessage(
              `MLX Console ready — mlx-lm ${this._status.mlxVersion}.`,
            )
            return true
          }
          return false
        } catch (err) {
          log.error('setup error', err)
          void vscode.window.showErrorMessage('MLX Console setup failed. See MLX Console logs.')
          log.show()
          return false
        }
      },
    )
  }

  dispose() {
    this._onDidChange.dispose()
  }
}
