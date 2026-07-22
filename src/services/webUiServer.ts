import * as vscode from 'vscode'
import * as http from 'node:http'
import { randomBytes } from 'node:crypto'
import { log } from '../util/logger'
import {
  authorize,
  isRedactedPlaceholder,
  parseServerAction,
  redactSettings,
  routeOf,
} from './webUi'
import type { SettingSpec } from '../shared/protocol'

/** Refuse absurd bodies rather than buffering whatever arrives. */
const MAX_BODY_BYTES = 64 * 1024

export interface WebUiDeps {
  settings(): SettingSpec[]
  updateSetting(key: string, value: unknown): Promise<{ ok: boolean; error?: string }>
  state(): Promise<unknown>
  serverAction(action: 'start' | 'stop' | 'restart' | 'clear'): Promise<{ ok: boolean }>
}

/**
 * A small editable dashboard on loopback.
 *
 * Off unless enabled. Binds to 127.0.0.1 explicitly — never 0.0.0.0, whatever
 * the server's own LAN setting says, because this endpoint can change settings
 * and stop processes. Every request carries a token generated per session; see
 * `webUi.ts` for why localhost alone is not a boundary.
 */
export class WebUiServer implements vscode.Disposable {
  private server: http.Server | undefined
  private readonly token = randomBytes(24).toString('base64url')
  private port: number | undefined

  constructor(private readonly deps: WebUiDeps) {}

  get url(): string | undefined {
    return this.port ? `http://127.0.0.1:${this.port}/?t=${this.token}` : undefined
  }

  async start(port: number): Promise<string | undefined> {
    await this.stop()
    const server = http.createServer((req, res) => void this.handle(req, res))

    return new Promise((resolve) => {
      server.on('error', (err) => {
        log.error(`Web UI could not listen on ${port}`, err)
        // Each window has its own token, so a second window cannot share the
        // first one's dashboard — say so rather than reporting a raw errno.
        const busy = (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
        void vscode.window.showErrorMessage(
          busy
            ? `MLX: port ${port} is already in use — another VS Code window may already be serving the dashboard. Open it from that window, or change Web Ui: Port.`
            : `MLX: web UI failed to start — ${String(err)}`,
        )
        resolve(undefined)
      })
      // Explicit loopback bind; do not honour exposeToLan here.
      server.listen(port, '127.0.0.1', () => {
        this.server = server
        const addr = server.address()
        this.port = typeof addr === 'object' && addr ? addr.port : port
        log.info(`Web UI listening on http://127.0.0.1:${this.port} (token required)`)
        resolve(this.url)
      })
    })
  }

  async stop(): Promise<void> {
    const s = this.server
    if (!s) return
    this.server = undefined
    this.port = undefined
    await new Promise<void>((resolve) => s.close(() => resolve()))
    log.info('Web UI stopped')
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const auth = authorize({
      host: req.headers.host,
      token: this.token,
      givenToken: url.searchParams.get('t') ?? (req.headers['x-mlx-token'] as string | undefined),
      method: req.method,
      contentType: req.headers['content-type'],
    })
    if (!auth.ok) {
      res.writeHead(auth.status, { 'content-type': 'text/plain' })
      return void res.end(auth.reason)
    }

    const route = routeOf(url.pathname)
    try {
      if (route.kind === 'page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return void res.end(page(this.token))
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
      log.error('Web UI request failed', err)
      this.json(res, { ok: false, error: String(err) }, 500)
    }
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

/**
 * The dashboard, inlined.
 *
 * Self-contained on purpose: no external requests, so the page works offline
 * and cannot leak the token to a third party via a stylesheet or font.
 */
function page(token: string): string {
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
<div class="muted">Editable dashboard · loopback only · token-authenticated</div>

<h2>Server</h2>
<div id="status" class="muted">loading…</div>
<div class="bar"><div id="mem" style="width:0"></div></div>
<div style="display:flex;gap:8px;flex-wrap:wrap">
  <button data-act="start">Start</button>
  <button data-act="stop">Stop</button>
  <button data-act="restart">Restart</button>
  <button data-act="clear">Clear &amp; reload</button>
</div>

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

function control(s) {
  if (s.type === 'boolean') {
    const i = document.createElement('input'); i.type = 'checkbox'; i.checked = !!s.value;
    i.onchange = () => save(s.key, i.checked); return i;
  }
  const i = document.createElement('input');
  i.type = s.secret ? 'password' : 'text';
  i.value = s.value == null ? '' : (typeof s.value === 'object' ? JSON.stringify(s.value) : s.value);
  i.placeholder = s.default == null ? '' : String(s.default);
  i.onchange = () => save(s.key, i.value);
  return i;
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

  const host = document.getElementById('settings');
  if (host.dataset.built) return;           // do not clobber a field mid-edit
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
