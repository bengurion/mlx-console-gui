/**
 * An OpenAI endpoint that answers in plain text.
 *
 * Points at `mlx_lm.server` and forwards everything unchanged except chat
 * completions, which are run through the harmony filter on the way back. Any
 * client — VS Code chat, Continue, Cline, curl — then sees what this
 * extension's own chat view already sees: the answer, without the model's
 * private reasoning and control tokens spliced into it.
 *
 * Deliberately a separate port rather than a rewrite of the real server's
 * output in place: the raw endpoint stays available for anyone who wants the
 * channels, and nothing about mlx_lm.server has to be patched or wrapped.
 */
import * as http from 'node:http'
import { log } from '../core/logging.ts'
import { StreamRewriter, rewriteCompletion } from './harmonyRewrite.ts'

/** Only chat completions carry harmony; everything else is a pass-through. */
const REWRITTEN = /\/chat\/completions$/

export interface HarmonyProxyDeps {
  /** Where the real server lives, e.g. http://127.0.0.1:8080/v1 */
  upstream(): string
}

export class HarmonyProxy {
  private server: http.Server | undefined
  private port: number | undefined
  private readonly deps: HarmonyProxyDeps

  constructor(deps: HarmonyProxyDeps) {
    this.deps = deps
  }

  get url(): string | undefined {
    return this.port ? `http://127.0.0.1:${this.port}/v1` : undefined
  }

  /**
   * Listen, taking another port if this one is busy.
   *
   * A second host — the extension alongside the daemon — wants its own proxy,
   * and the previous behaviour was to log an error and carry on with no proxy
   * at all. Clients then pointed at a port serving nothing, or at the raw
   * server, and saw harmony markup with no clue why.
   */
  async start(port: number, opts: { onBusy?: 'ephemeral' | 'fail' } = {}): Promise<string | undefined> {
    await this.stop()
    const server = http.createServer((req, res) => void this.handle(req, res))

    return new Promise((resolve) => {
      server.on('error', (err) => {
        const busy = (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
        if (busy && opts.onBusy !== 'fail' && port !== 0) {
          log.info(`Filtered endpoint port ${port} is taken; using an OS-assigned port instead`)
          return void this.start(0, { onBusy: 'fail' }).then(resolve)
        }
        log.error(`Harmony proxy could not listen on ${port}`, err)
        resolve(undefined)
      })
      // Loopback only. This forwards to a local server and has no business
      // being reachable from anywhere else.
      server.listen(port, '127.0.0.1', () => {
        this.server = server
        const addr = server.address()
        this.port = typeof addr === 'object' && addr ? addr.port : port
        log.info(`Harmony proxy on http://127.0.0.1:${this.port}/v1 → ${this.deps.upstream()}`)
        resolve(this.url)
      })
    })
  }

  async stop(): Promise<void> {
    const s = this.server
    if (!s) return
    this.server = undefined
    this.port = undefined
    await new Promise<void>((resolve) => {
      s.close(() => resolve())
      s.closeAllConnections?.()
    })
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const upstream = this.deps.upstream().replace(/\/v1\/?$/, '')
    // The client's path already carries /v1; the base is stripped above so the
    // two cannot be doubled up.
    const target = `${upstream}${req.url ?? '/'}`

    try {
      const body = await readBody(req)
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) {
        // Hop-by-hop and length headers are the proxy's business, not the
        // client's — the body may change size.
        if (['host', 'connection', 'content-length', 'accept-encoding'].includes(k)) continue
        if (typeof v === 'string') headers.set(k, v)
      }

      const upstreamRes = await fetch(target, {
        method: req.method,
        headers,
        // Uint8Array, not Buffer: fetch's BodyInit does not accept Buffer.
        body: body.length ? new Uint8Array(body) : undefined,
      })

      const rewrite = REWRITTEN.test(new URL(target).pathname)
      const isStream = (upstreamRes.headers.get('content-type') ?? '').includes('event-stream')

      const outHeaders: Record<string, string> = {}
      upstreamRes.headers.forEach((value, key) => {
        if (key === 'content-length') return // the body may change length
        outHeaders[key] = value
      })
      res.writeHead(upstreamRes.status, outHeaders)

      if (!upstreamRes.body) return void res.end()

      if (!rewrite) return void (await pipe(upstreamRes.body, res))

      if (isStream) return void (await this.pipeStream(upstreamRes.body, res))

      const text = await upstreamRes.text()

      /*
       * Log what the server actually said when it refuses.
       *
       * `mlx_lm.server` catches every exception from generation and answers
       * 404 with the real message in the body — so a client reports "not
       * found" for what is really a template or sampling failure, and the one
       * useful sentence is thrown away by whatever shows the status code. It
       * costs nothing to write it down here.
       */
      if (!upstreamRes.ok) {
        log.warn(`Upstream ${upstreamRes.status} for ${new URL(target).pathname}: ${text.slice(0, 500)}`)
      }

      try {
        res.end(JSON.stringify(rewriteCompletion(JSON.parse(text))))
      } catch {
        // Not JSON after all: pass it through rather than losing it.
        res.end(text)
      }
    } catch (err) {
      log.warn(`Harmony proxy request failed: ${String(err)}`)
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `Upstream request failed: ${String(err)}` } }))
    }
  }

  private async pipeStream(body: ReadableStream<Uint8Array>, res: http.ServerResponse) {
    const rewriter = new StreamRewriter()
    const decoder = new TextDecoder()
    const reader = body.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      res.write(rewriter.push(decoder.decode(value, { stream: true })))
    }
    res.end(rewriter.flush())
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function pipe(body: ReadableStream<Uint8Array>, res: http.ServerResponse) {
  const reader = body.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    res.write(value)
  }
  res.end()
}
