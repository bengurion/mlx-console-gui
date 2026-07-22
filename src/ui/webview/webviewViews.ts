/**
 * The four activity-bar views.
 *
 * Everything editor-shaped about the panel lives here: registering providers,
 * building the webview HTML, and tying metrics sampling to visibility. The hub
 * itself knows none of it, which is what lets the same hub serve a browser.
 */
import * as vscode from 'vscode'
import { getWebviewHtml } from './html'
import type { WebviewHub } from './webviewHub'
import type { ViewId } from '../../shared/protocol'

const VIEW_IDS: Record<ViewId, string> = {
  search: 'mlxConsole.search',
  models: 'mlxConsole.models',
  downloads: 'mlxConsole.downloads',
  server: 'mlxConsole.server',
}

class MlxWebviewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly view: ViewId,
    private readonly hub: WebviewHub,
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
export function registerWebviews(context: vscode.ExtensionContext, hub: WebviewHub): void {
  for (const view of Object.keys(VIEW_IDS) as ViewId[]) {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        VIEW_IDS[view],
        new MlxWebviewProvider(view, hub, context.extensionUri),
        { webviewOptions: { retainContextWhenHidden: true } },
      ),
    )
  }
}
