import * as vscode from 'vscode'
import { initLogger, log } from './util/logger'
import { Config } from './config'
import * as path from 'node:path'
import { EnvironmentManager } from './backend/environmentManager'
import { ServerManager } from './backend/serverManager'
import { PythonHelper } from './backend/pythonHelper'
import { HuggingFaceService } from './services/huggingFaceService'
import { CacheService } from './services/cacheService'
import { DownloadManager } from './services/downloadManager'
import { ConvertManager } from './services/convertManager'
import { StatusBar } from './ui/statusBar'
import { WebviewHub, registerWebviews } from './ui/webview/webviewHub'
import { registerParticipant } from './chat/participant'
import { registerLmChatProvider } from './chat/lmChatProvider'
import { registerTools } from './chat/tools'
import { MetricsService } from './services/metricsService'
import { WebUiServer } from './services/webUiServer'
import { ReviewService } from './features/reviewService'

export async function activate(context: vscode.ExtensionContext) {
  initLogger()
  log.info('MLX Console activating')

  const env = new EnvironmentManager(context)
  const server = new ServerManager(env)
  const statusBar = new StatusBar()

  // The server is one global process shared by every window; this file lets
  // each window learn which model it already has resident.
  server.useSharedState(vscode.Uri.joinPath(context.globalStorageUri, 'server-state.json'))

  const helper = new PythonHelper(
    env,
    path.join(context.extensionPath, 'resources', 'py', 'mlx_console_helper.py'),
  )
  const hf = new HuggingFaceService()
  const cache = new CacheService(helper)
  const downloads = new DownloadManager(helper)
  const convert = new ConvertManager(env, server)
  const metrics = new MetricsService(env, server)
  const hub = new WebviewHub({
    env,
    server,
    hf,
    cache,
    downloads,
    metrics,
    packageJSON: context.extension.packageJSON,
    extensionUri: context.extensionUri,
  })

  context.subscriptions.push(
    statusBar,
    { dispose: () => env.dispose() },
    { dispose: () => server.dispose() },
    { dispose: () => downloads.dispose() },
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
  })
  context.subscriptions.push(webUi)

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
    vscode.commands.registerCommand('mlxConsole.startServer', () => server.ensureRunning(true)),
    vscode.commands.registerCommand('mlxConsole.stopServer', () => server.stop()),
    vscode.commands.registerCommand('mlxConsole.restartServer', () => server.restart()),
    vscode.commands.registerCommand('mlxConsole.testCompletion', () => testCompletion(server)),
    vscode.commands.registerCommand('mlxConsole.openSearch', () =>
      vscode.commands.executeCommand('mlxConsole.search.focus'),
    ),
    vscode.commands.registerCommand('mlxConsole.manageModels', () =>
      vscode.commands.executeCommand('mlxConsole.models.focus'),
    ),
    vscode.commands.registerCommand('mlxConsole.convertModel', (repo?: unknown) =>
      convert.convertInteractive(typeof repo === 'string' ? repo : undefined),
    ),
  )

  // Native chat surfaces
  registerParticipant(context)
  const providerDisposable = registerLmChatProvider(server, metrics)
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

  log.info('MLX Console activated')
}

async function maybeOnboard(
  context: vscode.ExtensionContext,
  env: EnvironmentManager,
  status: { platformOk: boolean; ready: boolean },
) {
  if (!status.platformOk || status.ready) return
  if (context.globalState.get<boolean>('mlxConsole.onboarded')) return
  const pick = await vscode.window.showInformationMessage(
    'MLX Console needs a one-time setup (a Python environment + mlx-lm). Set it up now?',
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
  log.info('MLX Console deactivating')
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
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'MLX Console' })
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
