import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  authorize,
  tokensMatch,
  routeOf,
  parseServerAction,
  redactSettings,
  isRedactedPlaceholder,
} from '../src/services/webUi.ts'

const TOKEN = 'a'.repeat(32)
// Default posture: token required. Tokenless mode is covered separately below.
const ok = (over = {}) =>
  authorize({ host: '127.0.0.1:8090', token: TOKEN, givenToken: TOKEN, requireToken: true, ...over })

test('a valid loopback request with the token is allowed', () => {
  assert.deepEqual(ok(), { ok: true, status: 200 })
  assert.equal(ok({ host: 'localhost:8090' }).ok, true)
  assert.equal(ok({ host: '[::1]:8090' }).ok, true)
})

test('requests claiming a non-local Host are refused', () => {
  // DNS rebinding: a remote origin resolving to 127.0.0.1 still sends its own Host.
  const r = ok({ host: 'evil.example.com' })
  assert.equal(r.ok, false)
  assert.equal(r.status, 403)
})

test('Host is checked before the token, so probes learn nothing', () => {
  const r = authorize({ host: 'evil.example.com', token: TOKEN, givenToken: 'wrong' })
  assert.equal(r.status, 403, 'not 401 — the token is never evaluated')
})

test('a missing or wrong token is rejected', () => {
  assert.equal(ok({ givenToken: undefined }).status, 401)
  assert.equal(ok({ givenToken: 'b'.repeat(32) }).status, 401)
  assert.equal(ok({ givenToken: TOKEN.slice(0, 31) }).status, 401)
})

test('writes must be JSON, which a cross-origin form cannot send', () => {
  assert.equal(ok({ method: 'POST', contentType: 'application/json' }).ok, true)
  // The three content types a plain HTML form can produce:
  for (const ct of [
    'application/x-www-form-urlencoded',
    'multipart/form-data',
    'text/plain',
  ]) {
    assert.equal(ok({ method: 'POST', contentType: ct }).status, 415, ct)
  }
  assert.equal(ok({ method: 'POST', contentType: undefined }).status, 415)
})

// ---- cross-site defences, which apply with or without a token -------------

test('a browser saying the request came from another site is refused', () => {
  for (const site of ['cross-site', 'same-site-typo', 'CROSS-SITE']) {
    const r = ok({ secFetchSite: site, requireToken: false })
    assert.equal(r.status, 403, site)
  }
})

test('the page itself, and typing the URL, are allowed', () => {
  for (const site of ['same-origin', 'none', 'same-site']) {
    assert.equal(ok({ secFetchSite: site, requireToken: false }).ok, true, site)
  }
  // curl and other non-browser clients send neither header.
  assert.equal(ok({ requireToken: false }).ok, true)
})

test('a non-loopback Origin is refused even when the Host is right', () => {
  assert.equal(ok({ origin: 'https://evil.example.com', requireToken: false }).status, 403)
  assert.equal(ok({ origin: 'null', requireToken: false }).status, 403, 'opaque origin')
  assert.equal(ok({ origin: 'not a url', requireToken: false }).status, 403)
  assert.equal(ok({ origin: 'http://127.0.0.1:8090', requireToken: false }).ok, true)
  assert.equal(ok({ origin: 'http://localhost:8090', requireToken: false }).ok, true)
})

test('without a token, writes still have to be JSON', () => {
  const r = ok({ requireToken: false, method: 'POST', contentType: 'text/plain' })
  assert.equal(r.status, 415, 'the last line of defence against a cross-origin form')
})

test('cross-site is judged before the token, so a probe learns nothing', () => {
  const r = authorize({
    host: '127.0.0.1:8090',
    token: TOKEN,
    givenToken: 'wrong',
    secFetchSite: 'cross-site',
    requireToken: true,
  })
  assert.equal(r.status, 403, 'not 401')
})

test('a missing token is accepted only when it is not required', () => {
  assert.equal(ok({ givenToken: undefined, requireToken: false }).ok, true)
  assert.equal(ok({ givenToken: undefined, requireToken: true }).status, 401)
  // Unspecified means required: a caller that forgets the flag fails closed.
  assert.equal(
    authorize({ host: '127.0.0.1:8090', token: TOKEN, givenToken: undefined }).status,
    401,
  )
})

test('tokensMatch rejects length mismatches without throwing', () => {
  assert.equal(tokensMatch(TOKEN, TOKEN), true)
  assert.equal(tokensMatch(TOKEN, ''), false)
  assert.equal(tokensMatch(TOKEN, undefined), false)
  assert.equal(tokensMatch(TOKEN, TOKEN + 'x'), false)
})

test('routing covers only the known endpoints', () => {
  assert.equal(routeOf('/').kind, 'page')
  assert.equal(routeOf('/api/state').kind, 'state')
  assert.equal(routeOf('/api/setting').kind, 'setting')
  assert.equal(routeOf('/api/server').kind, 'server')
  assert.equal(routeOf('/api/state/').kind, 'state', 'trailing slash tolerated')
  assert.equal(routeOf('/../../etc/passwd').kind, 'unknown')
  assert.equal(routeOf('/api/anything').kind, 'unknown')
})

test('only the four declared server actions are accepted', () => {
  for (const a of ['start', 'stop', 'restart', 'clear']) {
    assert.equal(parseServerAction(a), a)
  }
  assert.equal(parseServerAction('rm -rf /'), undefined)
  assert.equal(parseServerAction(undefined), undefined)
  assert.equal(parseServerAction({ action: 'start' }), undefined)
})

test('secrets are redacted on the way out but non-secrets are untouched', () => {
  const out = redactSettings([
    { short: 'huggingFace.token', secret: true, value: 'hf_realsecret' },
    { short: 'server.port', value: 8080 },
    { short: 'server.apiKey', secret: true, value: '' },
  ] as never)
  assert.equal((out[0] as { value: unknown }).value, '••••••••')
  assert.equal((out[1] as { value: unknown }).value, 8080)
  assert.equal((out[2] as { value: unknown }).value, '', 'an empty secret stays empty')
})

test('an unchanged redacted secret is not written back over the real value', () => {
  assert.equal(isRedactedPlaceholder('••••••••'), true)
  assert.equal(isRedactedPlaceholder('hf_realsecret'), false)
  assert.equal(isRedactedPlaceholder(''), false)
  assert.equal(isRedactedPlaceholder(8080), false)
})
