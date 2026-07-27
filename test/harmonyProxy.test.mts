/**
 * The proxy's load tracking.
 *
 * `mlx_lm.server` loads models lazily inside the request that names them, so
 * the proxy is the only place the console can see an API client (Claude Code,
 * most likely) displacing the resident model. These verify the callbacks fire
 * for both protocols, and that failure does not confirm a load.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import { HarmonyProxy } from '../src/services/harmonyProxy.ts'

const COMPLETION = {
  id: 'chatcmpl-1',
  model: 'org/model',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
}

/** A fake mlx_lm.server: answers chat completions, 404s a magic model name. */
function fakeUpstream(): Promise<{ url: string; close(): void }> {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString()))
    req.on('end', () => {
      const model = (JSON.parse(body || '{}') as { model?: string }).model
      if (model === 'org/missing') {
        res.writeHead(404, { 'content-type': 'text/plain' })
        return void res.end('Not Found')
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ...COMPLETION, model }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ url: `http://127.0.0.1:${addr.port}/v1`, close: () => server.close() })
    })
  })
}

const cleanups: (() => void)[] = []
after(() => cleanups.forEach((fn) => fn()))

async function proxyWithTracking() {
  const upstream = await fakeUpstream()
  const events: string[] = []
  const proxy = new HarmonyProxy({
    upstream: () => upstream.url,
    onModelUse: (m) => events.push(`use:${m}`),
    onModelServed: (m) => events.push(`served:${m}`),
    onModelFailed: () => events.push('failed'),
  })
  const url = await proxy.start(0, { onBusy: 'fail' })
  assert.ok(url, 'proxy must listen')
  cleanups.push(() => {
    void proxy.stop()
    upstream.close()
  })
  return { url: url.replace(/\/v1$/, ''), events }
}

test('a chat-completions request reports use and residency', async () => {
  const { url, events } = await proxyWithTracking()
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'org/model', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(res.status, 200)
  await res.text()
  assert.deepEqual(events, ['use:org/model', 'served:org/model'])
})

test('an Anthropic /v1/messages request reports the same way', async () => {
  const { url, events } = await proxyWithTracking()
  const res = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'org/model', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(res.status, 200)
  await res.text()
  assert.deepEqual(events, ['use:org/model', 'served:org/model'])
})

test('a refused model reports failure, never residency', async () => {
  const { url, events } = await proxyWithTracking()
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'org/missing', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(res.status, 404)
  await res.text()
  assert.deepEqual(events, ['use:org/missing', 'failed'])
})

test('requests without a model (GET /v1/models) report nothing', async () => {
  const { url, events } = await proxyWithTracking()
  await (await fetch(`${url}/v1/models`)).text()
  assert.deepEqual(events, [])
})
