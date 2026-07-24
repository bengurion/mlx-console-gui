import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bytesFromSafetensors,
  parseParamsB,
  bytesPerParam,
  fitVerdict,
  isGguf,
  chooseQuantBits,
  bytesForBits,
  classifyFormat,
  explainFit,
} from '../src/services/modelFit.ts'

test('explainFit separates over-budget from physically impossible', () => {
  const GB = 1024 ** 3
  const total = 128 * GB
  const budget = Math.floor(total * 0.75)

  assert.equal(explainFit(20 * GB, budget, total).verdict, 'fits')
  assert.equal(explainFit(80 * GB, budget, total).verdict, 'tight')

  // 101 GB of weights needs ~116 GB at runtime: past the 96 GB budget, under 128 GB RAM.
  const big = explainFit(101 * GB, budget, total)
  assert.equal(big.verdict, 'over-budget')
  assert.match(big.detail, /still under this machine's 128 GB/)

  assert.equal(explainFit(140 * GB, budget, total).verdict, 'too-large')
})

test('bytesFromSafetensors multiplies dtype counts by width', () => {
  // Real payload for mlx-community/Qwen2.5-Coder-7B-Instruct-4bit
  const bytes = bytesFromSafetensors({ F16: 238310912, U32: 951910400 })
  // 238310912*2 + 951910400*4 = 4_284_263_424 (~4.3 GB, matches a 7B 4-bit MLX model)
  assert.equal(bytes, 4_284_263_424)
})

test('bytesFromSafetensors returns undefined for missing data', () => {
  assert.equal(bytesFromSafetensors(undefined), undefined)
  assert.equal(bytesFromSafetensors({}), undefined)
})

test('parseParamsB reads parameter counts and ignores bit-width suffixes', () => {
  assert.equal(parseParamsB('mlx-community/Qwen2.5-Coder-7B-Instruct-4bit'), 7)
  assert.equal(parseParamsB('lmstudio-community/gpt-oss-120b-MLX-8bit'), 120)
  assert.equal(parseParamsB('mlx-community/parakeet-tdt-0.6b-v2'), 0.6)
  assert.equal(parseParamsB('org/model-without-size'), undefined)
})

test('parseParamsB expands mixture-of-experts notation', () => {
  assert.equal(parseParamsB('mlx-community/Mixtral-8x7B-Instruct-4bit'), 56)
})

test('bytesPerParam maps quantization labels', () => {
  assert.equal(bytesPerParam('4bit'), 0.5)
  assert.equal(bytesPerParam('8bit'), 1)
  assert.equal(bytesPerParam('bf16'), 2)
  assert.equal(bytesPerParam(undefined), 2)
})

test('fitVerdict grades against the memory budget', () => {
  const budget = 96 * 1024 ** 3 // 96 GB usable of 128 GB
  assert.equal(fitVerdict(4 * 1024 ** 3, budget), 'fits')
  assert.equal(fitVerdict(77 * 1024 ** 3, budget), 'tight')
  assert.equal(fitVerdict(200 * 1024 ** 3, budget), 'too-large')
  assert.equal(fitVerdict(undefined, budget), 'unknown')
})

test('chooseQuantBits picks the highest quantization that fits', () => {
  const big = 128 * 1024 ** 3 * 0.75 // 96 GB usable on a 128 GB machine

  // A 7B model keeps full 8-bit quality.
  assert.equal(chooseQuantBits(7, big), 8)
  // 400B does not fit even at 2-bit (~100 GB of weights alone).
  assert.equal(chooseQuantBits(400, big), undefined)
  // Unknown parameter count yields no recommendation.
  assert.equal(chooseQuantBits(undefined, big), undefined)

  // Bigger models must be quantized more aggressively on the same machine.
  const small = chooseQuantBits(7, big)!
  const large = chooseQuantBits(70, big)!
  assert.ok(large < small, `expected 70B (${large}) to use fewer bits than 7B (${small})`)
})

test('bytesForBits scales linearly with bit width', () => {
  const eight = bytesForBits(7, 8)
  const four = bytesForBits(7, 4)
  assert.ok(Math.abs(eight / four - 2) < 1e-9)
})

test('classifyFormat separates runnable, convertible and unsupported repos', () => {
  // Already MLX -> download and run.
  assert.equal(classifyFormat('mlx-community/Qwen2.5-7B-4bit', ['mlx', 'safetensors']), 'mlx')
  assert.equal(classifyFormat('org/model', [], 'mlx'), 'mlx')
  // Plain safetensors -> mlx_lm.convert can handle it.
  assert.equal(classifyFormat('Qwen/Qwen2.5-Coder-7B-Instruct', ['safetensors', 'transformers']), 'convertible')
  // GGUF -> neither runnable nor convertible.
  assert.equal(classifyFormat('TheBloke/Llama-2-7B-GGUF', ['gguf']), 'unsupported')
  // No safetensors (legacy .bin only) -> the loader would fail.
  assert.equal(classifyFormat('org/old-model', ['pytorch']), 'unsupported')
})

test('isGguf detects llama.cpp-format repos', () => {
  assert.equal(isGguf('TheBloke/Llama-2-7B-GGUF'), true)
  assert.equal(isGguf('org/model', ['gguf']), true)
  assert.equal(isGguf('mlx-community/Qwen2.5-Coder-7B-Instruct-4bit', ['mlx']), false)
})

// ---- parameter counts for quantized repos ----------------------------------

test('a quantized model is measured by its parameters, not its packed elements', async () => {
  const { effectiveParamsB } = await import('../src/services/modelFit.ts')

  // MLX packs eight 4-bit weights into one uint32, so the Hub reports 1.3B
  // stored elements for an 8B model. Trusting that hides it from a 4-9B search.
  const packed = { U32: 1_000_000_000, F16: 300_000_000 }
  assert.equal(
    effectiveParamsB(1_300_000_000, packed, 'lmstudio-community/DeepSeek-R1-Qwen3-8B-MLX-4bit', '4bit'),
    8,
  )

  // Unquantized: the metadata is the parameter count, and is preferred over
  // whatever the name claims.
  assert.equal(effectiveParamsB(8_190_735_360, { BF16: 8_190_735_360 }, 'Qwen/Qwen3-8B'), 8.19073536)

  // Packed with no size in the name: recovered from the weight bytes.
  const recovered = effectiveParamsB(1_000_000_000, { U32: 1_000_000_000 }, 'org/mystery-4bit', '4bit')
  assert.ok(recovered && recovered > 7 && recovered < 9, `got ${recovered}`)

  assert.equal(effectiveParamsB(undefined, undefined, 'org/nothing'), undefined)

  // A repo *named* "-4bit" whose tensors are all floats is mislabelled, not
  // packed: one element per parameter, so the Hub's count is exact. Guessing
  // from the name here octupled phi-4 uploads to "113B".
  assert.equal(
    effectiveParamsB(14_659_507_200, { F32: 14_659_507_200 }, 'someone/microsoft-phi-4-quantized-4bit', '4bit'),
    14.6595072,
  )
})

test('AWQ/GPTQ/bnb repos are recognised as reporting logical counts', async () => {
  const { hubCountsLogicalParams, estimateBytesFromParams } = await import('../src/services/modelFit.ts')
  assert.equal(hubCountsLogicalParams('curiousmind147/microsoft-phi-4-AWQ-4bit-GEMM', ['awq']), true)
  assert.equal(hubCountsLogicalParams('unsloth/phi-4-unsloth-bnb-4bit'), true)
  assert.equal(hubCountsLogicalParams('org/Model-GPTQ'), true)
  // MLX packed repos keep the elements-are-storage interpretation.
  assert.equal(hubCountsLogicalParams('mlx-community/Qwen2.5-7B-Instruct-4bit', ['mlx']), false)
  // 14.66B logical params at 4-bit is ~9 GB, not the 53 GB of 14.66e9 int32s.
  const est = estimateBytesFromParams(14.66, '4bit')
  assert.ok(est > 7e9 && est < 11e9, `got ${est}`)
})

test('baseModelFromTags recovers the source repo from structured tags', async () => {
  const { baseModelFromTags } = await import('../src/services/modelFit.ts')
  assert.equal(
    baseModelFromTags(['qwen2', 'base_model:quantized:Qwen/Qwen2.5-72B-Instruct', 'awq']),
    'Qwen/Qwen2.5-72B-Instruct',
  )
  assert.equal(baseModelFromTags(['base_model:meta-llama/Llama-3.1-8B']), 'meta-llama/Llama-3.1-8B')
  assert.equal(baseModelFromTags(['text-generation', 'en']), undefined)
})

test('parseParamsB falls back to millions only when no B-count exists', async () => {
  const { parseParamsB } = await import('../src/services/modelFit.ts')
  assert.equal(parseParamsB('HuggingFaceTB/SmolLM2-135M-Instruct'), 0.135)
  assert.equal(parseParamsB('facebook/MobileLLM-350M'), 0.35)
  // "-1M" is a context window, not 0.001B — the 7B in the name wins.
  assert.equal(parseParamsB('Qwen/Qwen2.5-7B-Instruct-1M'), 7)
  // Bare "1M" with no B-count is below the 10M floor: a version, not a size.
  assert.equal(parseParamsB('org/some-model-1M'), undefined)
})

test('a size filter never drops a model whose size is unknown', async () => {
  const { withinParams } = await import('../src/services/modelFit.ts')
  assert.equal(withinParams(undefined, { minB: 4, maxB: 9 }), true, 'unknown is kept')
  assert.equal(withinParams(7, { minB: 4, maxB: 9 }), true)
  assert.equal(withinParams(3.9, { minB: 4, maxB: 9 }), false)
  assert.equal(withinParams(9.1, { minB: 4, maxB: 9 }), false)
  assert.equal(withinParams(700, undefined), true, 'no filter keeps everything')
  assert.equal(withinParams(0.5, { maxB: 1 }), true)
  assert.equal(withinParams(120, { minB: 80 }), true)
})
