import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseContextLength,
  cacheDirName,
  isLocalPath,
  effectiveContextWindow,
  parseAttentionShape,
  kvBytesPerToken,
  clampContextToHeadroom,
  preflightCheck,
  parseGenerationDefaults,
  defaultMaxOutputTokens,
  humanBytes,
  recommendConcurrency,
  SERVER_DEFAULTS,
  selectDraftModel,
  parseVocabSize,
  availableFor,
  occupancyBytes,
} from '../src/services/modelConfig.ts'

test('parseContextLength reads max_position_embeddings', () => {
  // Real shape from cloudyu/gpt-oss-120b-Fable-5-Distilled.
  const cfg = JSON.stringify({
    model_type: 'gpt_oss',
    max_position_embeddings: 131072,
    sliding_window: 128,
    num_hidden_layers: 36,
  })
  assert.equal(parseContextLength(cfg), 131072)
})

test('parseContextLength ignores sliding_window', () => {
  // gpt-oss interleaves 128-token local attention but still accepts the full
  // window; treating sliding_window as the context would be catastrophic.
  const cfg = JSON.stringify({ sliding_window: 128 })
  assert.equal(parseContextLength(cfg), undefined)
})

test('parseContextLength handles alternate key spellings', () => {
  assert.equal(parseContextLength(JSON.stringify({ n_positions: 8192 })), 8192)
  assert.equal(parseContextLength(JSON.stringify({ max_seq_len: 4096 })), 4096)
})

test('parseContextLength looks inside text_config for multimodal models', () => {
  const cfg = JSON.stringify({ model_type: 'llava', text_config: { max_position_embeddings: 32768 } })
  assert.equal(parseContextLength(cfg), 32768)
})

test('parseContextLength rejects junk and implausible values', () => {
  assert.equal(parseContextLength('not json'), undefined)
  assert.equal(parseContextLength(JSON.stringify({ max_position_embeddings: 8 })), undefined)
  assert.equal(parseContextLength(JSON.stringify({ max_position_embeddings: 'lots' })), undefined)
})

test('cacheDirName matches the Hugging Face layout', () => {
  assert.equal(
    cacheDirName('cloudyu/gpt-oss-120b-Fable-5-Distilled'),
    'models--cloudyu--gpt-oss-120b-Fable-5-Distilled',
  )
})

test('isLocalPath distinguishes converted models from repo ids', () => {
  assert.equal(isLocalPath('/Users/ben/mlx-models/foo-4bit'), true)
  assert.equal(isLocalPath('mlx-community/Qwen2.5-7B'), false)
})

test('effectiveContextWindow prefers an explicit user setting', () => {
  const r = effectiveContextWindow({ userConfigured: 8192, fromModel: 131072, fallback: 4096 })
  assert.deepEqual(r, { value: 8192, source: 'user' })
})

test('effectiveContextWindow falls back to model metadata, then the default', () => {
  assert.deepEqual(effectiveContextWindow({ fromModel: 131072, fallback: 4096 }), {
    value: 131072,
    source: 'model',
  })
  assert.deepEqual(effectiveContextWindow({ fallback: 4096 }), { value: 4096, source: 'default' })
})

test('kvBytesPerToken uses KV heads, not attention heads', () => {
  // gpt-oss-120b: 36 layers, 64 attention heads but only 8 KV heads (GQA).
  const shape = parseAttentionShape(
    JSON.stringify({
      num_hidden_layers: 36,
      num_attention_heads: 64,
      num_key_value_heads: 8,
      head_dim: 64,
    }),
  )!
  assert.deepEqual(shape, { layers: 36, kvHeads: 8, headDim: 64 })
  // 2 (K+V) * 36 * 8 * 64 * 2 bytes = 73728 = 72 KiB/token
  assert.equal(kvBytesPerToken(shape), 73_728)
})

test('parseAttentionShape derives head_dim when absent', () => {
  const shape = parseAttentionShape(
    JSON.stringify({ num_hidden_layers: 32, num_attention_heads: 32, hidden_size: 4096 }),
  )!
  assert.equal(shape.headDim, 128)
  assert.equal(shape.kvHeads, 32, 'falls back to attention heads without GQA')
})

test('clampContextToHeadroom leaves a window that already fits', () => {
  const r = clampContextToHeadroom({
    modelWindow: 131072,
    headroomBytes: 100 * 1024 ** 3,
    kvBytesPerToken: 73_728,
  })
  assert.deepEqual(r, { window: 131072, clamped: false })
})

test('clampContextToHeadroom shrinks the window when memory is short', () => {
  // 8 GB headroom, half offered to KV at 72 KiB/token -> ~58k tokens.
  const r = clampContextToHeadroom({
    modelWindow: 131072,
    headroomBytes: 8 * 1024 ** 3,
    kvBytesPerToken: 73_728,
  })
  assert.equal(r.clamped, true)
  assert.ok(r.window < 131072 && r.window > 8192)
})

test('clampContextToHeadroom never returns an unusably small window', () => {
  const r = clampContextToHeadroom({
    modelWindow: 131072,
    headroomBytes: 1024,
    kvBytesPerToken: 73_728,
  })
  assert.equal(r.window, 8192, 'floors instead of collapsing to near zero')
})

test('clampContextToHeadroom is a no-op without memory information', () => {
  assert.deepEqual(clampContextToHeadroom({ modelWindow: 131072 }), {
    window: 131072,
    clamped: false,
  })
})

test('preflightCheck blocks only what cannot fit', () => {
  const GB = 1024 ** 3
  const ceiling = 107.5 * GB

  assert.equal(preflightCheck({ weightBytes: 40 * GB, ceilingBytes: ceiling }).verdict, 'ok')
  assert.equal(preflightCheck({ weightBytes: 90 * GB, ceilingBytes: ceiling }).verdict, 'tight')

  const tooBig = preflightCheck({ weightBytes: 120 * GB, ceilingBytes: ceiling })
  assert.equal(tooBig.verdict, 'will-not-fit')
  assert.match(tooBig.message!, /only/i)
})

test('availableFor reclaims our resident model but not other apps memory', () => {
  const GB = 1024 ** 3
  const ceiling = 107.5 * GB

  // 62 GB in use, all of it our resident model -> the whole ceiling is free.
  assert.equal(availableFor(ceiling, 62 * GB, 62 * GB), ceiling)

  // 70 GB in use of which 62 GB is ours: 8 GB is held by something else and
  // will NOT be freed when we swap models.
  assert.equal(availableFor(ceiling, 70 * GB, 62 * GB), ceiling - 8 * GB)

  // Nothing of ours resident: every in-use byte belongs to someone else.
  assert.equal(availableFor(ceiling, 20 * GB, 0), ceiling - 20 * GB)
  assert.equal(availableFor(ceiling, 200 * GB, 0), 0, 'never negative')
})

test('preflightCheck counts memory held by other apps against the budget', () => {
  const GB = 1024 ** 3
  const ceiling = 107.5 * GB

  // 90 GB model, nothing else running -> tight but allowed.
  assert.equal(preflightCheck({ weightBytes: 90 * GB, ceilingBytes: ceiling }).verdict, 'tight')

  // Same model, but 30 GB is held by another app and will not be released.
  const contended = preflightCheck({
    weightBytes: 90 * GB,
    ceilingBytes: ceiling,
    gpuInUseBytes: 30 * GB,
    residentWeightBytes: 0,
  })
  assert.equal(contended.verdict, 'will-not-fit')
  assert.match(contended.message!, /other apps/i)
})

test('preflightCheck reclaims the outgoing model it is replacing', () => {
  const GB = 1024 ** 3
  const ceiling = 107.5 * GB
  // 62 GB resident and about to be dropped: the new 60 GB model fits fine.
  const r = preflightCheck({
    weightBytes: 60 * GB,
    ceilingBytes: ceiling,
    gpuInUseBytes: 62 * GB,
    residentWeightBytes: 62 * GB,
  })
  assert.equal(r.verdict, 'ok')
})

test('preflightCheck stays silent for an already-resident model', () => {
  const GB = 1024 ** 3
  const r = preflightCheck({
    weightBytes: 200 * GB,
    ceilingBytes: 107.5 * GB,
    alreadyResident: true,
  })
  assert.equal(r.verdict, 'ok', 'memory is already spent; nothing to predict')
})

test('preflightCheck degrades to ok without measurements', () => {
  assert.equal(preflightCheck({}).verdict, 'ok')
})

test('parseGenerationDefaults reads sampling the model recommends', () => {
  const g = parseGenerationDefaults(
    JSON.stringify({ temperature: 0.7, top_p: 0.8, top_k: 20, repetition_penalty: 1.05 }),
  )
  assert.deepEqual(g, { temperature: 0.7, topP: 0.8, topK: 20, repetitionPenalty: 1.05 })
})

test('parseGenerationDefaults returns nothing when the model ships only token ids', () => {
  // gpt-oss-120b's actual generation_config.json.
  const g = parseGenerationDefaults(
    JSON.stringify({ bos_token_id: 199998, eos_token_id: [200002], pad_token_id: 199999 }),
  )
  assert.deepEqual(g, {}, 'no sampling hints to inherit')
})

test('parseGenerationDefaults treats do_sample:false as greedy', () => {
  assert.equal(parseGenerationDefaults(JSON.stringify({ do_sample: false })).temperature, 0)
})

test('defaultMaxOutputTokens scales with the window but stays bounded', () => {
  assert.equal(defaultMaxOutputTokens(131072), 8192, 'capped')
  assert.equal(defaultMaxOutputTokens(4096), 1024, 'floored')
  assert.equal(defaultMaxOutputTokens(32768), 4096)
})

test('humanBytes formats sizes as MB/GB', () => {
  assert.equal(humanBytes(8 * 1024 ** 3), '8 GB')
  assert.equal(humanBytes(512 * 1024 ** 2), '512 MB')
  assert.equal(humanBytes(0), '0 MB')
  assert.equal(humanBytes(undefined), '—')

})

test('recommendConcurrency is far below the server default for a big model', () => {
  const GB = 1024 ** 3
  const r = recommendConcurrency({
    headroomBytes: 37 * GB,     // gpt-oss-120b resident under a 107.5 GB ceiling
    contextWindow: 131072,
    kvBytesPerToken: 73_728,    // ~9.7 GB per sequence
  })
  assert.ok(r.recommended !== undefined && r.recommended >= 1)
  assert.ok(r.recommended! < SERVER_DEFAULTS.decodeConcurrency, 'must not suggest 32 here')
  assert.equal(r.perSequenceBytes, 131072 * 73_728)
})

test('recommendConcurrency never drops below one sequence', () => {
  const r = recommendConcurrency({
    headroomBytes: 1024,
    contextWindow: 131072,
    kvBytesPerToken: 73_728,
  })
  assert.equal(r.recommended, 1)
})

test('recommendConcurrency declines without live figures', () => {
  const r = recommendConcurrency({})
  assert.equal(r.recommended, undefined)
  assert.match(r.reason, /loaded model/i)
})

test('selectDraftModel requires an exact vocabulary match', () => {
  const GB = 1024 ** 3
  const target = { modelId: 'big', vocabSize: 201088, weightBytes: 60 * GB }
  const r = selectDraftModel({
    target,
    candidates: [
      target,
      { modelId: 'other-vocab', vocabSize: 32000, weightBytes: 2 * GB },
    ],
  })
  assert.equal(r.modelId, undefined, 'a different tokenizer must never be chosen')
  assert.match(r.reason, /vocabulary/i)
})

test('selectDraftModel rejects a draft that is not much smaller', () => {
  const GB = 1024 ** 3
  const r = selectDraftModel({
    target: { modelId: 'big', vocabSize: 201088, weightBytes: 60 * GB },
    candidates: [{ modelId: 'nearly-as-big', vocabSize: 201088, weightBytes: 50 * GB }],
  })
  assert.equal(r.modelId, undefined)
  assert.match(r.reason, /small enough/i)
})

test('selectDraftModel prefers the largest draft within the size budget', () => {
  const GB = 1024 ** 3
  const r = selectDraftModel({
    target: { modelId: 'big', vocabSize: 201088, weightBytes: 60 * GB },
    candidates: [
      { modelId: 'tiny', vocabSize: 201088, weightBytes: 1 * GB },
      { modelId: 'small', vocabSize: 201088, weightBytes: 8 * GB },
    ],
  })
  // Bigger drafts propose better tokens, so more speculations are accepted.
  assert.equal(r.modelId, 'small')
})

test('selectDraftModel refuses a draft that will not fit alongside the target', () => {
  const GB = 1024 ** 3
  const r = selectDraftModel({
    target: { modelId: 'big', vocabSize: 201088, weightBytes: 60 * GB },
    candidates: [{ modelId: 'small', vocabSize: 201088, weightBytes: 8 * GB }],
    headroomBytes: 2 * GB,
  })
  assert.equal(r.modelId, undefined)
  assert.match(r.reason, /headroom/i)
})

test('parseVocabSize reads the target vocabulary', () => {
  assert.equal(parseVocabSize(JSON.stringify({ vocab_size: 201088 })), 201088)
  assert.equal(parseVocabSize(JSON.stringify({ text_config: { vocab_size: 32000 } })), 32000)
  assert.equal(parseVocabSize('nope'), undefined)
})

test('occupancyBytes prefers the server RSS when the GPU has gone idle', () => {
  const GB = 1024 ** 3
  // The real case: a resident model idling. ioreg says 1.8 GB, RSS says 52 GB.
  assert.equal(occupancyBytes({ gpuInUseBytes: 1.8 * GB, serverRssBytes: 52 * GB }), 52 * GB)
  // Mid-inference the GPU figure can lead; take whichever is larger.
  assert.equal(occupancyBytes({ gpuInUseBytes: 70 * GB, serverRssBytes: 52 * GB }), 70 * GB)
  // Either source alone still works.
  assert.equal(occupancyBytes({ serverRssBytes: 52 * GB }), 52 * GB)
  assert.equal(occupancyBytes({ gpuInUseBytes: 3 * GB }), 3 * GB)
  assert.equal(occupancyBytes({}), undefined)
})

test('headroom is not inflated by an idle model', () => {
  const GB = 1024 ** 3
  const ceiling = 107.5 * GB
  const occupied = occupancyBytes({ gpuInUseBytes: 1.8 * GB, serverRssBytes: 52 * GB })!
  // Nothing of ours counted as reclaimable: 52 GB is genuinely spoken for.
  assert.equal(availableFor(ceiling, occupied, 0), ceiling - 52 * GB)
  // Using the GPU figure alone would have claimed ~50 GB of phantom headroom.
  assert.ok(availableFor(ceiling, 1.8 * GB, 0) - availableFor(ceiling, occupied, 0) > 49 * GB)
})
