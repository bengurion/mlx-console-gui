import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SAMPLING_DEFAULTS,
  mergeSampling,
  toRequestFields,
} from '../src/services/sampling.ts'

test('mergeSampling lets per-model overrides win', () => {
  const merged = mergeSampling(SAMPLING_DEFAULTS, { temperature: 0.2, maxTokens: 4096 })
  assert.equal(merged.temperature, 0.2)
  assert.equal(merged.maxTokens, 4096)
  // Untouched fields keep the defaults.
  assert.equal(merged.topP, SAMPLING_DEFAULTS.topP)
})

test('mergeSampling ignores missing and non-numeric values', () => {
  assert.deepEqual(mergeSampling(SAMPLING_DEFAULTS, undefined), SAMPLING_DEFAULTS)
  const merged = mergeSampling(SAMPLING_DEFAULTS, {
    temperature: Number.NaN,
    topK: undefined,
  } as never)
  assert.equal(merged.temperature, SAMPLING_DEFAULTS.temperature)
  assert.equal(merged.topK, SAMPLING_DEFAULTS.topK)
})

test('toRequestFields omits disabled samplers', () => {
  const fields = toRequestFields(SAMPLING_DEFAULTS)
  assert.equal(fields.temperature, 0.7)
  assert.equal(fields.max_tokens, 2048)
  // top_k=0, min_p=0 and repetition_penalty=1 are disabling values -> not sent.
  assert.ok(!('top_k' in fields))
  assert.ok(!('min_p' in fields))
  assert.ok(!('repetition_penalty' in fields))
})

test('toRequestFields includes samplers once enabled', () => {
  const fields = toRequestFields({
    ...SAMPLING_DEFAULTS,
    topK: 40,
    minP: 0.05,
    repetitionPenalty: 1.1,
  })
  assert.equal(fields.top_k, 40)
  assert.equal(fields.min_p, 0.05)
  assert.equal(fields.repetition_penalty, 1.1)
})
