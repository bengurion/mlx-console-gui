/**
 * The first-run window's HTML.
 *
 * The Setup page is an ordinary view in the shared React bundle; what differs
 * here is the transport. There is no daemon yet — no root, no config — so
 * instead of the dashboard's HTTP/SSE shim this shell speaks over Electron
 * IPC: `acquireVsCodeApi` posts through `window.mlxSetup` (exposed by the
 * preload) and replies arrive as `window.postMessage`, the same envelope the
 * app listens for everywhere else.
 *
 * Generated rather than shipped as a static file so it reuses the real
 * stylesheet and can point at the bundle wherever the app is running from.
 */
import { BROWSER_THEME, BROWSER_UI, STYLES, THEME_INIT_JS } from '../ui/webview/styles'

export function setupHtml(bundleFileUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MLX Console GUI Setup</title>
<script>${THEME_INIT_JS}</script>
<style>
${BROWSER_THEME}
${STYLES}
${BROWSER_UI}
  body { padding: 48px 16px; }
</style>
</head>
<body>
<div id="root"></div>
<script>
window.__MLX_VIEW__ = 'setup';
window.acquireVsCodeApi = function () {
  var state = {};
  return {
    postMessage: function (m) { window.mlxSetup.post(m); },
    getState: function () { return state; },
    setState: function (s) { state = s; return s; },
  };
};
</script>
<script src="${bundleFileUrl}"></script>
</body>
</html>`
}
