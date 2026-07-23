/**
 * The panel protocol, proxied to the desktop app's daemon.
 *
 * In remote mode the extension builds none of the runtime — no venv manager,
 * no download queue, no web server. The webviews still post their messages to
 * the extension host exactly as before; this hub forwards them to the
 * daemon's `/api/message` and relays its `/api/events` stream back, so every
 * panel runs unmodified against state the app owns.
 *
 * The proxy runs in the extension host rather than the webview because it
 * must: a `vscode-webview://` origin makes every request cross-site, which
 * the daemon deliberately refuses — loosening that check to admit webviews
 * would admit hostile web pages too. Node's http client sends no Origin, so
 * the daemon treats it like any local tool.
 */
import * as http from 'node:http'
import type { DaemonEndpoint } from '../services/daemonClient'
import type { MessageSink } from './webview/webviewHub'

export interface RemoteHubLogger {
  info(msg: string, ...rest: unknown[]): void
  error(msg: string, ...rest: unknown[]): void
}

export interface RemoteHubOptions {
  /** Re-resolved on every (re)connect: the daemon may restart on a new port. */
  endpoint(): Promise<DaemonEndpoint | undefined>
  log: RemoteHubLogger
}

/** How reconnect waits grow: quick first retry, capped so recovery is prompt. */
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 15_000]

/**
 * One webview's bridge: an SSE stream down, POSTs up, and a queue for the
 * messages a page sends before the stream has said hello — the same dance the
 * browser dashboard's shim does in appShell().
 */
class Connection {
  private clientId: string | undefined
  private endpoint: DaemonEndpoint | undefined
  private queue: unknown[] = []
  private req: http.ClientRequest | undefined
  private timer: NodeJS.Timeout | undefined
  private attempts = 0
  private disposed = false

  constructor(
    private readonly sink: MessageSink,
    private readonly opts: RemoteHubOptions,
  ) {}

  start(): void {
    void this.connect()
  }

  send(message: unknown): void {
    if (!this.clientId || !this.endpoint) {
      this.queue.push(message)
      return
    }
    const ep = this.endpoint
    const body = JSON.stringify(message)
    const req = http.request(
      `${ep.origin}/api/message?c=${encodeURIComponent(this.clientId)}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(ep.token ? { 'x-mlx-token': ep.token } : {}),
        },
      },
      (res) => res.resume(),
    )
    // The stream's own reconnect resyncs state; a lost POST is not fatal.
    req.on('error', () => undefined)
    req.end(body)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.req?.destroy()
  }

  private async connect(): Promise<void> {
    if (this.disposed) return
    const ep = await this.opts.endpoint()
    if (this.disposed) return
    if (!ep) return this.retry()

    const req = http.get(
      `${ep.origin}/api/events`,
      { headers: ep.token ? { 'x-mlx-token': ep.token } : {} },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          return this.retry()
        }
        this.endpoint = ep
        let buffer = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          buffer += chunk
          let sep: number
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, sep)
            buffer = buffer.slice(sep + 2)
            this.onFrame(frame)
          }
        })
        const closed = () => this.onDisconnect()
        res.on('end', closed)
        res.on('error', closed)
        res.on('close', closed)
      },
    )
    this.req = req
    req.on('error', () => this.onDisconnect())
  }

  private onFrame(frame: string): void {
    let event = 'message'
    let data = ''
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
      // Comment lines (': ping') keep the stream alive; nothing to do.
    }
    if (!data) return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    if (event === 'hello') {
      this.clientId = (parsed as { client?: string }).client
      this.attempts = 0
      const pending = this.queue
      this.queue = []
      for (const m of pending) this.send(m)
      return
    }
    void this.sink.postMessage(parsed)
  }

  private onDisconnect(): void {
    if (this.disposed || !this.req) return
    this.req = undefined
    this.clientId = undefined
    this.retry()
  }

  private retry(): void {
    if (this.disposed) return
    const wait = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)]
    this.attempts += 1
    if (this.attempts === 1) this.opts.log.info('MLX daemon unreachable — waiting for it to appear')
    this.timer = setTimeout(() => void this.connect(), wait)
  }
}

/** Drop-in for WebviewHub where only the panel bridge is needed. */
export class RemoteHub {
  private readonly connections = new Map<MessageSink, Connection>()

  constructor(private readonly opts: RemoteHubOptions) {}

  connect(sink: MessageSink, _opts: { sampleMetrics?: boolean } = {}): { dispose(): void } {
    const conn = new Connection(sink, this.opts)
    this.connections.set(sink, conn)
    conn.start()
    return {
      dispose: () => {
        this.connections.delete(sink)
        conn.dispose()
      },
    }
  }

  async handleMessage(sink: MessageSink, raw: unknown): Promise<void> {
    this.connections.get(sink)?.send(raw)
  }

  /** The daemon samples for its own attached clients; nothing to start here. */
  sampleMetrics(): { dispose(): void } {
    return { dispose: () => undefined }
  }

  dispose(): void {
    for (const conn of this.connections.values()) conn.dispose()
    this.connections.clear()
  }
}
