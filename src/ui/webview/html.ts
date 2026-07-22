import * as vscode from 'vscode'
import * as crypto from 'node:crypto'
import type { ViewId } from '../../shared/protocol'

const STYLES = /* css */ `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 8px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
  }
  h2, h3 { font-weight: 600; margin: 4px 0 8px; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .row { display: flex; gap: 6px; align-items: center; }
  .col { display: flex; flex-direction: column; gap: 6px; }
  .wrap { flex-wrap: wrap; }
  .spread { justify-content: space-between; }
  .muted { color: var(--vscode-descriptionForeground); }
  .small { font-size: 0.85em; }
  input[type=text], input[type=search], select {
    width: 100%;
    padding: 4px 6px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
  }
  label.check { display: inline-flex; gap: 4px; align-items: center; cursor: pointer; }
  button {
    padding: 4px 10px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  .card {
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
    border-radius: 6px;
    padding: 8px 10px;
    margin-bottom: 8px;
  }
  .card.active { border-color: var(--vscode-focusBorder); }
  .badge {
    display: inline-block;
    padding: 0 6px;
    border-radius: 8px;
    font-size: 0.8em;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  .tag {
    display: inline-block;
    padding: 0 5px;
    margin: 2px 2px 0 0;
    border-radius: 4px;
    font-size: 0.78em;
    background: var(--vscode-editorWidget-background, rgba(128,128,128,0.15));
    color: var(--vscode-descriptionForeground);
  }
  .bar { height: 6px; border-radius: 3px; background: rgba(128,128,128,0.25); overflow: hidden; }
  .bar > span { display: block; height: 100%; background: var(--vscode-progressBar-background); }
  pre.snippet {
    white-space: pre-wrap;
    word-break: break-all;
    padding: 8px;
    border-radius: 4px;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em;
  }
  .empty { padding: 24px 8px; text-align: center; }
  .divider { height: 1px; background: var(--vscode-panel-border, rgba(128,128,128,0.25)); margin: 10px 0; }
`

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
