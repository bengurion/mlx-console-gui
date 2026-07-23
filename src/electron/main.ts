/**
 * MLX Console as a desktop app.
 *
 * The main process is the third host after VSCode and the terminal: it runs
 * the same daemon in-process (`createDaemon`) and points a Chromium window at
 * the dashboard the daemon already serves to any browser. Nothing is rendered
 * from here — the window is a client of the same loopback HTTP server, so the
 * app, a browser tab and the VSIX all see the same UI.
 *
 * The one thing this host owns outright is first-run onboarding: everything —
 * venv, models, config, logs — is installed under a folder the user picks,
 * recorded in `~/.mlx-console/app.json` so the CLI and the extension find it.
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { setLogSink, log } from '../core/logging'
import { setSettingsSource } from '../core/settings'
import { EnvironmentManager } from '../backend/environmentManager'
import {
  createDaemon,
  loadSettings,
  settingsDefaults,
  type Daemon,
  type DaemonLogger,
} from '../headless/daemon'
import { StoreSettings } from '../headless/headlessHost'
import { readInstallRoot, writeInstallRoot } from '../headless/installRoot'
import { venvCandidates } from '../headless/hostPaths'
import { SettingsStore } from '../headless/settingsStore'
import { setupHtml } from './setupPage'
import type { HubHost } from '../ui/webview/webviewHub'
import type {
  HostBound,
  SetupDetection,
  SetupInstallParams,
  WebviewBound,
} from '../shared/protocol'

/**
 * Launched from Finder, PATH is `/usr/bin:/bin:/usr/sbin:/sbin` — no Homebrew,
 * no user installs. Python detection already tries absolute paths, but
 * anything the user configured by bare name ("python3", a custom tool) should
 * behave the way it does in their terminal.
 */
function widenPath(): void {
  const parts = (process.env.PATH ?? '').split(':').filter(Boolean)
  for (const extra of ['/opt/homebrew/bin', '/usr/local/bin']) {
    if (!parts.includes(extra)) parts.push(extra)
  }
  process.env.PATH = parts.join(':')
}

/**
 * Where the files that ship beside the app live.
 *
 * Packaged, they are `extraResources` under Contents/Resources — the argv
 * walk `findHelper` does is meaningless there, so the paths are handed to the
 * daemon explicitly. In dev, this file runs from dist/electron/, two levels
 * below the repo root.
 */
function resourceRoot(): string {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..')
}

const helperPath = () => path.join(resourceRoot(), 'resources', 'py', 'mlx_console_helper.py')
const bundlePath = () => path.join(resourceRoot(), 'dist', 'webview', 'main.js')

const appLog: DaemonLogger = {
  info: (m, ...r) => console.log(m, ...r),
  warn: (m, ...r) => console.error(m, ...r),
  error: (m, ...r) => console.error(m, ...r),
}

/**
 * Confirmations get a real modal here — unlike the headless daemon, somebody
 * is watching. Elevation is still refused: there is no terminal to type a
 * visible password into, same policy as the daemon.
 */
function desktopHubHost(getWindow: () => BrowserWindow | undefined): HubHost {
  return {
    confirm: async ({ message, detail, action }) => {
      const win = getWindow()
      const opts = {
        type: 'question' as const,
        buttons: [action, 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message,
        detail,
      }
      const { response } = win
        ? await dialog.showMessageBox(win, opts)
        : await dialog.showMessageBox(opts)
      return response === 0
    },
    reportError: (message) => log.error(message),
    reportInfo: (message) => log.info(message),
    runElevated: (command) => {
      log.warn(`Refused to run without a visible terminal: ${command}`)
      return false
    },
    openExternal: (url) => void shell.openExternal(url),
    copy: async (text) => clipboard.writeText(text),
    openSettings: () => {},
  }
}

let daemon: Daemon | undefined
let win: BrowserWindow | undefined
let quitting = false

function createWindow(): BrowserWindow {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: 'MLX Console',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })
  // Closing the window is not quitting: the daemon keeps serving the browser
  // dashboard and the VSIX client; the Dock icon reopens the window.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win?.hide()
    }
  })
  win.on('closed', () => {
    win = undefined
  })
  return win
}

function registerIpc(): void {
  ipcMain.handle('mlx:pickFolder', async () => pickFolder())
  ipcMain.handle('mlx:openPath', (_e, p: string) => void shell.showItemInFolder(p))
}

async function pickFolder(): Promise<string | undefined> {
  const opts = {
    properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
  }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return r.canceled ? undefined : r.filePaths[0]
}

/* ------------------------------------------------------------------------- *
 * First-run onboarding
 * ------------------------------------------------------------------------- */

/**
 * What this machine already has, so the Setup page can offer adoption.
 *
 * A venv is minutes of pip to recreate; a models directory can be hundreds of
 * gigabytes, which is why both default to "keep what exists".
 */
async function detect(): Promise<SetupDetection> {
  const env = new EnvironmentManager({ storageDir: path.join(os.tmpdir(), 'mlx-console-detect') })
  const python = await env.detectSystemPython()
  const existingVenv = venvCandidates().find((d) =>
    fs.existsSync(path.join(d, 'bin', 'mlx_lm.server')),
  )
  const current = loadSettings()
  const configuredModels = String(current.get('modelsDir', '') ?? '').trim()
  let freeBytes: number | undefined
  try {
    const s = fs.statfsSync(os.homedir())
    freeBytes = s.bavail * s.bsize
  } catch {
    /* shown as unknown */
  }
  return {
    python,
    existingVenv,
    existingModelsDir: configuredModels || undefined,
    defaultRoot: path.join(os.homedir(), 'MLXConsole'),
    freeBytes,
  }
}

/**
 * Build the root: directories, config, venv. The pointer file is written
 * last, deliberately — its presence is the statement that install completed,
 * so a crash mid-way re-runs onboarding instead of booting a half-built root.
 */
async function runInstall(
  params: SetupInstallParams,
  progress: (message: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  const root = params.root
  fs.mkdirSync(path.join(root, 'models', 'hub'), { recursive: true })
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true })

  // Carry over whatever the user had explicitly configured (VS Code settings
  // or ~/.mlx-console/config.json), then point paths under the root.
  const current = loadSettings()
  const seed: Record<string, unknown> = {}
  for (const key of Object.keys(current.all())) {
    if (current.sourceOf(key) !== 'default') seed[key] = current.get(key)
  }
  const store = new SettingsStore(settingsDefaults(), path.join(root, 'config.json')).load(seed)
  store.set('venvPath', params.adoptVenv ?? '')
  store.set('modelsDir', params.adoptModelsDir ?? path.join(root, 'models'))
  setSettingsSource(new StoreSettings(store))

  // With storageDir = root and no venvPath override, the managed venv is
  // created at <root>/venv — the same ensureReady the extension runs.
  const env = new EnvironmentManager({
    storageDir: root,
    progress: async (title, task) => {
      progress(title)
      return task(progress)
    },
    reportError: async (message) => {
      progress(`Error: ${message}`)
      return undefined
    },
    reportInfo: progress,
  })
  const ok = await env.ensureReady(false)
  if (!ok) return { ok: false, error: 'Setup did not complete. See the log above.' }

  writeInstallRoot(root)
  return { ok: true }
}

/** The Setup window's host: the few RPCs onboarding needs, over IPC. */
function registerSetupBridge(): void {
  ipcMain.on('mlx:setup', (event, msg: HostBound) => {
    const push = (m: WebviewBound) => event.sender.send('mlx:setup:push', m)
    const reply = (id: number, result: unknown) =>
      push({ type: 'rpcResult', id, ok: true, result })
    const fail = (id: number, error: string) => push({ type: 'rpcResult', id, ok: false, error })

    if (msg.type === 'openExternal') return void shell.openExternal(msg.url)
    if (msg.type === 'copy') return void clipboard.writeText(msg.text)
    if (msg.type !== 'rpc') return

    switch (msg.method) {
      case 'setupDetect':
        void detect().then(
          (d) => reply(msg.id, d),
          (e) => fail(msg.id, String(e)),
        )
        return
      case 'setupPickRoot':
        void pickFolder().then(
          (p) => reply(msg.id, p),
          (e) => fail(msg.id, String(e)),
        )
        return
      case 'setupInstall': {
        const params = msg.params as SetupInstallParams
        void runInstall(params, (message) =>
          push({ type: 'push', name: 'setupProgress', data: { message } }),
        ).then(
          (r) => {
            reply(msg.id, r)
            // Let the page render "complete" before the window navigates to
            // the freshly booted dashboard.
            if (r.ok) setTimeout(() => void bootRun(), 600)
          },
          (e) => fail(msg.id, e instanceof Error ? e.message : String(e)),
        )
        return
      }
      default:
        fail(msg.id, `Unknown setup method ${msg.method}`)
    }
  })
}

/* ------------------------------------------------------------------------- *
 * Boot
 * ------------------------------------------------------------------------- */

/** The window may be closed; the Dock is always there. */
function installDockMenu(): void {
  app.dock?.setMenu(
    Menu.buildFromTemplate([
      {
        label: 'Open Dashboard',
        click: () => {
          if (win) win.show()
          else if (daemon?.url) {
            const w = createWindow()
            void w.loadURL(daemon.url)
          }
        },
      },
      {
        label: 'Copy Dashboard URL',
        click: () => {
          if (daemon?.url) clipboard.writeText(daemon.url)
        },
      },
      { label: 'Start Server', click: () => void daemon?.server.start() },
      { label: 'Stop Server', click: () => void daemon?.server.stop() },
      { label: 'Restart Server', click: () => void daemon?.server.restart() },
    ]),
  )
}

async function bootRun(): Promise<void> {
  daemon = createDaemon({
    settings: loadSettings(),
    helperPath: helperPath(),
    bundlePath: bundlePath(),
    log: appLog,
    hubHost: desktopHubHost(() => win),
  })
  const url = await daemon.start()
  if (!url) {
    dialog.showErrorBox('MLX Console', 'Could not serve the dashboard on any port.')
    app.exit(1)
    return
  }
  installDockMenu()
  const w = win ?? createWindow()
  await w.loadURL(url)
  w.show()
}

async function bootSetup(): Promise<void> {
  // Written to userData rather than served: there is no HTTP server yet, and
  // a file: page can reference the bundle wherever this build keeps it.
  const file = path.join(app.getPath('userData'), 'setup.html')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, setupHtml(pathToFileURL(bundlePath()).href))
  const w = win ?? createWindow()
  await w.loadFile(file)
  w.show()
}

async function boot(): Promise<void> {
  widenPath()
  registerIpc()
  registerSetupBridge()
  setLogSink({ write: (level, message) => (level === 'ERROR' ? console.error : console.log)(message) })
  const root = readInstallRoot()
  console.log(root ? `Install root: ${root}` : 'No install root — running first-time setup.')
  if (root) await bootRun()
  else await bootSetup()
}

/** How long a graceful quit waits before exiting regardless. */
const QUIT_TIMEOUT_MS = 8000

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show()
      win.focus()
    }
  })

  app.on('activate', () => {
    // Dock click with the window hidden or closed.
    if (win) win.show()
    else if (daemon?.url) {
      const w = createWindow()
      void w.loadURL(daemon.url)
    }
  })

  app.on('window-all-closed', () => {
    /* keep running — the daemon is the app, the window is a view of it */
  })

  let stopped = false
  app.on('before-quit', (e) => {
    quitting = true
    if (stopped || !daemon) return
    e.preventDefault()
    const done = () => {
      stopped = true
      app.quit()
    }
    // Quitting deliberately stops the model servers too — an app that leaves
    // 40 GB resident after Cmd-Q did not really quit. `app.keepServerOnQuit`
    // in the root config is the escape hatch, mirroring `--keep-server`.
    const keepServer = Boolean(loadSettings().get('app.keepServerOnQuit', false))
    void daemon.stop({ keepServer }).then(done, done)
    setTimeout(done, QUIT_TIMEOUT_MS).unref()
  })

  void app.whenReady().then(boot)
}
