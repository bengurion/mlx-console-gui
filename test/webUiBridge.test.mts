/**
 * The browser transport, end to end over a real socket.
 *
 * These boot an actual WebUiServer rather than testing the pieces in
 * isolation, because the thing worth proving is that a browser can hold the
 * same conversation with the hub that a webview does: attach, send a message,
 * receive both the reply and unsolicited pushes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { WebUiServer, type MessageSink } from '../src/services/webUiServer.ts'
import { routeOf } from '../src/services/webUi.ts'

const quiet = { info: () => {}, error: () => {} }

/** A stand-in for WebviewHub: records what it is asked, replies as the hub would. */
function fakeApp(scriptPath: string) {
  const seen: unknown[] = []
  const sinks = new Set<MessageSink>()
  return {
    seen,
    push: (msg: unknown) => sinks.forEach((s) => s.postMessage(msg)),
    attached: () => sinks.size,
    app: {
      scriptPath,
      attach(sink: MessageSink) {
        sinks.add(sink)
        return () => sinks.delete(sink)
      },
      async handleMessage(sink: MessageSink, message: unknown) {
        seen.push(message)
        const m = message as { type: string; id?: number }
        if (m.type === 'rpc') sink.postMessage({ type: 'rpcResult', id: m.id, ok: true, result: ['a-model'] })
        if (m.type === 'ready') sink.postMessage({ type: 'push', name: 'models', data: [] })
      },
    },
  }
}

async function withServer(
  fn: (base: string, app: ReturnType<typeof fakeApp>) => Promise<void>,
  opts: { withApp?: boolean } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlx-ui-'))
  const bundle = path.join(dir, 'main.js')
  fs.writeFileSync(bundle, 'globalThis.__PANEL_LOADED__ = true\n')
  const app = fakeApp(bundle)

  const ui = new WebUiServer({
    settings: () => [],
    updateSetting: async () => ({ ok: true }),
    state: async () => ({}),
    serverAction: async () => ({ ok: true }),
    log: quiet,
    app: opts.withApp === false ? undefined : app.app,
  })
  const url = await ui.start(0)
  assert.ok(url, 'server should be listening')
  try {
    await fn(url.replace(/\/$/, ''), app)
  } finally {
    await ui.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * A minimal EventSource: one reader held open for the life of the stream, so
 * successive reads see later events rather than re-locking the body.
 */
function sse(res: Response) {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const queued: Array<Record<string, unknown>> = []
  let buf = ''

  return {
    /** Wait for the next `want` data events. */
    async next(want = 1): Promise<Array<Record<string, unknown>>> {
      while (queued.length < want) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let cut: number
        while ((cut = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, cut)
          buf = buf.slice(cut + 2)
          const data = /^data: (.*)$/m.exec(frame)
          if (data) queued.push(JSON.parse(data[1]))
        }
      }
      return queued.splice(0, want)
    },
    close: () => reader.cancel().catch(() => {}),
  }
}

test('the bridge routes are known', () => {
  assert.equal(routeOf('/app.js').kind, 'app')
  assert.equal(routeOf('/api/events').kind, 'events')
  assert.equal(routeOf('/api/message').kind, 'message')
  assert.equal(routeOf('/api/messages').kind, 'unknown')
})

test('the page serves the panel bundle and mounts the requested view', async () => {
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/?view=search`)).text()
    assert.match(html, /__MLX_VIEW__ = "search"/, 'the app is told which view to mount')
    assert.match(html, /acquireVsCodeApi/, 'the host API is shimmed')
    assert.match(html, /src="\/app\.js/, 'the real bundle is loaded, not a copy')
    assert.match(html, /class="tab active" data-view="search"/, 'the active tab reflects the view')
    assert.equal(
      /<a class="tab/.test(html),
      false,
      'tabs must be buttons: a link reloads the page and refetches everything',
    )

    const js = await fetch(`${base}/app.js`)
    assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8')
    assert.match(await js.text(), /__PANEL_LOADED__/)
  })
})

test('an unknown view falls back rather than mounting nothing', async () => {
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/?view=../etc/passwd`)).text()
    assert.match(html, /__MLX_VIEW__ = "dashboard"/, 'falls back to the default view')
  })
})

test('the page CSP allows its own origin but nothing external', async () => {
  await withServer(async (base) => {
    const csp = (await fetch(base + '/')).headers.get('content-security-policy') ?? ''
    assert.match(csp, /default-src 'none'/)
    assert.match(csp, /connect-src 'self'/, 'the transport needs to reach its own origin')
    assert.equal(/script-src[^;]*https:/.test(csp), false, 'no external scripts')
  })
})

test('a client attaches, is given an id, and receives pushes', async () => {
  await withServer(async (base, app) => {
    const res = await fetch(`${base}/api/events`)
    assert.equal(res.headers.get('content-type'), 'text/event-stream')
    const stream = sse(res)

    const [hello] = await stream.next()
    assert.ok(typeof hello.client === 'string' && hello.client.length > 0, 'client id issued')
    assert.equal(app.attached(), 1, 'the hub sees one attached client')

    app.push({ type: 'push', name: 'models', data: [{ id: 'x' }] })
    const [pushed] = await stream.next()
    assert.equal((pushed as { name: string }).name, 'models')
    await stream.close()
  })
})

test('a message reaches the hub and its reply comes back over the stream', async () => {
  await withServer(async (base, app) => {
    const stream = sse(await fetch(`${base}/api/events`))
    const [hello] = await stream.next()

    const posted = await fetch(`${base}/api/message?c=${hello.client}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'rpc', id: 7, method: 'listModels' }),
    })
    assert.equal(posted.status, 200)
    assert.deepEqual(app.seen, [{ type: 'rpc', id: 7, method: 'listModels' }])

    const [reply] = await stream.next()
    assert.deepEqual(reply, { type: 'rpcResult', id: 7, ok: true, result: ['a-model'] })
    await stream.close()
  })
})

test('a message for an unknown client is refused, not silently dropped', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/message?c=nope`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"type":"ready","view":"server"}',
    })
    assert.equal(res.status, 409, 'the client should reconnect rather than assume it worked')
  })
})

test('a disconnecting client is detached, so metrics sampling stops', async () => {
  await withServer(async (base, app) => {
    const stream = sse(await fetch(`${base}/api/events`))
    await stream.next()
    assert.equal(app.attached(), 1)

    await stream.close()
    // The close event is asynchronous; give the socket a tick to tear down.
    for (let i = 0; i < 50 && app.attached() > 0; i++) await new Promise((r) => setTimeout(r, 20))
    assert.equal(app.attached(), 0, 'a closed browser tab must not hold a metrics subscription')
  })
})

test('without a panel bundle the dashboard still serves its compact page', async () => {
  await withServer(
    async (base) => {
      const html = await (await fetch(base + '/')).text()
      assert.match(html, /Editable dashboard/, 'the headless fallback')
      assert.equal(/__MLX_VIEW__/.test(html), false)
      assert.equal((await fetch(`${base}/app.js`)).status, 404)
    },
    { withApp: false },
  )
})

// ---- build skew ------------------------------------------------------------

test('a page from another build is told to reload', async () => {
  const { staleNotice } = await import('../src/ui/webview/buildStamp.ts')

  // The case that prompted this: a rebuilt page served from disk to a host
  // still running the previous build. It does not error — the old host drops
  // the fields it does not know, so a size filter quietly matches everything.
  assert.deepEqual(staleNotice('2026-07-23T14:42:00Z', '2026-07-23T09:58:00Z'), {
    host: '2026-07-23T09:58:00Z',
    client: '2026-07-23T14:42:00Z',
  })

  assert.equal(staleNotice('same', 'same'), undefined, 'matching builds say nothing')
  // A page old enough to send no build at all cannot be compared, and a
  // warning nobody can act on is worse than none.
  assert.equal(staleNotice(undefined, 'x'), undefined)
})
