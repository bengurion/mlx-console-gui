import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assembleToolCalls, type ChatEvent } from '../src/backend/mlxClient.ts'

test('assembleToolCalls merges streamed tool-call deltas', () => {
  const events: ChatEvent[] = [
    { type: 'toolCallDelta', index: 0, id: 'call_1', name: 'do_thing', argsDelta: '{"a":' },
    { type: 'toolCallDelta', index: 0, argsDelta: '1}' },
    { type: 'content', text: 'ignored' },
    { type: 'done', finishReason: 'tool_calls' },
  ]
  const calls = assembleToolCalls(events)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].id, 'call_1')
  assert.equal(calls[0].function.name, 'do_thing')
  assert.equal(calls[0].function.arguments, '{"a":1}')
})

test('assembleToolCalls keeps multiple calls ordered by index', () => {
  const events: ChatEvent[] = [
    { type: 'toolCallDelta', index: 1, id: 'b', name: 'second', argsDelta: '{}' },
    { type: 'toolCallDelta', index: 0, id: 'a', name: 'first', argsDelta: '{}' },
  ]
  const calls = assembleToolCalls(events)
  assert.deepEqual(
    calls.map((c) => c.function.name),
    ['first', 'second'],
  )
})

test('assembleToolCalls returns nothing when there are no tool deltas', () => {
  const events: ChatEvent[] = [
    { type: 'content', text: 'hello' },
    { type: 'done', finishReason: 'stop' },
  ]
  assert.equal(assembleToolCalls(events).length, 0)
})
