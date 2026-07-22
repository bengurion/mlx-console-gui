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
