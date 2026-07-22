import * as http from 'node:http'
import * as fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import {
  authorize,
  isRedactedPlaceholder,
  parseServerAction,
  redactSettings,
  routeOf,
} from './webUi.ts'
import type { SettingSpec } from '../shared/protocol'
import { BROWSER_THEME, STYLES } from '../ui/webview/styles.ts'

/** Refuse absurd bodies rather than buffering whatever arrives. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Just enough logging to run in either host: the extension routes this to its
 * output channel, the CLI to stdout.
 */
export interface WebUiLogger {
  info(msg: string, ...rest: unknown[]): void
  error(msg: string, ...rest: unknown[]): void
}

/**
 * The full panel UI, offered to the browser.
 *
 * When present, the dashboard serves the extension's own React bundle and
 * bridges its message protocol over HTTP — so model search, downloads,
 * conversion and metrics are the same code as the panel, not a second
 * implementation drifting alongside it. Absent (the headless daemon, which has
 * no extension host behind it) the dashboard falls back to its compact page.
 */
export interface WebUiApp {
  /** Path to the built webview bundle. */
  scriptPath: string
  attach(sink: MessageSink): () => void
  handleMessage(sink: MessageSink, message: unknown): Promise<void>
}

export interface MessageSink {
  postMessage(message: unknown): unknown
}

export interface WebUiDeps {
  settings(): SettingSpec[]
  updateSetting(key: string, value: unknown): Promise<{ ok: boolean; error?: string }>
  state(): Promise<unknown>
  serverAction(action: 'start' | 'stop' | 'restart' | 'clear'): Promise<{ ok: boolean }>
  log: WebUiLogger
  /** Surface a failure to the user; a modal in VSCode, stderr in the CLI. */
  notify?(message: string): void
  /** Shown in the page header so you can tell the two dashboards apart. */
  hostLabel?: string
  /** Demand a token as well as the cross-site checks. Off by default. */
  requireToken?(): boolean
  /** Serve the panel UI itself rather than the compact fallback page. */
  app?: WebUiApp
}

/**
 * A small editable dashboard on loopback.
 *
 * Binds to 127.0.0.1 explicitly — never 0.0.0.0, whatever the server's own LAN
 * setting says, because this endpoint can change settings and stop processes.
 * Cross-site requests are refused whatever the settings say; a per-session
 * token is available on top. See `webUi.ts` for why localhost alone is not a
 * boundary.
 */
export class WebUiServer {
  private server: http.Server | undefined
  private readonly token = randomBytes(24).toString('base64url')
  private port: number | undefined
  /** Live browser clients of the panel protocol, keyed by their SSE stream. */
  private readonly clients = new Map<string, BridgeClient>()

  private readonly deps: WebUiDeps

  constructor(deps: WebUiDeps) {
    this.deps = deps
  }

  /**
   * The address to open. The token is only in the URL when it is required —
   * otherwise this is a plain, bookmarkable, paste-anywhere localhost link.
   */
  get url(): string | undefined {
    if (!this.port) return undefined
    const base = `http://127.0.0.1:${this.port}/`
    return this.deps.requireToken?.() ? `${base}?t=${this.token}` : base
  }

  /**
   * Listen, and say where.
   *
   * `onBusy: 'ephemeral'` is what every window past the first does: each window
   * has its own token and cannot share another's dashboard, so competing for
   * one port would mean all but one window has no dashboard at all. Taking an
   * OS-assigned port instead means every window has a working one — you reach
   * it through the palette command, which knows its own port.
   */
  async start(port: number, opts: { onBusy?: 'ephemeral' | 'fail' } = {}): Promise<string | undefined> {
    await this.stop()
    const server = http.createServer((req, res) => void this.handle(req, res))

    return new Promise((resolve) => {
      server.on('error', (err) => {
        const busy = (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
        if (busy && opts.onBusy === 'ephemeral' && port !== 0) {
          this.deps.log.info(`Web UI port ${port} is taken; using an OS-assigned port instead`)
          return void this.start(0, { onBusy: 'fail' }).then(resolve)
        }
        this.deps.log.error(`Web UI could not listen on ${port}`, err)
        this.deps.notify?.(
          busy
            ? `MLX: port ${port} is already in use — another VS Code window or the headless daemon may already be serving the dashboard. Open it from there, or change Web Ui: Port.`
            : `MLX: web UI failed to start — ${String(err)}`,
        )
        resolve(undefined)
      })
      // Explicit loopback bind; do not honour exposeToLan here.
      server.listen(port, '127.0.0.1', () => {
        this.server = server
        const addr = server.address()
        this.port = typeof addr === 'object' && addr ? addr.port : port
        this.deps.log.info(
          `Web UI listening on http://127.0.0.1:${this.port}` +
            (this.deps.requireToken?.() ? ' (token required)' : ''),
        )
        resolve(this.url)
      })
    })
  }

  /**
   * Stop listening, and actually finish.
   *
   * `close()` stops accepting connections but only calls back once every open
   * one has ended — and the dashboard holds an event stream open for as long
   * as the tab exists. Waiting for that means a daemon that never exits on
   * Ctrl-C while a browser tab is open, which looks exactly like a hang. So
   * live connections are ended deliberately rather than waited on.
   */
  async stop(): Promise<void> {
    const s = this.server
    if (!s) return
    this.server = undefined
    this.port = undefined

    for (const [id, client] of this.clients) {
      client.close?.()
      this.clients.delete(id)
    }
    await new Promise<void>((resolve) => {
      s.close(() => resolve())
      // Node 18.2+; the loop above already ended the streams we know about,
      // this catches anything mid-request.
      s.closeAllConnections?.()
    })
    this.deps.log.info('Web UI stopped')
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const auth = authorize({
      host: req.headers.host,
      token: this.token,
      givenToken: url.searchParams.get('t') ?? (req.headers['x-mlx-token'] as string | undefined),
      method: req.method,
      contentType: req.headers['content-type'],
      secFetchSite: req.headers['sec-fetch-site'] as string | undefined,
      origin: req.headers.origin as string | undefined,
      requireToken: this.deps.requireToken?.() ?? false,
    })
    if (!auth.ok) {
      res.writeHead(auth.status, { 'content-type': 'text/plain' })
      return void res.end(auth.reason)
    }

    const route = routeOf(url.pathname)
    try {
      if (route.kind === 'page') {
        const nonce = randomBytes(16).toString('hex')
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          // Same posture as the panel's own CSP: nothing external, scripts by
          // nonce. `connect-src 'self'` is the one addition — the browser
          // transport needs to reach its own origin.
          'content-security-policy': [
            "default-src 'none'",
            "img-src 'self' https: data:",
            `style-src 'nonce-${nonce}'`,
            `script-src 'nonce-${nonce}' 'self'`,
            "connect-src 'self'",
          ].join('; '),
        })
        const label = this.deps.hostLabel ?? 'VS Code'
        return void res.end(
          this.deps.app
            ? appShell({ nonce, token: this.token, label, view: url.searchParams.get('view') })
            : page(this.token, label),
        )
      }
      if (route.kind === 'app') return void this.serveBundle(res)
      if (route.kind === 'events') return void this.openEventStream(res)
      if (route.kind === 'message') {
        const client = this.clients.get(url.searchParams.get('c') ?? '')
        if (!client) return void this.json(res, { ok: false, error: 'unknown client' }, 409)
        await this.deps.app?.handleMessage(client, await this.readJson(req))
        return void this.json(res, { ok: true })
      }
      if (route.kind === 'state') {
        return void this.json(res, {
          settings: redactSettings(this.deps.settings()),
          state: await this.deps.state(),
        })
      }

      const body = await this.readJson(req)
      if (route.kind === 'setting') {
        const { key, value } = (body ?? {}) as { key?: string; value?: unknown }
        if (typeof key !== 'string') return void this.json(res, { ok: false, error: 'key required' }, 400)
        // A secret echoed back unchanged must not overwrite the real value.
        if (isRedactedPlaceholder(value)) return void this.json(res, { ok: true, skipped: true })
        return void this.json(res, await this.deps.updateSetting(key, value))
      }
      if (route.kind === 'server') {
        const action = parseServerAction((body as { action?: unknown })?.action)
        if (!action) return void this.json(res, { ok: false, error: 'unknown action' }, 400)
        return void this.json(res, await this.deps.serverAction(action))
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('Not found')
    } catch (err) {
      this.deps.log.error('Web UI request failed', err)
      this.json(res, { ok: false, error: String(err) }, 500)
    }
  }

  /** The panel's bundle, straight off disk. */
  private serveBundle(res: http.ServerResponse): void {
    const path = this.deps.app?.scriptPath
    if (!path || !fs.existsSync(path)) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      return void res.end('UI bundle not built')
    }
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    fs.createReadStream(path).pipe(res)
  }

  /**
   * The host→client half of the protocol.
   *
   * Server-sent events rather than a WebSocket: the traffic is one-way, SSE
   * reconnects on its own, and it is plain HTTP so the same authorisation
   * applies without a second code path.
   */
  private openEventStream(res: http.ServerResponse): void {
    const id = randomBytes(9).toString('base64url')
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })

    const client: BridgeClient = {
      postMessage: (message: unknown) => {
        res.write(`data: ${JSON.stringify(message)}\n\n`)
      },
      close: () => res.end(),
    }
    this.clients.set(id, client)
    const detach = this.deps.app?.attach(client)

    // The client needs its own id to address messages back to this stream.
    res.write(`event: hello\ndata: ${JSON.stringify({ client: id })}\n\n`)
    // Some proxies and sleeping laptops drop an idle stream; a comment keeps it
    // alive and costs nothing.
    const beat = setInterval(() => res.write(': ping\n\n'), 25_000)

    const close = () => {
      clearInterval(beat)
      this.clients.delete(id)
      detach?.()
    }
    res.on('close', close)
    res.on('error', close)
  }

  private json(res: http.ServerResponse, payload: unknown, status = 200): void {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }

  private readJson(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > MAX_BODY_BYTES) {
          req.destroy()
          return reject(new Error('body too large'))
        }
        chunks.push(c)
      })
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        if (!text) return resolve(undefined)
        try {
          resolve(JSON.parse(text))
        } catch {
          reject(new Error('invalid JSON body'))
        }
      })
      req.on('error', reject)
    })
  }

  dispose(): void {
    void this.stop()
  }
}

interface BridgeClient {
  postMessage(message: unknown): void
  /** End the event stream, so shutdown is not blocked waiting for it. */
  close?(): void
}

const VIEWS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'server', label: 'Server & settings' },
  { id: 'models', label: 'Models' },
  { id: 'search', label: 'Search Hugging Face' },
  { id: 'downloads', label: 'Downloads' },
] as const

/**
 * The panel, in a browser.
 *
 * Serves the extension's own React bundle and stands in for the one thing it
 * cannot have here: `acquireVsCodeApi`. The shim speaks the same protocol over
 * HTTP — POST for client→host, server-sent events for host→client — and
 * re-dispatches arrivals as `window.postMessage`, which is exactly what the
 * app already listens for. So every view works unmodified.
 *
 * Views are separate page loads rather than a client-side router: the app
 * mounts one view from `window.__MLX_VIEW__`, and a link per tab keeps this
 * shell honest instead of duplicating routing the panel does not have.
 */
function appShell(args: { nonce: string; token: string; label: string; view: string | null }): string {
  const { nonce, token, label } = args
  const view = VIEWS.some((v) => v.id === args.view) ? args.view : 'dashboard'
  // Buttons, not links: switching views must not reload the page. A reload
  // re-downloads the bundle, drops the event stream and re-runs every view's
  // initial load — which showed up as a fresh Hugging Face search on every
  // click of the Search tab.
  const tabs = VIEWS.map(
    (v) => `<button class="tab${v.id === view ? ' active' : ''}" data-view="${v.id}">${v.label}</button>`,
  ).join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>MLX Console</title>
<style nonce="${nonce}">
${BROWSER_THEME}
${STYLES}
  body { background: var(--page-background); padding: 0; }
  header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
           padding: 12px 16px 0; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  nav { display: flex; gap: 2px; padding: 8px 16px 0; overflow-x: auto;
        border-bottom: 1px solid var(--vscode-panel-border); }
  .tab { padding: 6px 12px; border-radius: 6px 6px 0 0; white-space: nowrap; font: inherit;
         color: var(--vscode-descriptionForeground); border: 1px solid transparent;
         border-bottom: none; background: none; cursor: pointer; }
  .tab:hover { color: var(--vscode-foreground); background: none; }
  .tab.active { color: var(--vscode-foreground); background: var(--page-elevated);
                border-color: var(--vscode-panel-border); }
  main { max-width: 1100px; margin-inline: auto; padding: 12px 8px 48px; }
  #offline { display: none; padding: 6px 16px; background: var(--vscode-editorWarning-foreground);
             color: #000; font-size: 12px; }
  #offline.on { display: block; }
</style>
</head>
<body>
<header>
  <h1>MLX Console</h1>
  <span class="muted small">served by ${label} · 127.0.0.1 · local only</span>
</header>
<nav>${tabs}</nav>
<div id="offline">Disconnected — ${label} may have closed. Reconnecting…</div>
<main><div id="root"></div></main>

<script nonce="${nonce}">
window.__MLX_VIEW__ = ${JSON.stringify(view)};
(function () {
  var TOKEN = ${JSON.stringify(token)};
  var qs = function (extra) { return TOKEN ? '?t=' + encodeURIComponent(TOKEN) + (extra || '') : (extra ? '?' + extra.slice(1) : ''); };
  var clientId = null;
  var queue = [];   // messages posted before the stream said hello

  function send(msg) {
    if (!clientId) return void queue.push(msg);
    fetch('/api/message' + qs('&c=' + encodeURIComponent(clientId)), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mlx-token': TOKEN },
      body: JSON.stringify(msg),
    }).catch(function () { /* the stream's own reconnect will resync */ });
  }

  function connect() {
    var es = new EventSource('/api/events' + qs());
    es.addEventListener('hello', function (e) {
      clientId = JSON.parse(e.data).client;
      document.getElementById('offline').classList.remove('on');
      var pending = queue; queue = [];
      pending.forEach(send);
    });
    es.onmessage = function (e) {
      // The app listens for window messages; this is the same envelope the
      // extension host would have posted.
      window.postMessage(JSON.parse(e.data), '*');
    };
    es.onerror = function () {
      clientId = null;
      document.getElementById('offline').classList.add('on');
      // EventSource retries by itself, but a closed stream needs a new one.
      if (es.readyState === 2) { es.close(); setTimeout(connect, 2000); }
    };
  }
  connect();

  // View switching, in place. Falls back to a page load only if the bundle is
  // older than this shell and does not expose the hook.
  document.querySelectorAll('button[data-view]').forEach(function (b) {
    b.onclick = function () {
      var view = b.dataset.view;
      if (!window.__MLX_SHOW__) { location.search = '?view=' + view; return; }
      window.__MLX_SHOW__(view);
      document.querySelectorAll('button[data-view]').forEach(function (o) {
        o.classList.toggle('active', o === b);
      });
      history.replaceState(null, '', '?view=' + view);
    };
  });

  // The single API the panel code expects from its host.
  window.acquireVsCodeApi = function () {
    var state = {};
    return {
      postMessage: function (msg) {
        if (msg && msg.type === 'openExternal') return void window.open(msg.url, '_blank', 'noopener');
        if (msg && msg.type === 'copy') return void navigator.clipboard.writeText(msg.text);
        if (msg && msg.type === 'openSettings') {
          // No settings editor in a browser — reveal the setting in the panel
          // that is already on screen instead of doing nothing.
          window.dispatchEvent(new CustomEvent('mlx:open-settings', { detail: msg.query || '' }));
          return;
        }
        send(msg);
      },
      getState: function () { return state; },
      setState: function (s) { state = s; return s; },
    };
  };
})();
</script>
<script nonce="${nonce}" src="/app.js${token ? '?t=' + token : ''}"></script>
</body>
</html>`
}

/**
 * The dashboard, inlined.
 *
 * Self-contained on purpose: no external requests, so the page works offline
 * and cannot leak the token to a third party via a stylesheet or font.
 */
function page(token: string, hostLabel: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>MLX Console</title>
<style>
  :root { color-scheme: light dark; --line: #8883; }
  body { font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 24px;
         max-width: 900px; margin-inline: auto; }
  h1 { font-size: 20px; margin: 0 0 4px }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .06em; opacity: .6;
       margin: 28px 0 8px }
  .muted { opacity: .65 }
  .row { display: flex; gap: 8px; align-items: center; justify-content: space-between;
         padding: 8px 0; border-bottom: 1px solid var(--line); }
  .row label { flex: 1 1 auto; min-width: 0 }
  .row .k { font-family: ui-monospace, monospace; font-size: 12px }
  input, select { font: inherit; padding: 4px 6px; min-width: 220px }
  input[type=checkbox] { min-width: auto }
  button { font: inherit; padding: 6px 12px; cursor: pointer }
  .bar { height: 6px; background: var(--line); border-radius: 3px; overflow: hidden; margin: 4px 0 12px }
  .bar > div { height: 100%; background: #3794ff }
  .ok { color: #3fb950 } .warn { color: #d29922 }
  #saved { position: fixed; bottom: 16px; right: 16px; padding: 8px 12px;
           background: #3fb950; color: #000; border-radius: 6px; opacity: 0; transition: opacity .2s }
</style>
<h1>MLX Console</h1>
<div class="muted">Editable dashboard · loopback only · token-authenticated · served by ${hostLabel}</div>

<h2>Server</h2>
<div id="status" class="muted">loading…</div>
<div class="bar"><div id="mem" style="width:0"></div></div>
<div style="display:flex;gap:8px;flex-wrap:wrap">
  <button data-act="start">Start</button>
  <button data-act="stop">Stop</button>
  <button data-act="restart">Restart</button>
  <button data-act="clear">Clear &amp; reload</button>
</div>

<h2>Models</h2>
<div id="models" class="muted">scanning…</div>

<h2>Settings</h2>
<div id="settings"></div>
<div id="saved">saved</div>

<script>
const T = ${JSON.stringify(token)};
const api = (p, body) => fetch(p + '?t=' + encodeURIComponent(T), body ? {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-mlx-token': T },
  body: JSON.stringify(body)
} : undefined).then(r => r.json());

const toast = () => { const e = document.getElementById('saved');
  e.style.opacity = 1; setTimeout(() => e.style.opacity = 0, 900) };

const show = v => v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
const fields = new Map();

function control(s) {
  const i = document.createElement('input');
  if (s.type === 'boolean') {
    i.type = 'checkbox'; i.checked = !!s.value;
    i.onchange = () => save(s.key, i.checked);
  } else {
    i.type = s.secret ? 'password' : 'text';
    i.value = show(s.value);
    i.placeholder = s.default == null ? '' : String(s.default);
    i.onchange = () => save(s.key, i.value);
  }
  fields.set(s.key, i);
  return i;
}

/**
 * Adopt changes made in the VS Code panel, so the two views agree.
 * Never touch the field being typed in, or edits get eaten mid-keystroke.
 */
function sync(settings) {
  for (const s of settings) {
    const i = fields.get(s.key);
    if (!i || i === document.activeElement) continue;
    if (i.type === 'checkbox') i.checked = !!s.value;
    else if (i.value !== show(s.value)) i.value = show(s.value);
  }
}
const save = (key, value) => api('/api/setting', { key, value }).then(r => r.ok && toast());

async function refresh() {
  const { settings, state } = await api('/api/state');
  const st = state || {};
  document.getElementById('status').textContent =
    (st.serverState || '?') + ' · ' + (st.loadedModel || 'no model loaded') +
    (st.occupiedBytes ? ' · ' + gb(st.occupiedBytes) + ' of ' + gb(st.ceilingBytes) : '');
  const pct = st.occupiedBytes && st.ceilingBytes ? Math.min(100, st.occupiedBytes / st.ceilingBytes * 100) : 0;
  document.getElementById('mem').style.width = pct + '%';

  // Scanned by the Python helper against the configured models directory, so
  // this is what the server can actually load — not a guess from the filesystem.
  const models = st.models || [];
  const box = document.getElementById('models');
  box.textContent = '';
  if (!models.length) {
    box.textContent = 'No models found in the configured models directory.';
  } else {
    for (const m of models) {
      const row = document.createElement('div'); row.className = 'row';
      const name = document.createElement('label');
      const resident = m.repo === st.loadedModel;
      name.innerHTML = '<div>' + m.repo + (resident ? ' <b>· resident</b>' : '') +
        '</div><div class="k muted">' + (m.sizeBytes ? gb(m.sizeBytes) : '—') + '</div>';
      row.append(name); box.append(row);
    }
  }

  const host = document.getElementById('settings');
  if (host.dataset.built) return sync(settings);
  host.dataset.built = '1';
  for (const s of settings) {
    const row = document.createElement('div'); row.className = 'row';
    const label = document.createElement('label');
    label.innerHTML = '<div>' + s.label + '</div><div class="k muted">' + s.short + '</div>';
    row.append(label, control(s)); host.append(row);
  }
}
const gb = b => (b / 1073741824).toFixed(1) + ' GB';
document.querySelectorAll('button[data-act]').forEach(b =>
  b.onclick = () => api('/api/server', { action: b.dataset.act }).then(refresh));
refresh(); setInterval(refresh, 3000);
</script>
`
}
