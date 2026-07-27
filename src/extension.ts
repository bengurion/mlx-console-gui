import * as vscode from 'vscode'
import { initLogger, log } from './util/logger'
import { setSettingsSource } from './core/settings'
import { VsCodeSettings, vscodeElevate, vscodeEnvHost, vscodeHubHost } from './ui/vscodeHost'
import { LEGACY_STORAGE_IDS, migrateStorage, planMigration } from './core/storageMigration'
import * as fs from 'node:fs'
import { Config } from './config'
import * as path from 'node:path'
import { EnvironmentManager } from './backend/environmentManager'
import { ServerManager } from './backend/serverManager'
import { stopAllServers } from './backend/stopAll'
import { PythonHelper } from './backend/pythonHelper'
import { HuggingFaceService } from './services/huggingFaceService'
import { CacheService } from './services/cacheService'
import { DownloadManager } from './services/downloadManager'
import { ConvertManager } from './services/convertManager'
import { StatusBar } from './ui/statusBar'
import { WebviewHub } from './ui/webview/webviewHub'
import { registerWebviews } from './ui/webview/webviewViews'
import { registerParticipant } from './chat/participant'
import { registerLmChatProvider } from './chat/lmChatProvider'
import { registerTools } from './chat/tools'
import { MetricsService } from './services/metricsService'
import { WebUiServer } from './services/webUiServer'
import { HarmonyProxy } from './services/harmonyProxy'
import { ReviewService } from './features/reviewService'
import { appInstalled, discover, launchApp } from './services/daemonClient'
import { readInstallRoot } from './headless/installRoot'
import { ignoredKeys, fingerprint, describeKeys } from './services/ignoredSettings'

/**
 * Bring the previous name's storage with us.
 *
 * VSCode derives globalStorage from `publisher.name`, so renaming the
 * extension would otherwise strand a few hundred megabytes of virtualenv and
 * the file that records which server is running. Runs once: after the move the
 * legacy directory has no venv, so the plan comes back empty.
 */
function carryStorageAcrossRename(context: vscode.ExtensionContext): void {
  const storageDir = context.globalStorageUri.fsPath
  const legacyDirs = LEGACY_STORAGE_IDS.map((id) =>
    path.join(path.dirname(storageDir), id),
  )
  const plan = planMigration({
    storageDir,
    legacyDirs,
    hasVenv: (dir) => fs.existsSync(path.join(dir, 'venv')),
  })
  if (!plan) return

  log.info(`Migrating storage from ${plan.from}`)
  const result = migrateStorage(plan)
  if (result.fallbackVenv) {
    // Could not move it — use it where it lies rather than reinstalling.
    log.warn(`Storage migration failed (${result.error}); using ${result.fallbackVenv} in place`)
    void vscode.workspace
      .getConfiguration('mlxConsole')
      .update('venvPath', result.fallbackVenv, vscode.ConfigurationTarget.Global)
    return
  }
  log.info(`Migrated ${result.moved.length} item(s) from the previous install`)
}

/**
 * Which host owns the runtime.
 *
 * `remote` — the desktop app does: the extension is a thin client of its
 * daemon. `embedded` — this extension does, as it always did. `auto` picks
 * remote exactly when the app has completed onboarding (the install-root
 * pointer exists) or a daemon URL was configured by hand, so existing users
 * see no change until they install the app.
 */
function runtimeMode(): 'remote' | 'embedded' {
  const cfg = vscode.workspace.getConfiguration('mlxConsole')
  const mode = cfg.get<string>('mode', 'auto')
  if (mode === 'remote') return 'remote'
  if (mode === 'embedded') return 'embedded'
  return readInstallRoot() || cfg.get<string>('daemonUrl', '')?.trim() ? 'remote' : 'embedded'
}

export async function activate(context: vscode.ExtensionContext) {
  initLogger()
  // Install the editor's answers to what the core asks for, before anything
  // reads a setting.
  setSettingsSource(new VsCodeSettings())
  if (runtimeMode() === 'remote') return activateRemote(context)
  // Drives the `when` clauses on the contributed views: embedded shows the
  // panels, remote shows only the welcome view pointing at the app.
  void vscode.commands.executeCommand('setContext', 'mlxConsole.embedded', true)
  log.info('MLX Console GUI activating')
  carryStorageAcrossRename(context)

  const env = new EnvironmentManager(vscodeEnvHost(context))
  const server = new ServerManager(env)
  const statusBar = new StatusBar()

  // The server is one global process shared by every window; this file lets
  // each window learn which model it already has resident.
  server.useSharedState(path.join(context.globalStorageUri.fsPath, 'server-state.json'))

  const helper = new PythonHelper(
    env,
    path.join(context.extensionPath, 'resources', 'py', 'mlx_console_helper.py'),
  )
  const hf = new HuggingFaceService()
  const cache = new CacheService(helper)
  const downloads = new DownloadManager(helper)
  const convert = new ConvertManager(env, helper)
  downloads.busyElsewhere = (repo) =>
    convert.isActive(repo) ? 'A conversion of this repo is already downloading it.' : undefined
  convert.busyElsewhere = (repo) =>
    downloads.isActive(repo) ? 'This repo is already downloading — wait for it or cancel it first.' : undefined
  convert.facts = async (repo) => {
    const [paramsB, factsRes] = await Promise.all([
      hf.getParamsB(repo).catch(() => undefined),
      hf.getConfigFacts(repo).catch(() => undefined),
    ])
    const supported = factsRes?.modelType
      ? await cache.archSupported(factsRes.modelType).catch(() => undefined)
      : undefined
    return {
      paramsB,
      arch: factsRes
        ? { modelType: factsRes.modelType, supported, prequantized: factsRes.prequantized }
        : undefined,
    }
  }
  const metrics = new MetricsService(env, server)
  metrics.elevate = vscodeElevate

  /*
   * A second endpoint that filters harmony out of responses, so clients other
   * than this extension see the answer rather than the model's reasoning and
   * control tokens. Off by default; the raw server is untouched either way.
   */
  const cleanEndpoint = new HarmonyProxy({
    upstream: () => server.baseUrl(),
    // Claude Code (and any Anthropic/OpenAI client on this port) loads models
    // lazily inside its requests; without these the registry and every panel
    // kept showing whichever model the console itself loaded last.
    onModelUse: (m) => server.beginModelUse(m),
    onModelServed: (m) => server.confirmModelLoaded(m),
    onModelFailed: () => server.abortModelLoad(),
  })
  const hub = new WebviewHub({
    env,
    server,
    hf,
    cache,
    downloads,
    convert,
    metrics,
    packageJSON: context.extension.packageJSON,
    extensionUri: context.extensionUri,
    host: vscodeHubHost(),
    cleanEndpointUrl: () => cleanEndpoint.url,
  })

  context.subscriptions.push(
    statusBar,
    { dispose: () => env.dispose() },
    { dispose: () => server.dispose() },
    { dispose: () => downloads.dispose() },
    { dispose: () => convert.dispose() },
    { dispose: () => hub.dispose() },
    metrics,
    env.onDidChange((s) => statusBar.setEnv(s)),
    server.onDidChange((s) => {
      statusBar.setServer(s.state, s.activeModel)
      statusBar.setModel(s.modelState, s.loadedModel, s.lastLoadSeconds)
    }),
  )

  registerWebviews(context, hub)

  // Local dashboard. Loopback only, and cross-site requests are refused; see
  // services/webUi.ts for why that is the check that matters.
  const webUi = new WebUiServer({
    settings: () => hub.settingsCatalog(),
    updateSetting: (key, value) => hub.updateSetting({ key, value }),
    state: () => hub.webUiState(),
    serverAction: async (action) => {
      if (action === 'start') return { ok: await server.ensureRunning(true) }
      if (action === 'stop') return await server.stop().then(() => ({ ok: true }))
      if (action === 'restart') return { ok: await server.restart() }
      return await hub.unloadModel()
    },
    log,
    notify: (message) => void vscode.window.showErrorMessage(message),
    hostLabel: 'VS Code',
    requireToken: () => Config.webUiRequireToken(),
    // Serve the panel's own UI, bridged to the same hub the panels use, so the
    // browser gets model search, downloads and conversion rather than a
    // cut-down copy of them.
    app: {
      scriptPath: path.join(context.extensionPath, 'dist', 'webview', 'main.js'),
      attach: (sink) => hub.attach(sink),
      handleMessage: (sink, message) => hub.handleMessage(sink, message),
    },
  })
  context.subscriptions.push(webUi)

  context.subscriptions.push({ dispose: () => void cleanEndpoint.stop() })

  const syncCleanEndpoint = async () => {
    if (Config.cleanEndpointEnabled()) await cleanEndpoint.start(Config.cleanEndpointPort())
    else await cleanEndpoint.stop()
  }
  void syncCleanEndpoint()

  const syncWebUi = async () => {
    // Enabled by default, so a busy port is the normal case in a second window
    // rather than an error worth interrupting anyone about: take another one.
    if (Config.webUiEnabled()) await webUi.start(Config.webUiPort(), { onBusy: 'ephemeral' })
    else await webUi.stop()
  }
  void syncWebUi()

  context.subscriptions.push(
    vscode.commands.registerCommand('mlxConsole.openWebUi', async () => {
      if (!Config.webUiEnabled()) {
        const pick = await vscode.window.showInformationMessage(
          'The local dashboard is disabled.',
          { modal: true, detail: 'Enable mlxConsole.webUi.enabled to serve it on 127.0.0.1.' },
          'Enable',
        )
        if (pick !== 'Enable') return
        await vscode.workspace
          .getConfiguration('mlxConsole')
          .update('webUi.enabled', true, vscode.ConfigurationTarget.Global)
        await syncWebUi()
      }
      const url = webUi.url
      if (!url) return void vscode.window.showErrorMessage('MLX: the dashboard is not listening.')
      // Carries the session token when one is required, so open it rather than
      // asking anyone to assemble a URL.
      void vscode.env.openExternal(vscode.Uri.parse(url))
    }),
    vscode.commands.registerCommand('mlxConsole.copyWebUiUrl', async () => {
      // For pasting into a different browser than the default handler.
      const url = webUi.url
      if (!url) return void vscode.window.showErrorMessage('MLX: the dashboard is not listening.')
      await vscode.env.clipboard.writeText(url)
      void vscode.window.showInformationMessage(
        Config.webUiRequireToken()
          ? 'MLX: dashboard URL copied (it contains the session token).'
          : 'MLX: dashboard URL copied.',
      )
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('mlxConsole.setup', () => env.ensureReady(true)),
    vscode.commands.registerCommand('mlxConsole.showLogs', () => log.show()),
    vscode.commands.registerCommand('mlxConsole.showMenu', () => showMenu(env, server)),
    // Contributed for remote mode's welcome view; in embedded there is no app,
    // so the closest thing it can open is the panel dashboard.
    vscode.commands.registerCommand('mlxConsole.openApp', () =>
      vscode.commands.executeCommand('mlxConsole.dashboard.focus'),
    ),
    vscode.commands.registerCommand('mlxConsole.startServer', () => server.ensureRunning(true)),
    vscode.commands.registerCommand('mlxConsole.stopServer', () => server.stop()),
    vscode.commands.registerCommand('mlxConsole.stopAllServers', async () => {
      /*
       * Servers are spawned detached so closing a window does not unload a
       * model — which is wanted, but means a crashed owner leaves one running
       * with nobody tracking it. This finds them by what they are rather than
       * by what we remembered, so there is a deliberate way to clean up.
       */
      const { stopped, forced, survivors } = await stopAllServers()
      const total = stopped.length + forced.length
      if (survivors.length) {
        void vscode.window.showWarningMessage(
          `MLX: pid ${survivors.join(', ')} survived SIGKILL — stuck in GPU work and still ` +
            'holding wired memory. Try again shortly.',
        )
        return
      }
      void vscode.window.showInformationMessage(
        total === 0
          ? 'MLX: no server processes were running.'
          : `MLX: stopped ${total} server${total === 1 ? '' : 's'}` +
              (forced.length ? ` (${forced.length} needed SIGKILL)` : '') +
              '.',
      )
    }),
    vscode.commands.registerCommand('mlxConsole.restartServer', () => server.restart()),
    vscode.commands.registerCommand('mlxConsole.testCompletion', () => testCompletion(server)),
    vscode.commands.registerCommand('mlxConsole.openSearch', () =>
      vscode.commands.executeCommand('mlxConsole.search.focus'),
    ),
    vscode.commands.registerCommand('mlxConsole.manageModels', () =>
      vscode.commands.executeCommand('mlxConsole.models.focus'),
    ),
    /*
     * Conversion is chosen and watched in the views now, not in a quick pick:
     * the same flow has to work in the browser dashboard, where an editor modal
     * would simply never appear. With no repo this opens the place to pick one;
     * with a repo it starts at the recommended quantization.
     */
    vscode.commands.registerCommand('mlxConsole.convertModel', async (repo?: unknown) => {
      if (typeof repo !== 'string' || !repo) {
        return vscode.commands.executeCommand('mlxConsole.search.focus')
      }
      const res = await convert.start(repo)
      if (!res.ok) return void vscode.window.showErrorMessage(`MLX: ${res.error}`)
      void vscode.commands.executeCommand('mlxConsole.downloads.focus')
    }),
  )

  // Native chat surfaces
  registerParticipant(context)
  const providerDisposable = registerLmChatProvider(server, metrics, async () =>
    env.status.ready ? (await cache.list()).map((m) => m.repo) : [],
  )
  if (providerDisposable) context.subscriptions.push(providerDisposable)
  registerTools(context, server)

  // Code review
  const review = new ReviewService()
  context.subscriptions.push(
    { dispose: () => review.dispose() },
    vscode.commands.registerCommand('mlxConsole.reviewFile', () => review.reviewActiveFile()),
    vscode.commands.registerCommand('mlxConsole.reviewDiff', () => review.reviewGitDiff()),
    vscode.commands.registerCommand('mlxConsole.explainSelection', () =>
      vscode.commands.executeCommand('workbench.action.chat.open', { query: '@mlx /explain ' }),
    ),
  )

  // Re-resolve environment and refresh panels when relevant settings change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('mlxConsole')) return
      void env.refresh().then(() => hub.refreshStatus())
      // Model metadata is looked up under modelsDir, so its caches must go.
      if (e.affectsConfiguration('mlxConsole.modelsDir')) hub.refreshModelProfile()
      if (e.affectsConfiguration('mlxConsole.webUi')) void syncWebUi()
      if (e.affectsConfiguration('mlxConsole.cleanEndpoint')) void syncCleanEndpoint()
      const serverAffecting =
        e.affectsConfiguration('mlxConsole.server') || e.affectsConfiguration('mlxConsole.modelsDir')
      if (serverAffecting && (server.state === 'ready' || server.state === 'starting')) {
        void vscode.window
          .showInformationMessage('MLX: server settings changed. Restart to apply?', 'Restart')
          .then((pick) => {
            if (pick === 'Restart') void server.restart()
          })
      }
    }),
  )

  void env.refresh().then((s) => {
    log.info(`Environment: ${s.message}`)
    void maybeOnboard(context, env, s)
  })

  log.info('MLX Console GUI activated')
}

/**
 * Thin-client activation: the desktop app owns the venv, models, downloads
 * and web server; this extension only shows the panels (proxied to the
 * daemon) and keeps the chat surfaces, which need nothing but the shared
 * server state to find the running model server.
 */
async function activateRemote(context: vscode.ExtensionContext): Promise<void> {
  log.info('MLX Console GUI activating (remote — the MLX Console GUI app owns the runtime)')
  // Hides the panel views: in remote mode the app owns the UI, and a second
  // copy of it inside the editor was two things to keep in step. Only the
  // welcome view (pointing at the app) shows in the activity bar.
  void vscode.commands.executeCommand('setContext', 'mlxConsole.embedded', false)
  const configuredUrl = () =>
    vscode.workspace.getConfiguration('mlxConsole').get<string>('daemonUrl', '')

  // Enough to adopt the running server for chat and the status bar; never
  // used to install anything — that is the app's job now.
  const env = new EnvironmentManager(vscodeEnvHost(context))
  const server = new ServerManager(env)
  const root = readInstallRoot()
  server.useSharedState(
    root
      ? path.join(root, 'server-state.json')
      : path.join(context.globalStorageUri.fsPath, 'server-state.json'),
  )
  const statusBar = new StatusBar()
  const metrics = new MetricsService(env, server)
  metrics.elevate = vscodeElevate

  context.subscriptions.push(
    statusBar,
    { dispose: () => env.dispose() },
    { dispose: () => server.dispose() },
    metrics,
    env.onDidChange((s) => statusBar.setEnv(s)),
    server.onDidChange((s) => {
      statusBar.setServer(s.state, s.activeModel)
      statusBar.setModel(s.modelState, s.loadedModel, s.lastLoadSeconds)
    }),
  )

  /** Server control goes through the daemon, which owns the processes. */
  const daemonAction = async (action: 'start' | 'stop' | 'restart') => {
    const ep = await discover(configuredUrl())
    if (!ep) return void offerLaunch()
    const res = await fetch(`${ep.origin}/api/server`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(ep.token ? { 'x-mlx-token': ep.token } : {}),
      },
      body: JSON.stringify({ action }),
    }).catch(() => undefined)
    if (!res?.ok) void vscode.window.showErrorMessage(`MLX: could not ${action} via the app.`)
  }

  const offerLaunch = async () => {
    const pick = await vscode.window.showInformationMessage(
      'The MLX Console GUI app is not running.',
      ...(appInstalled() ? ['Launch it'] : []),
    )
    if (pick === 'Launch it') void launchApp()
  }

  // The chat provider calls ensureRunning; without this it would spawn a
  // server from this editor's (client-only) settings. The daemon owns the
  // server — route the start through it instead.
  server.remoteStarter = async () => {
    const ep = await discover(configuredUrl())
    if (!ep) {
      void offerLaunch()
      return false
    }
    const res = await fetch(`${ep.origin}/api/server`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(ep.token ? { 'x-mlx-token': ep.token } : {}),
      },
      body: JSON.stringify({ action: 'start' }),
    }).catch(() => undefined)
    return Boolean(res?.ok)
  }

  /**
   * Where the panels used to be. The app owns the UI now, so anything that
   * previously focused a panel opens the app instead — or the browser
   * dashboard when the app is not installed but a daemon is reachable.
   */
  const openAppOrDashboard = async () => {
    if (appInstalled()) return void launchApp()
    const ep = await discover(configuredUrl())
    if (!ep) return void offerLaunch()
    void vscode.env.openExternal(vscode.Uri.parse(`${ep.origin}/${ep.token ? `?t=${ep.token}` : ''}`))
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('mlxConsole.startServer', () => daemonAction('start')),
    vscode.commands.registerCommand('mlxConsole.stopServer', () => daemonAction('stop')),
    vscode.commands.registerCommand('mlxConsole.restartServer', () => daemonAction('restart')),
    vscode.commands.registerCommand('mlxConsole.stopAllServers', async () => {
      const { stopped, forced, survivors } = await stopAllServers()
      const total = stopped.length + forced.length
      if (survivors.length) {
        void vscode.window.showWarningMessage(
          `MLX: pid ${survivors.join(', ')} survived SIGKILL — stuck in GPU work and still ` +
            'holding wired memory. Try again shortly.',
        )
        return
      }
      void vscode.window.showInformationMessage(
        total === 0
          ? 'MLX: no server processes were running.'
          : `MLX: stopped ${total} server${total === 1 ? '' : 's'}` +
              (forced.length ? ` (${forced.length} needed SIGKILL)` : '') +
              '.',
      )
    }),
    vscode.commands.registerCommand('mlxConsole.setup', () =>
      vscode.window.showInformationMessage(
        'Setup lives in the MLX Console GUI app now — open it to install or repair the environment.',
      ),
    ),
    vscode.commands.registerCommand('mlxConsole.showLogs', () => log.show()),
    vscode.commands.registerCommand('mlxConsole.openApp', openAppOrDashboard),
    vscode.commands.registerCommand('mlxConsole.showMenu', openAppOrDashboard),
    vscode.commands.registerCommand('mlxConsole.openSearch', openAppOrDashboard),
    // Stays routable: it is the LM chat provider's managementCommand.
    vscode.commands.registerCommand('mlxConsole.manageModels', openAppOrDashboard),
    vscode.commands.registerCommand('mlxConsole.convertModel', openAppOrDashboard),
    vscode.commands.registerCommand('mlxConsole.testCompletion', () => testCompletion(server)),
    vscode.commands.registerCommand('mlxConsole.openWebUi', async () => {
      const ep = await discover(configuredUrl())
      if (!ep) return void offerLaunch()
      const url = `${ep.origin}/${ep.token ? `?t=${ep.token}` : ''}`
      void vscode.env.openExternal(vscode.Uri.parse(url))
    }),
    vscode.commands.registerCommand('mlxConsole.copyWebUiUrl', async () => {
      const ep = await discover(configuredUrl())
      if (!ep) return void offerLaunch()
      await vscode.env.clipboard.writeText(`${ep.origin}/${ep.token ? `?t=${ep.token}` : ''}`)
      void vscode.window.showInformationMessage('MLX: dashboard URL copied.')
    }),
  )

  // Chat works off the shared server state the daemon maintains. The model
  // list for the picker comes from the daemon, which owns the cache.
  registerParticipant(context)
  const providerDisposable = registerLmChatProvider(server, metrics, async () => {
    const ep = await discover(configuredUrl())
    if (!ep) return []
    const res = await fetch(`${ep.origin}/api/state`, {
      headers: ep.token ? { 'x-mlx-token': ep.token } : {},
    }).catch(() => undefined)
    if (!res?.ok) return []
    const body = (await res.json()) as { state?: { models?: { repo?: string }[] } }
    return (body.state?.models ?? []).map((m) => m.repo).filter((r): r is string => Boolean(r))
  })
  if (providerDisposable) context.subscriptions.push(providerDisposable)
  registerTools(context, server)

  const review = new ReviewService()
  context.subscriptions.push(
    { dispose: () => review.dispose() },
    vscode.commands.registerCommand('mlxConsole.reviewFile', () => review.reviewActiveFile()),
    vscode.commands.registerCommand('mlxConsole.reviewDiff', () => review.reviewGitDiff()),
    vscode.commands.registerCommand('mlxConsole.explainSelection', () =>
      vscode.commands.executeCommand('workbench.action.chat.open', { query: '@mlx /explain ' }),
    ),
  )

  void env.refresh().then((s) => statusBar.setEnv(s))
  if (!(await discover(configuredUrl()))) void offerLaunch()
  void warnAboutIgnoredSettings(context)
  log.info('MLX Console GUI activated (remote)')
}

/**
 * Say so when VS Code settings are dead weight.
 *
 * Remote mode reads runtime settings from the app's config, not from
 * `mlxConsole.*` — but those keys still sit in settings.json looking exactly
 * like live configuration, silently drifting from what actually runs. Warn
 * once per set of offenders, and offer to delete them via the configuration
 * API (which is the one safe writer of VS Code's JSONC).
 */
async function warnAboutIgnoredSettings(context: vscode.ExtensionContext): Promise<void> {
  const manifest = context.extension.packageJSON as {
    contributes?: { configuration?: { properties?: Record<string, unknown> } }
  }
  const keys = Object.keys(manifest.contributes?.configuration?.properties ?? {})
    .filter((k) => k.startsWith('mlxConsole.'))
    .map((k) => k.slice('mlxConsole.'.length))

  const cfg = vscode.workspace.getConfiguration('mlxConsole')
  const set = keys.map((key) => {
    const i = cfg.inspect(key)
    return {
      key,
      global: i?.globalValue !== undefined,
      workspace: i?.workspaceValue !== undefined || i?.workspaceFolderValue !== undefined,
    }
  })

  const offenders = ignoredKeys(set)
  if (!offenders.length) return

  const fp = fingerprint(offenders)
  log.info(`Remote mode ignores ${offenders.length} VS Code setting(s): ${fp}`)
  const DISMISSED = 'mlxConsole.ignoredSettingsDismissed'
  if (context.globalState.get<string>(DISMISSED) === fp) return

  const pick = await vscode.window.showWarningMessage(
    `MLX: ${describeKeys(offenders)} in VS Code settings ${offenders.length === 1 ? 'is' : 'are'} ` +
      'ignored while the MLX Console GUI app owns the runtime. The app is the live store — ' +
      'edit settings in the MLX panel or its dashboard.',
    'Remove from VS Code',
    'Keep',
  )
  if (pick === 'Remove from VS Code') {
    for (const o of offenders) {
      const c = vscode.workspace.getConfiguration('mlxConsole')
      if (o.global) await c.update(o.key, undefined, vscode.ConfigurationTarget.Global)
      // A window without a workspace has nowhere to write; skip quietly.
      if (o.workspace && vscode.workspace.workspaceFolders?.length) {
        await c.update(o.key, undefined, vscode.ConfigurationTarget.Workspace).then(undefined, () => undefined)
      }
    }
    void vscode.window.showInformationMessage(
      `MLX: removed ${offenders.length} unused setting${offenders.length === 1 ? '' : 's'}.`,
    )
  } else if (pick === 'Keep') {
    await context.globalState.update(DISMISSED, fp)
  }
}

async function maybeOnboard(
  context: vscode.ExtensionContext,
  env: EnvironmentManager,
  status: { platformOk: boolean; ready: boolean },
) {
  if (!status.platformOk || status.ready) return
  if (context.globalState.get<boolean>('mlxConsole.onboarded')) return
  const pick = await vscode.window.showInformationMessage(
    'MLX Console GUI needs a one-time setup (a Python environment + mlx-lm). Set it up now?',
    'Run setup',
    'Later',
    "Don't ask again",
  )
  if (pick === 'Run setup') {
    await context.globalState.update('mlxConsole.onboarded', true)
    await env.ensureReady(true)
  } else if (pick === "Don't ask again") {
    await context.globalState.update('mlxConsole.onboarded', true)
  }
}

export function deactivate() {
  log.info('MLX Console GUI deactivating')
}

async function showMenu(env: EnvironmentManager, server: ServerManager) {
  const running = server.state === 'ready' || server.state === 'starting'
  const items: (vscode.QuickPickItem & { id: string })[] = [
    { id: 'setup', label: '$(cloud-download) Run setup / install mlx-lm' },
    { id: 'search', label: '$(search) Search Hugging Face models' },
    { id: 'models', label: '$(library) Manage models' },
    running
      ? { id: 'stop', label: '$(debug-stop) Stop server' }
      : { id: 'start', label: '$(play) Start server' },
    { id: 'restart', label: '$(debug-restart) Restart server' },
    { id: 'test', label: '$(comment-discussion) Test completion (dev)' },
    { id: 'logs', label: '$(output) Show logs' },
  ]
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'MLX Console GUI' })
  if (!pick) return
  switch (pick.id) {
    case 'setup':
      await env.ensureReady(true)
      break
    case 'search':
      await vscode.commands.executeCommand('mlxConsole.search.focus')
      break
    case 'models':
      await vscode.commands.executeCommand('mlxConsole.models.focus')
      break
    case 'start':
      await server.ensureRunning(true)
      break
    case 'stop':
      server.stop()
      break
    case 'restart':
      await server.restart()
      break
    case 'test':
      await testCompletion(server)
      break
    case 'logs':
      log.show()
      break
  }
}

/** Dev aid: stream a short completion to validate the end-to-end path. */
async function testCompletion(server: ServerManager) {
  if (!(await server.ensureRunning(true))) {
    void vscode.window.showErrorMessage('MLX server is not running.')
    return
  }
  let model = server.activeModel
  if (!model) {
    const models = await server.client.listModels().catch(() => [])
    model =
      (await vscode.window.showQuickPick(models, { placeHolder: 'Pick a model to test' })) ??
      undefined
  }
  if (!model) {
    void vscode.window.showWarningMessage('No model selected.')
    return
  }
  log.show()
  log.info(`Test completion with ${model}`)
  server.setActiveModel(model)
  try {
    let text = ''
    for await (const ev of server.client.streamChat({
      model,
      messages: [{ role: 'user', content: 'Say hello in one short sentence.' }],
      max_tokens: 64,
    })) {
      if (ev.type === 'content') {
        text += ev.text
        log.info(`[delta] ${ev.text}`)
      }
    }
    void vscode.window.showInformationMessage(`MLX: ${text.trim()}`)
  } catch (err) {
    log.error('test completion failed', err)
    void vscode.window.showErrorMessage(`Test completion failed: ${String(err)}`)
  }
}
