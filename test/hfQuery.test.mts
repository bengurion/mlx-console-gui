import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveQuant,
  mapSort,
  buildSearchUrl,
  nextPageUrl,
  paramsFilter,
} from '../src/services/hfQuery.ts'

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
    scope: 'mlx',
    mlxCommunity: true,
    sort: 'downloads',
    limit: 20,
  })
  assert.match(url, /search=coder/)
  assert.match(url, /filter=mlx/)
  assert.match(url, /author=mlx-community/)
  assert.match(url, /limit=20/)
  assert.match(url, /sort=downloads/)
  // Parameter counts ride along with the search instead of costing one request
  // per repo afterwards.
  assert.match(url, /expand%5B%5D=safetensors/)
  assert.doesNotMatch(url, /full=true/)
})

test('a wider scope does not narrow the query server-side', () => {
  // 'has safetensors' is a fact about the files; the tag is not reliable
  // enough to filter on at the API, so those scopes are decided per row.
  for (const scope of ['convertible', 'all'] as const) {
    const url = buildSearchUrl({ text: '', scope, mlxCommunity: false, sort: 'likes', limit: 30 })
    assert.doesNotMatch(url, /filter=mlx/, scope)
  }
})

test('buildSearchUrl omits optional filters when disabled', () => {
  const url = buildSearchUrl({
    text: '',
    scope: 'convertible',
    mlxCommunity: false,
    sort: 'likes',
    limit: 30,
  })
  assert.doesNotMatch(url, /filter=mlx/)
  assert.doesNotMatch(url, /author=/)
  assert.doesNotMatch(url, /search=/)
})

test('a page never asks for more than the Hub allows', () => {
  const url = buildSearchUrl({
    text: '',
    scope: 'all',
    mlxCommunity: false,
    sort: 'likes',
    limit: 5000,
  })
  assert.match(url, /limit=1000/)
})

test('the size filter is sent to the Hub, widened so packing cannot hide a model', () => {
  // The Hub filters on stored elements, so a 4-bit 8B repo can measure 1B.
  // Asking for min/8 keeps it in the candidate set; the exact check drops
  // whatever that over-admits.
  assert.equal(paramsFilter({ minB: 8, maxB: 9 }), 'min:1B,max:9B')
  assert.equal(paramsFilter({ maxB: 4 }), 'max:4B')
  assert.equal(paramsFilter({ minB: 80 }), 'min:10B')
  assert.equal(paramsFilter(undefined), undefined)
  assert.equal(paramsFilter({}), undefined)

  const url = buildSearchUrl({
    text: '',
    scope: 'mlx',
    mlxCommunity: false,
    sort: 'downloads',
    limit: 20,
    params: { minB: 30, maxB: 40 },
  })
  assert.match(url, /num_parameters=min%3A3.75B%2Cmax%3A40B/)
})

test('the next page comes from the Link header, since the Hub rejects offsets', () => {
  const header = '<https://huggingface.co/api/models?cursor=abc123&limit=100>; rel="next"'
  assert.equal(nextPageUrl(header), 'https://huggingface.co/api/models?cursor=abc123&limit=100')

  // Last page: no next link. That is what tells the caller the results are
  // exhausted rather than merely unexplored.
  assert.equal(nextPageUrl(null), undefined)
  assert.equal(nextPageUrl('<https://x/prev>; rel="prev"'), undefined)
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
    return new Response(JSON.stringify([{ id: 'org/model-4bit', tags: ['mlx'] }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const query = {
      text: 'qwen',
      scope: 'mlx' as const,
      mlxCommunity: false,
      sort: 'downloads' as const,
      limit: 10,
    }
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
    const query = {
      text: 'x',
      scope: 'mlx' as const,
      mlxCommunity: false,
      sort: 'downloads' as const,
      limit: 5,
    }
    await assert.rejects(() => svc.search(query))
    await assert.rejects(() => svc.search(query))
    assert.equal(calls, 2, 'the failure was retried rather than remembered')
  } finally {
    globalThis.fetch = realFetch
  }
})

// ---- paging and filtering --------------------------------------------------

/** One Hub row, in the shape `expand[]=safetensors` returns. */
const row = (id: string, params?: number, extra: Record<string, unknown> = {}) => ({
  id,
  tags: ['safetensors'],
  ...(params ? { safetensors: { total: params, parameters: { BF16: params } } } : {}),
  ...extra,
})

/** Serve pages, linking each to the next the way the Hub does. */
function pagedFetch(pages: unknown[][]) {
  let calls = 0
  return {
    calls: () => calls,
    fetch: (async (url: string) => {
      const page = pages[calls] ?? []
      calls++
      const more = calls < pages.length
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          ...(more ? { link: `<https://huggingface.co/api/models?cursor=p${calls}>; rel="next"` } : {}),
        },
      })
    }) as unknown as typeof fetch,
  }
}

test('the search keeps paging until the page is full, rather than filtering one window', async () => {
  const { HuggingFaceService } = await import('../src/services/huggingFaceService.ts')
  const svc = new HuggingFaceService()
  const realFetch = globalThis.fetch

  // Only the third page holds models in the requested size band: the old
  // fixed-window search would have reported "none" and stopped.
  const paged = pagedFetch([
    [row('a/tiny-1', 5e8), row('a/tiny-2', 6e8)],
    [row('b/small', 2e9)],
    [row('c/target-1', 7e9), row('c/target-2', 8e9)],
  ])
  globalThis.fetch = paged.fetch
  try {
    const res = await svc.search({
      text: 'x',
      scope: 'convertible',
      mlxCommunity: false,
      sort: 'downloads',
      limit: 2,
      params: { minB: 4, maxB: 9 },
    })
    assert.deepEqual(res.items.map((m) => m.id), ['c/target-1', 'c/target-2'])
    assert.equal(res.scanned, 5, 'it reports how much of the Hub it looked at')
    assert.equal(res.exhausted, true, 'and that it reached the end')
    assert.equal(paged.calls(), 3)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('sizes and parameter counts come from the search itself', async () => {
  const { HuggingFaceService } = await import('../src/services/huggingFaceService.ts')
  const svc = new HuggingFaceService()
  const realFetch = globalThis.fetch
  const paged = pagedFetch([[row('org/Mystery-Model', 7.2e9)]])
  globalThis.fetch = paged.fetch
  try {
    const res = await svc.search({
      text: 'mystery',
      scope: 'convertible',
      mlxCommunity: false,
      sort: 'downloads',
      limit: 10,
    })
    const m = res.items[0]
    // The repo name says nothing about size; the metadata does.
    assert.equal(Math.round((m.paramsB ?? 0) * 10) / 10, 7.2)
    assert.equal(m.sizeExact, true, 'no second request was needed to know this')
    assert.equal(m.sizeBytes, 7.2e9 * 2, 'BF16 is two bytes per parameter')
    assert.equal(paged.calls(), 1)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('an unknown size survives a size filter instead of vanishing', async () => {
  const { HuggingFaceService } = await import('../src/services/huggingFaceService.ts')
  const svc = new HuggingFaceService()
  const realFetch = globalThis.fetch
  // No safetensors metadata at all — the Hub simply does not know.
  const paged = pagedFetch([[{ id: 'org/undocumented', tags: ['safetensors'] }]])
  globalThis.fetch = paged.fetch
  try {
    const res = await svc.search({
      text: '',
      scope: 'convertible',
      mlxCommunity: false,
      sort: 'downloads',
      limit: 10,
      params: { minB: 4, maxB: 9 },
    })
    assert.deepEqual(res.items.map((m) => m.id), ['org/undocumented'])
  } finally {
    globalThis.fetch = realFetch
  }
})

test('GGUF is dropped unless the scope asks for everything', async () => {
  const { HuggingFaceService } = await import('../src/services/huggingFaceService.ts')
  const realFetch = globalThis.fetch
  const rows = [[row('org/Model-GGUF', 0, { tags: ['gguf'] }), row('org/Model', 7e9)]]
  try {
    for (const [scope, expected] of [
      ['convertible', ['org/Model']],
      ['all', ['org/Model-GGUF', 'org/Model']],
    ] as const) {
      const svc = new (await import('../src/services/huggingFaceService.ts')).HuggingFaceService()
      globalThis.fetch = pagedFetch(rows).fetch
      const res = await svc.search({
        text: '',
        scope,
        mlxCommunity: false,
        sort: 'downloads',
        limit: 10,
      })
      assert.deepEqual(res.items.map((m) => m.id), expected, scope)
    }
  } finally {
    globalThis.fetch = realFetch
  }
})
