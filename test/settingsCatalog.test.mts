import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseHumanBytes } from '../src/services/modelConfig.ts'
import {
  buildSettingsCatalog,
  coerceSettingValue,
  labelFor,
  groupFor,
} from '../src/services/settingsCatalog.ts'

const PROPS = {
  'mlxConsole.pythonPath': { type: 'string', default: '', description: 'Path to Python 3.' },
  'mlxConsole.server.port': { type: 'number', default: 8080, description: 'Port.' },
  'mlxConsole.server.exposeToLan': { type: 'boolean', default: false, description: 'Bind 0.0.0.0.' },
  'mlxConsole.server.extraArgs': { type: 'array', default: [], description: 'Extra args.' },
  'mlxConsole.modelOverrides': { type: 'object', default: {}, description: 'Per-model.' },
  'mlxConsole.huggingFace.token': { type: 'string', default: '', description: 'HF token.' },
  'mlxConsole.server.promptCacheBytes': {
    type: 'number',
    default: 0,
    markdownDescription: 'Max **bytes** of the `KV` caches.',
  },
}

test('labelFor humanizes the last dotted segment', () => {
  assert.equal(labelFor('server.promptCacheBytes'), 'Prompt cache bytes')
  assert.equal(labelFor('pythonPath'), 'Python path')
})

test('groupFor uses the first segment, general for top-level keys', () => {
  assert.equal(groupFor('server.port'), 'server')
  assert.equal(groupFor('pythonPath'), 'general')
})

test('buildSettingsCatalog covers every contributed property', () => {
  const cat = buildSettingsCatalog(PROPS, () => undefined)
  assert.equal(cat.length, Object.keys(PROPS).length, 'no setting is dropped')
  assert.deepEqual(
    cat.map((s) => s.key).sort(),
    Object.keys(PROPS).sort(),
  )
})

test('buildSettingsCatalog reads effective values and marks secrets', () => {
  const values: Record<string, unknown> = { 'server.port': 9000, 'huggingFace.token': 'hf_x' }
  const cat = buildSettingsCatalog(PROPS, (k) => values[k])

  const port = cat.find((s) => s.short === 'server.port')!
  assert.equal(port.value, 9000)
  assert.equal(port.default, 8080)
  assert.equal(port.type, 'number')
  assert.equal(port.group, 'server')

  const token = cat.find((s) => s.short === 'huggingFace.token')!
  assert.equal(token.secret, true, 'tokens must render masked')
  assert.equal(cat.find((s) => s.short === 'server.port')!.secret, undefined)
})

test('buildSettingsCatalog strips markdown from descriptions', () => {
  const cat = buildSettingsCatalog(PROPS, () => undefined)
  const d = cat.find((s) => s.short === 'server.promptCacheBytes')!.description!
  assert.equal(d, 'Max bytes of the KV caches.')
  assert.ok(!d.includes('*') && !d.includes('`'))
})

test('coerceSettingValue converts strings to the declared type', () => {
  assert.deepEqual(coerceSettingValue({ type: 'number' }, '8080'), { ok: true, value: 8080 })
  assert.deepEqual(coerceSettingValue({ type: 'boolean' }, 'yes'), { ok: true, value: true })
  assert.deepEqual(coerceSettingValue({ type: 'number' }, ''), { ok: true, value: undefined })
})

test('coerceSettingValue rejects bad numbers and JSON', () => {
  const n = coerceSettingValue({ type: 'number' }, 'abc')
  assert.equal(n.ok, false)

  const j = coerceSettingValue({ type: 'object' }, '{not json')
  assert.equal(j.ok, false)

  // An array setting given a JSON object is a type mismatch, not valid input.
  const a = coerceSettingValue({ type: 'array' }, '{"a":1}')
  assert.equal(a.ok, false)
})

test('coerceSettingValue parses valid JSON containers', () => {
  assert.deepEqual(coerceSettingValue({ type: 'array' }, '["--foo","1"]'), {
    ok: true,
    value: ['--foo', '1'],
  })
  assert.deepEqual(coerceSettingValue({ type: 'object' }, '{"m":{"temperature":0.2}}'), {
    ok: true,
    value: { m: { temperature: 0.2 } },
  })
  // Empty input means "clear", not an error.
  assert.deepEqual(coerceSettingValue({ type: 'array' }, '  '), { ok: true, value: [] })
})

test('numeric settings containing "token" are not masked', () => {
  // Regression: a substring match on /token/ made maxOutputTokens,
  // sampling.maxTokens and numDraftTokens render as password dots.
  const props = {
    'mlxConsole.maxOutputTokens': { type: 'number', default: 4096 },
    'mlxConsole.sampling.maxTokens': { type: 'number', default: 2048 },
    'mlxConsole.server.numDraftTokens': { type: 'number', default: 0 },
    'mlxConsole.huggingFace.token': { type: 'string', default: '' },
    'mlxConsole.server.apiKey': { type: 'string', default: '' },
  }
  const cat = buildSettingsCatalog(props, () => undefined)
  const secret = (short: string) => cat.find((s) => s.short === short)!.secret

  assert.equal(secret('maxOutputTokens'), undefined)
  assert.equal(secret('sampling.maxTokens'), undefined)
  assert.equal(secret('server.numDraftTokens'), undefined)
  // Real credentials still masked.
  assert.equal(secret('huggingFace.token'), true)
  assert.equal(secret('server.apiKey'), true)
})

test('byte settings accept human sizes and are flagged for MB/GB display', () => {
  const props = {
    'mlxConsole.server.promptCacheBytes': { type: 'number', default: 0 },
    'mlxConsole.server.port': { type: 'number', default: 8080 },
  }
  const cat = buildSettingsCatalog(props, () => undefined)
  assert.equal(cat.find((s) => s.short === 'server.promptCacheBytes')!.unit, 'bytes')
  assert.equal(cat.find((s) => s.short === 'server.port')!.unit, undefined)

  assert.equal(parseHumanBytes('8 GB'), 8 * 1024 ** 3)
  assert.equal(parseHumanBytes('512mb'), 512 * 1024 ** 2)
  // A bare number is MB — the unit people type for cache sizes.
  assert.equal(parseHumanBytes('2048'), 2048 * 1024 ** 2)
  assert.equal(parseHumanBytes('nonsense'), undefined)

  const ok = coerceSettingValue({ type: 'number', unit: 'bytes' }, '8 GB')
  assert.deepEqual(ok, { ok: true, value: 8 * 1024 ** 3 })
  assert.equal(coerceSettingValue({ type: 'number', unit: 'bytes' }, 'huge').ok, false)
})
