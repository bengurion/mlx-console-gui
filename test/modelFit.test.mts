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
