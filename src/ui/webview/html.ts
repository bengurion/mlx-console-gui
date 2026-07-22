import * as vscode from 'vscode'
import * as crypto from 'node:crypto'
import type { ViewId } from '../../shared/protocol'
import { STYLES } from './styles'

export function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  view: ViewId,
): string {
  const nonce = crypto.randomBytes(16).toString('hex')
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'main.js'),
  )
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    `connect-src 'none'`,
  ].join('; ')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style nonce="${nonce}">${STYLES}</style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.__MLX_VIEW__ = ${JSON.stringify(view)};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
}
