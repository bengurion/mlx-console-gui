import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveQuant, mapSort, buildSearchUrl } from '../src/services/hfQuery.ts'

test('deriveQuant detects quantization from id and tags', () => {
  assert.equal(deriveQuant('mlx-community/Model-4bit'), '4bit')
  assert.equal(deriveQuant('org/Model', ['mlx', '8-bit']), '8bit')
  assert.equal(deriveQuant('org/Model-bf16'), 'bf16')
  assert.equal(deriveQuant('org/PlainModel'), undefined)
})

test('mapSort maps the UI keys to HF sort fields', () => {
  assert.equal(mapSort('trending'), 'trendingScore')
  assert.equal(mapSort('downloads'), 'downloads')
  assert.equal(mapSort('likes'), 'likes')
  assert.equal(mapSort('lastModified'), 'lastModified')
})

test('buildSearchUrl encodes filters', () => {
  const url = buildSearchUrl({
    text: 'coder',
    libraryMlx: true,
    mlxCommunity: true,
    sort: 'downloads',
    limit: 20,
  })
  assert.match(url, /search=coder/)
  assert.match(url, /filter=mlx/)
  assert.match(url, /author=mlx-community/)
  assert.match(url, /limit=20/)
  assert.match(url, /sort=downloads/)
  assert.match(url, /full=true/)
})

test('buildSearchUrl omits optional filters when disabled', () => {
  const url = buildSearchUrl({
    text: '',
    libraryMlx: false,
    mlxCommunity: false,
    sort: 'likes',
    limit: 30,
  })
  assert.doesNotMatch(url, /filter=mlx/)
  assert.doesNotMatch(url, /author=/)
  assert.doesNotMatch(url, /search=/)
})

// ---- search caching --------------------------------------------------------

test('an identical search is served from cache, and concurrent ones share a request', async () => {
  const { HuggingFaceService } = await import('../src/services/huggingFaceService.ts')
  const svc = new HuggingFaceService()

  let calls = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    calls++
    // One slow response, so the second caller arrives while it is in flight.
    await new Promise((r) => setTimeout(r, 30))
    return new Response(JSON.stringify([{ id: 'org/model-4bit', tags: ['mlx'], siblings: [] }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const query = { text: 'qwen', libraryMlx: true, sort: 'downloads' as const, limit: 10 }
    const [a, b] = await Promise.all([svc.search(query), svc.search(query)])
    assert.equal(calls, 1, 'two concurrent identical searches make one request')
    assert.deepEqual(a, b)

    await svc.search(query)
    assert.equal(calls, 1, 'a repeat within the TTL does not hit the network')

    await svc.search({ ...query, text: 'llama' })
    assert.equal(calls, 2, 'a different query still searches')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a failed search is not cached, so the next attempt retries', async () => {
  const { HuggingFaceService } = await import('../src/services/huggingFaceService.ts')
  const svc = new HuggingFaceService()

  let calls = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    calls++
    return new Response('nope', { status: 503 })
  }) as typeof fetch

  try {
    const query = { text: 'x', libraryMlx: true, sort: 'downloads' as const, limit: 5 }
    await assert.rejects(() => svc.search(query))
    await assert.rejects(() => svc.search(query))
    assert.equal(calls, 2, 'the failure was retried rather than remembered')
  } finally {
    globalThis.fetch = realFetch
  }
})
