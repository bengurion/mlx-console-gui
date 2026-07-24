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
import { BROWSER_THEME, BROWSER_UI, STYLES, THEME_INIT_JS } from '../ui/webview/styles.ts'

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
          // transport needs to reach its own origin. Styles cannot be nonced:
          // mermaid injects <style> and style="" into its SVGs, and a nonce's
          // presence makes browsers ignore 'unsafe-inline'. Scripts stay the
          // real line of defence.
          'content-security-policy': [
            "default-src 'none'",
            "img-src 'self' https: data:",
            "style-src 'self' 'unsafe-inline'",
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
  { id: 'models', label: 'Models' },
  { id: 'search', label: 'Search Hugging Face' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'settings', label: 'Settings' },
  { id: 'clients', label: 'Clients' },
  { id: 'info', label: 'Info' },
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
/** Lucide-style icons for the rail, inlined so the page stays self-contained. */
const NAV_ICONS: Record<string, string> = {
  dashboard:
    '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  models:
    '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  downloads:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  clients:
    '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
}

function navIcon(id: string): string {
  return (
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${NAV_ICONS[id] ?? ''}</svg>`
  )
}

function appShell(args: { nonce: string; token: string; label: string; view: string | null }): string {
  const { nonce, token, label } = args
  const view = VIEWS.some((v) => v.id === args.view) ? args.view : 'dashboard'
  // Buttons, not links: switching views must not reload the page. A reload
  // re-downloads the bundle, drops the event stream and re-runs every view's
  // initial load — which showed up as a fresh Hugging Face search on every
  // click of the Search tab.
  const items = VIEWS.map(
    (v) =>
      `<button class="nav-item${v.id === view ? ' active' : ''}" data-view="${v.id}" title="${v.label}">` +
      `<span class="nav-icon">${navIcon(v.id)}</span><span class="nav-label">${v.label}</span></button>`,
  ).join('')
  const titles = JSON.stringify(Object.fromEntries(VIEWS.map((v) => [v.id, v.label])))
  const activeLabel = VIEWS.find((v) => v.id === view)?.label ?? 'Dashboard'

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>MLX Console</title>
<script nonce="${nonce}">${THEME_INIT_JS}</script>
<style nonce="${nonce}">
${BROWSER_THEME}
${STYLES}
${BROWSER_UI}
  html, body { height: 100%; }
  body { padding: 0; }
  .shell { display: flex; height: 100vh; overflow: hidden; }

  /* -- the rail ------------------------------------------------------ */
  #rail { width: 240px; flex-shrink: 0; display: flex; flex-direction: column;
          background: var(--sidebar); color: var(--sidebar-fg); padding: 12px;
          border-right: 1px solid rgba(255,255,255,0.1);
          box-shadow: 0 25px 50px -12px rgba(2,6,23,0.25);
          overflow-y: auto; transition: width 0.2s; }
  .shell.collapsed #rail { width: 64px; }
  .brand { display: flex; align-items: center; gap: 8px; padding: 4px; margin-bottom: 24px; color: #fff; }
  .brand-mark { display: grid; place-items: center; width: 28px; height: 28px; flex-shrink: 0;
                border-radius: 8px; background: rgba(255,255,255,0.15); font-size: 10px; font-weight: 700;
                box-shadow: inset 0 1px 2px rgba(255,255,255,0.1), 0 0 0 1px rgba(255,255,255,0.15); }
  .brand-name { flex: 1; font-weight: 700; white-space: nowrap; }
  .shell.collapsed .brand { justify-content: center; }
  .shell.collapsed .brand-name, .shell.collapsed .brand-mark { display: none; }
  .rail-btn { width: 28px; height: 28px; padding: 0; flex-shrink: 0; display: grid; place-items: center;
              background: none; border: none; box-shadow: none; border-radius: 8px;
              color: var(--sidebar-fg); font-weight: 400; font-size: 14px; }
  .rail-btn:hover { background: rgba(255,255,255,0.1); color: #fff; filter: none; }
  #rail nav { flex: 1; display: flex; flex-direction: column; gap: 4px; padding: 0; border: none; }
  button.nav-item { display: flex; align-items: center; justify-content: flex-start; gap: 12px; width: 100%;
                    border-radius: 8px; padding: 8px 12px; font-size: 13px; font-weight: 400;
                    background: none; border: none; box-shadow: none; color: var(--sidebar-fg);
                    transition: background 0.15s, color 0.15s; }
  button.nav-item:hover { background: rgba(255,255,255,0.1); color: #fff; filter: none; }
  button.nav-item.active { background: rgba(255,255,255,0.15); color: #fff; font-weight: 600;
                           box-shadow: inset 0 2px 4px rgba(2,6,23,0.35), 0 0 0 1px rgba(255,255,255,0.1); }
  button.nav-item:focus-visible, .rail-btn:focus-visible {
    outline: 2px solid rgba(255,255,255,0.85); outline-offset: 2px; box-shadow: none; }
  .nav-icon { display: grid; place-items: center; width: 18px; height: 18px; flex-shrink: 0; }
  .nav-icon svg { width: 18px; height: 18px; }
  .nav-label { white-space: nowrap; }
  .shell.collapsed .nav-label { display: none; }
  .shell.collapsed button.nav-item { justify-content: center; padding: 8px; }
  .rail-foot { border-top: 1px solid rgba(255,255,255,0.1); padding-top: 12px; margin-top: 12px;
               font-size: 11px; color: rgba(255,255,255,0.55);
               white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .shell.collapsed .rail-foot { display: none; }

  /* -- the working column -------------------------------------------- */
  .content { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .content > header { display: flex; align-items: center; justify-content: space-between; gap: 12px;
           flex-shrink: 0; padding: 10px 24px; border-bottom: 1px solid var(--border);
           background: color-mix(in srgb, var(--surface) 80%, transparent);
           backdrop-filter: blur(8px); box-shadow: 0 1px 2px rgba(15,23,42,0.04); }
  .content > header h1 { margin: 0; font-size: 19px; font-weight: 600; color: var(--fg);
              white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .header-actions { display: flex; align-items: center; gap: 12px; }
  .header-note { font-size: 12px; color: var(--muted); white-space: nowrap; }
  .icon-btn { width: 34px; height: 34px; padding: 0; border-radius: 10px; }
  .icon-btn svg { width: 16px; height: 16px; }
  #theme .moon { display: none; }
  .dark #theme .sun { display: none; }
  .dark #theme .moon { display: block; }
  /* Fill the width like the app-base shell does — no artificial column cap;
     the cards' own grid decides how many tracks a big screen gets. The
     padding lives on #root, not main: main is the scroll container, and
     padding there would hold sticky children (the Info tabs) 20px below the
     scrollport with content showing through the gap. */
  main { flex: 1; min-height: 0; overflow-y: auto; }
  main > #root { padding: 20px 24px 48px; }
  #offline { display: none; padding: 6px 24px; background: var(--warning); color: #111; font-size: 12px; }
  #offline.on { display: block; }
</style>
</head>
<body>
<div class="shell" id="shell">
  <aside id="rail">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">MLX</span>
      <span class="brand-name">MLX Console</span>
      <button id="collapse" class="rail-btn" title="Collapse menu" aria-label="Collapse menu">«</button>
    </div>
    <nav aria-label="Main navigation">${items}</nav>
    <div class="rail-foot">served by ${label} · local only</div>
  </aside>
  <div class="content">
    <header>
      <h1 id="title">${activeLabel}</h1>
      <div class="header-actions">
        <span class="header-note">127.0.0.1</span>
        <button id="theme" class="secondary icon-btn" title="Toggle theme" aria-label="Toggle theme">
          <svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
          <svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
        </button>
      </div>
    </header>
    <div id="offline">Disconnected — ${label} may have closed. Reconnecting…</div>
    <main><div id="root"></div></main>
  </div>
</div>

<script nonce="${nonce}">
window.__MLX_VIEW__ = ${JSON.stringify(view)};
var __MLX_TITLES__ = ${titles};
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
      var title = document.getElementById('title');
      if (title && __MLX_TITLES__[view]) title.textContent = __MLX_TITLES__[view];
      history.replaceState(null, '', '?view=' + view);
    };
  });

  // Theme toggle: flip the .dark class and remember the choice.
  var themeBtn = document.getElementById('theme');
  if (themeBtn) themeBtn.onclick = function () {
    var dark = document.documentElement.classList.toggle('dark');
    try { localStorage.setItem('mlx-theme', dark ? 'dark' : 'light'); } catch (e) {}
  };

  // Rail collapse, persisted like the design does.
  var shell = document.getElementById('shell');
  var collapseBtn = document.getElementById('collapse');
  function syncCollapse() {
    var c = shell.classList.contains('collapsed');
    if (collapseBtn) {
      collapseBtn.textContent = c ? '\\u00bb' : '\\u00ab';
      collapseBtn.title = c ? 'Expand menu' : 'Collapse menu';
    }
  }
  try { if (localStorage.getItem('mlx-nav:collapsed') === '1') shell.classList.add('collapsed'); } catch (e) {}
  syncCollapse();
  if (collapseBtn) collapseBtn.onclick = function () {
    var c = shell.classList.toggle('collapsed');
    try { localStorage.setItem('mlx-nav:collapsed', c ? '1' : '0'); } catch (e) {}
    syncCollapse();
  };

  // The single API the panel code expects from its host.
  window.acquireVsCodeApi = function () {
    var state = {};
    return {
      postMessage: function (msg) {
        if (msg && msg.type === 'openExternal') return void window.open(msg.url, '_blank', 'noopener');
        if (msg && msg.type === 'copy') return void navigator.clipboard.writeText(msg.text);
        if (msg && msg.type === 'openSettings') {
          // Bring the settings tab forward; the host answers with a
          // revealSetting push that tells the panel which one to show. Doing
          // the second half here too would mean two mechanisms to keep in step.
          if (window.__MLX_SHOW__) {
            window.__MLX_SHOW__('settings');
            document.querySelectorAll('button[data-view]').forEach(function (o) {
              o.classList.toggle('active', o.dataset.view === 'settings');
            });
            var title = document.getElementById('title');
            if (title && __MLX_TITLES__.settings) title.textContent = __MLX_TITLES__.settings;
            history.replaceState(null, '', '?view=settings');
          }
          send(msg);
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
