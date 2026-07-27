/**
 * The four activity-bar views.
 *
 * Everything editor-shaped about the panel lives here: registering providers,
 * building the webview HTML, and tying metrics sampling to visibility. The hub
 * itself knows none of it, which is what lets the same hub serve a browser.
 */
import * as vscode from 'vscode'
import { getWebviewHtml } from './html'
import type { MessageSink } from './webviewHub'
import type { ViewId } from '../../shared/protocol'

/**
 * What a webview provider needs from its hub. `WebviewHub` satisfies this
 * with the real services behind it. (Panels only exist in embedded mode now —
 * remote mode shows a welcome view pointing at the desktop app instead.)
 */
export interface PanelHub {
  connect(sink: MessageSink, opts?: { sampleMetrics?: boolean }): { dispose(): void }
  handleMessage(sink: MessageSink, raw: unknown): Promise<void>
  sampleMetrics(): { dispose(): void }
}

// `setup` and `info` deliberately absent: onboarding belongs to the desktop
// app, and the README ships on the extension page itself.
const VIEW_IDS: Record<Exclude<ViewId, 'setup' | 'info'>, string> = {
  dashboard: 'mlxConsole.dashboard',
  models: 'mlxConsole.models',
  search: 'mlxConsole.search',
  downloads: 'mlxConsole.downloads',
  settings: 'mlxConsole.server',
  clients: 'mlxConsole.clients',
}

class MlxWebviewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly view: ViewId,
    private readonly hub: PanelHub,
    private readonly extensionUri: vscode.Uri,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    const webview = webviewView.webview
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.extensionUri, 'resources'),
      ],
    }
    webview.html = getWebviewHtml(webview, this.extensionUri, this.view)

    // Connected without metrics: this view samples only while visible, which
    // the visibility handler below manages.
    const connection = this.hub.connect(webview, { sampleMetrics: false })
    const sub = webview.onDidReceiveMessage((m) => void this.hub.handleMessage(webview, m))

    let metricsSub: vscode.Disposable | undefined
    const syncMetrics = () => {
      if (webviewView.visible && !metricsSub) metricsSub = this.hub.sampleMetrics()
      else if (!webviewView.visible && metricsSub) {
        metricsSub.dispose()
        metricsSub = undefined
      }
    }
    syncMetrics()
    const visSub = webviewView.onDidChangeVisibility(syncMetrics)

    webviewView.onDidDispose(() => {
      connection.dispose()
      sub.dispose()
      visSub.dispose()
      metricsSub?.dispose()
    })
  }
}

/** Registers all four webview view providers. */
export function registerWebviews(context: vscode.ExtensionContext, hub: PanelHub): void {
  for (const view of Object.keys(VIEW_IDS) as (keyof typeof VIEW_IDS)[]) {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        VIEW_IDS[view],
        new MlxWebviewProvider(view, hub, context.extensionUri),
        { webviewOptions: { retainContextWhenHidden: true } },
      ),
    )
  }
}
