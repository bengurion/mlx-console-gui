/**
 * An OpenAI endpoint that answers in plain text — and an Anthropic one.
 *
 * Points at `mlx_lm.server` and forwards everything unchanged except chat
 * completions, which are run through the harmony filter on the way back. Any
 * client — VS Code chat, Continue, Cline, curl — then sees what this
 * extension's own chat view already sees: the answer, without the model's
 * private reasoning and control tokens spliced into it.
 *
 * It also answers `POST /v1/messages` in the Anthropic Messages API, so
 * Anthropic-protocol clients — Claude Code with `ANTHROPIC_BASE_URL` pointed
 * here, or any Anthropic SDK — can use the local model. `mlx_lm.server`
 * itself has no such route; requests are translated to chat completions on
 * the way in and back on the way out (see anthropicCompat.ts).
 *
 * Deliberately a separate port rather than a rewrite of the real server's
 * output in place: the raw endpoint stays available for anyone who wants the
 * channels, and nothing about mlx_lm.server has to be patched or wrapped.
 */
import * as http from 'node:http'
import { log } from '../core/logging.ts'
import { StreamRewriter, rewriteCompletion } from './harmonyRewrite.ts'
import { AnthropicStreamTranslator, chatToMessages, estimateTokens, messagesToChat } from './anthropicCompat.ts'

/** Only chat completions carry harmony; everything else is a pass-through. */
const REWRITTEN = /\/chat\/completions$/

export interface HarmonyProxyDeps {
  /** Where the real server lives, e.g. http://127.0.0.1:8080/v1 */
  upstream(): string
  /**
   * Load tracking. `mlx_lm.server` loads models lazily inside the request
   * that names them, so a client talking through this proxy can displace the
   * resident model without the console ever finding out — the registry then
   * shows a model the server no longer has, and tens of gigabytes sit wired
   * with no UI owning them. These callbacks let the host keep its registry
   * honest for every proxied request. (Traffic on the raw port stays
   * invisible; the server offers no residency endpoint to ask.)
   */
  onModelUse?(model: string): void
  /** The request succeeded — the weights are demonstrably resident. */
  onModelServed?(model: string): void
  /** The request failed — a 'loading' state must not stick. */
  onModelFailed?(): void
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

    // Anthropic-protocol routes are ours, not the upstream's: mlx_lm.server
    // would answer 404, which Anthropic clients report as a broken *model*.
    // Match on the pathname — Claude Code appends query strings like ?beta=true.
    const path = new URL(target).pathname
    if (req.method === 'POST' && path.endsWith('/v1/messages/count_tokens')) {
      return this.countTokens(req, res)
    }
    if (req.method === 'POST' && path.endsWith('/v1/messages')) {
      return this.messages(req, res, upstream)
    }

    let model: string | undefined
    try {
      const body = await readBody(req)
      model = req.method === 'POST' ? modelIn(body) : undefined
      if (model) this.deps.onModelUse?.(model)
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

      // Headers only arrive after the lazy load inside the request completes,
      // so a 2xx here is proof the named weights are resident.
      if (model) {
        if (upstreamRes.ok) this.deps.onModelServed?.(model)
        else this.deps.onModelFailed?.()
      }

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
      /*
       * Node's fetch reports every transport failure as `TypeError: fetch
       * failed` and hides the real one in `cause` — so a server that simply
       * is not running reads as a bug in the proxy. Unwrap it and say what
       * happened, since the usual answer is "start the model server".
       */
      if (model) this.deps.onModelFailed?.()
      const message = describeUpstreamFailure(err, upstream)
      log.warn(`Harmony proxy: ${message}`)
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message, type: 'upstream_unavailable' } }))
    }
  }

  /**
   * `POST /v1/messages` — the Anthropic Messages API, backed by the
   * upstream's chat completions.
   *
   * The harmony filter sits between the two translations: gpt-oss models
   * answer in channel markup, and handing that to an Anthropic client would
   * reproduce, on a new protocol, exactly the mess this proxy exists to fix.
   */
  private async messages(req: http.IncomingMessage, res: http.ServerResponse, upstream: string): Promise<void> {
    try {
      let request: Record<string, unknown>
      try {
        request = JSON.parse((await readBody(req)).toString('utf8')) as Record<string, unknown>
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        return void res.end(
          JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Request body is not JSON.' } }),
        )
      }

      const model = typeof request.model === 'string' ? request.model : undefined
      if (model) this.deps.onModelUse?.(model)

      const upstreamRes = await fetch(`${upstream}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(messagesToChat(request)),
      })

      if (model) {
        if (upstreamRes.ok) this.deps.onModelServed?.(model)
        else this.deps.onModelFailed?.()
      }

      if (!upstreamRes.ok) {
        // The real reason lives in the body (mlx_lm.server answers 404 for
        // template and generation failures too) — forward it, in the error
        // shape Anthropic clients know how to display.
        const text = await upstreamRes.text()
        log.warn(`Upstream ${upstreamRes.status} for /v1/messages: ${text.slice(0, 500)}`)
        res.writeHead(upstreamRes.status, { 'content-type': 'application/json' })
        return void res.end(
          JSON.stringify({
            type: 'error',
            error: {
              type: upstreamRes.status === 404 ? 'not_found_error' : 'api_error',
              message: text.slice(0, 500) || `Upstream answered ${upstreamRes.status}.`,
            },
          }),
        )
      }

      const isStream = (upstreamRes.headers.get('content-type') ?? '').includes('event-stream')
      if (!isStream || !upstreamRes.body) {
        const completion = rewriteCompletion(await upstreamRes.json())
        res.writeHead(200, { 'content-type': 'application/json' })
        return void res.end(JSON.stringify(chatToMessages(completion)))
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const rewriter = new StreamRewriter()
      const translator = new AnthropicStreamTranslator()
      const decoder = new TextDecoder()
      const reader = upstreamRes.body.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        res.write(translator.push(rewriter.push(decoder.decode(value, { stream: true }))))
      }
      res.write(translator.push(rewriter.flush()))
      res.end(translator.flush())
    } catch (err) {
      this.deps.onModelFailed?.()
      const message = describeUpstreamFailure(err, upstream)
      log.warn(`Harmony proxy (/v1/messages): ${message}`)
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }))
    }
  }

  /**
   * `POST /v1/messages/count_tokens` — answered here, estimated: the
   * upstream has no tokenize route to defer to.
   */
  private async countTokens(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8')) as Record<string, unknown>
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ input_tokens: estimateTokens(body) }))
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Request body is not JSON.' } }),
      )
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

/** The `model` a POST body names, if it is JSON and names one. */
function modelIn(body: Buffer): string | undefined {
  if (!body.length) return undefined
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { model?: unknown }
    return typeof parsed?.model === 'string' ? parsed.model : undefined
  } catch {
    return undefined
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

/**
 * A useful sentence from a fetch failure.
 *
 * `TypeError: fetch failed` is what Node reports for every transport error;
 * the errno that says which one lives on `cause`. ECONNREFUSED in particular
 * has a specific, common and fixable meaning here — the model server is not
 * running — and saying "fetch failed" instead sends people looking at the
 * proxy, which is working perfectly.
 */
export function describeUpstreamFailure(err: unknown, upstream: string): string {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause
  const code = cause?.code

  if (code === 'ECONNREFUSED') {
    return `Nothing is listening at ${upstream} — the model server is not running. Start it from the Dashboard, or with \`mlx-console start\`.`
  }
  if (code === 'ECONNRESET') {
    return `${upstream} closed the connection mid-request. A model load can take minutes; the server does not answer while it reads weights.`
  }
  if (code === 'ETIMEDOUT') {
    return `${upstream} did not answer in time.`
  }
  const detail = code ?? cause?.message ?? (err instanceof Error ? err.message : String(err))
  return `Could not reach ${upstream}: ${detail}`
}
