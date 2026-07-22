import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HarmonyFilter, parseHarmony, stripHarmony } from '../src/chat/harmony.ts'

const texts = (evs: ReturnType<typeof parseHarmony>, type: string) =>
  evs.filter((e) => e.type === type).map((e) => (e as { text: string }).text).join('')

test('plain text without harmony tokens passes through unchanged', () => {
  const evs = parseHarmony('Hello, world!')
  assert.equal(texts(evs, 'content'), 'Hello, world!')
  assert.equal(texts(evs, 'reasoning'), '')
})

test('analysis is separated from the final answer', () => {
  const raw =
    '<|channel|>analysis<|message|>User wants a plan. Think.<|end|>' +
    '<|start|>assistant<|channel|>final<|message|>Here is the plan.<|return|>'
  const evs = parseHarmony(raw)
  assert.equal(texts(evs, 'content'), 'Here is the plan.')
  assert.equal(texts(evs, 'reasoning'), 'User wants a plan. Think.')
  assert.ok(!texts(evs, 'content').includes('<|'))
})

test('the exact leak from the chat UI is cleaned', () => {
  const raw =
    '<|channel|>analysis<|message|>User wants to "implement the plan". ' +
    "There's a plan.md in session memory. Let's view it.<|end|>" +
    '<|start|>assistant<|channel|>commentary to=functions.memory <|constrain|>json<|message|>' +
    '{"command": "view", "path": "/memories/session/plan.md"}<|call|>'
  const evs = parseHarmony(raw)

  assert.equal(texts(evs, 'content'), '', 'nothing user-visible should leak')
  const calls = evs.filter((e) => e.type === 'toolCall')
  assert.equal(calls.length, 1)
  assert.equal((calls[0] as { name: string }).name, 'memory')
  assert.deepEqual(JSON.parse((calls[0] as { args: string }).args), {
    command: 'view',
    path: '/memories/session/plan.md',
  })
})

test('control tokens split across stream deltas are not emitted', () => {
  const raw =
    '<|channel|>analysis<|message|>hidden<|end|>' +
    '<|start|>assistant<|channel|>final<|message|>visible<|return|>'
  const f = new HarmonyFilter()
  const out: string[] = []
  // Feed one character at a time — the worst case for token boundaries.
  for (const ch of raw) {
    for (const ev of f.push(ch)) if (ev.type === 'content') out.push(ev.text)
  }
  for (const ev of f.flush()) if (ev.type === 'content') out.push(ev.text)

  const joined = out.join('')
  assert.equal(joined, 'visible')
  assert.ok(!joined.includes('<|'), 'no partial control tokens leaked')
})

test('stripHarmony keeps only the answer', () => {
  const raw = '<|channel|>analysis<|message|>noise<|end|><|channel|>final<|message|>answer<|return|>'
  assert.equal(stripHarmony(raw), 'answer')
})
