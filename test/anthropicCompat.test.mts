/**
 * The Anthropic ↔ OpenAI translation layer.
 *
 * Request shapes come from what Claude Code actually sends; response and
 * stream shapes from what mlx_lm.server actually returns. The streaming
 * grammar is the fiddly part: blocks must open before their deltas and close
 * before the message ends, whatever order the OpenAI chunks arrive in.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AnthropicStreamTranslator,
  chatToMessages,
  estimateTokens,
  messagesToChat,
} from '../src/services/anthropicCompat.ts'

const MODEL = 'cloudyu/gpt-oss-120b-Fable-5-Distilled'

test('a plain request: system first, strings pass through', () => {
  const out = messagesToChat({
    model: MODEL,
    max_tokens: 100,
    system: 'Be terse.',
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.deepEqual(out.messages, [
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: 'hi' },
  ])
  assert.equal(out.model, MODEL)
  assert.equal(out.max_tokens, 100)
  assert.equal(out.stream, false)
})

test('system as text blocks, content as blocks', () => {
  const out = messagesToChat({
    model: MODEL,
    max_tokens: 1,
    system: [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  })
  assert.deepEqual(out.messages, [
    { role: 'system', content: 'a\nb' },
    { role: 'user', content: 'hello' },
  ])
})

test('tool_result blocks become role:tool messages, before the user text', () => {
  const out = messagesToChat({
    model: MODEL,
    max_tokens: 1,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'exit 0' },
          { type: 'text', text: 'now continue' },
        ],
      },
    ],
  })
  assert.deepEqual(out.messages, [
    { role: 'tool', tool_call_id: 'call_1', content: 'exit 0' },
    { role: 'user', content: 'now continue' },
  ])
})

test('assistant tool_use becomes tool_calls with JSON arguments', () => {
  const out = messagesToChat({
    model: MODEL,
    max_tokens: 1,
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running it.' },
          { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'ls' } },
        ],
      },
    ],
  })
  const msg = (out.messages as Record<string, unknown>[])[0]
  assert.equal(msg.content, 'Running it.')
  assert.deepEqual(msg.tool_calls, [
    { id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
  ])
})

test('tool definitions and tool_choice are mapped', () => {
  const out = messagesToChat({
    model: MODEL,
    max_tokens: 1,
    messages: [],
    tools: [{ name: 'bash', description: 'run', input_schema: { type: 'object' } }],
    tool_choice: { type: 'any' },
  })
  assert.deepEqual(out.tools, [
    { type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object' } } },
  ])
  assert.equal(out.tool_choice, 'required')
})

test('a completion becomes an Anthropic message', () => {
  const out = chatToMessages({
    id: 'chatcmpl-1',
    model: MODEL,
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '4' } }],
    usage: { prompt_tokens: 68, completion_tokens: 16 },
  })
  assert.equal(out.type, 'message')
  assert.deepEqual(out.content, [{ type: 'text', text: '4' }])
  assert.equal(out.stop_reason, 'end_turn')
  assert.deepEqual(out.usage, { input_tokens: 68, output_tokens: 16 })
})

test('tool_calls become tool_use blocks and force stop_reason tool_use', () => {
  const out = chatToMessages({
    choices: [
      {
        finish_reason: 'stop',
        message: {
          content: '',
          tool_calls: [{ id: 'harmony_0', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
        },
      },
    ],
  })
  assert.deepEqual(out.content, [{ type: 'tool_use', id: 'harmony_0', name: 'bash', input: { command: 'ls' } }])
  assert.equal(out.stop_reason, 'tool_use')
})

test('finish_reason length maps to max_tokens', () => {
  const out = chatToMessages({ choices: [{ finish_reason: 'length', message: { content: 'x' } }] })
  assert.equal(out.stop_reason, 'max_tokens')
})

test('token estimate is positive and roughly chars/4', () => {
  const n = estimateTokens({ messages: [{ role: 'user', content: 'a'.repeat(400) }] })
  assert.ok(n > 80 && n < 140, `estimate ${n} out of range`)
})

/** Build one OpenAI SSE frame the way mlx_lm.server does. */
function frame(delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-x',
    model: MODEL,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  })}\n\n`
}

/** Parse translator output back into [event, payload] pairs. */
function events(sse: string): [string, Record<string, unknown>][] {
  return sse
    .split('\n\n')
    .filter(Boolean)
    .map((f) => {
      const m = /^event: (\S+)\ndata: (.*)$/s.exec(f)
      assert.ok(m, `malformed frame: ${f}`)
      return [m![1], JSON.parse(m![2])]
    })
}

test('a text stream produces the full Anthropic event sequence', () => {
  const t = new AnthropicStreamTranslator()
  let out = t.push(frame({ role: 'assistant', content: 'Hel' }))
  out += t.push(frame({ content: 'lo' }))
  out += t.push(frame({}, 'stop', { usage: { prompt_tokens: 10, completion_tokens: 2 } }))
  out += t.push('data: [DONE]\n\n')
  out += t.flush()

  const seq = events(out)
  assert.deepEqual(
    seq.map(([e]) => e),
    ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'],
  )
  const start = seq[0][1] as { message: { model: string } }
  assert.equal(start.message.model, MODEL)
  const deltas = seq.filter(([e]) => e === 'content_block_delta').map(([, p]) => (p.delta as { text: string }).text)
  assert.equal(deltas.join(''), 'Hello')
  const md = seq.find(([e]) => e === 'message_delta')![1] as { delta: { stop_reason: string }; usage: { output_tokens: number } }
  assert.equal(md.delta.stop_reason, 'end_turn')
  assert.equal(md.usage.output_tokens, 2)
})

test('empty content deltas (harmony leftovers) open no block', () => {
  const t = new AnthropicStreamTranslator()
  let out = t.push(frame({ role: 'assistant', content: '' }))
  out += t.push(frame({ content: '' }, 'stop'))
  out += t.push('data: [DONE]\n\n')
  out += t.flush()
  assert.deepEqual(
    events(out).map(([e]) => e),
    ['message_start', 'message_delta', 'message_stop'],
  )
})

test('frames straddling chunk boundaries are reassembled', () => {
  const whole = frame({ content: 'abc' })
  const t = new AnthropicStreamTranslator()
  let out = t.push(whole.slice(0, 25))
  out += t.push(whole.slice(25))
  out += t.push('data: [DONE]\n\n')
  const deltas = events(out).filter(([e]) => e === 'content_block_delta')
  assert.equal(deltas.length, 1)
  assert.equal((deltas[0][1].delta as { text: string }).text, 'abc')
})

test('streamed tool calls open a tool_use block with input_json_delta', () => {
  const t = new AnthropicStreamTranslator()
  let out = t.push(frame({ content: 'Let me check.' }))
  out += t.push(frame({ tool_calls: [{ index: 0, id: 'call_9', function: { name: 'bash', arguments: '{"comm' } }] }))
  out += t.push(frame({ tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] }, 'tool_calls'))
  out += t.push('data: [DONE]\n\n')

  const seq = events(out)
  assert.deepEqual(
    seq.map(([e]) => e),
    [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ],
  )
  const toolStart = seq[4][1] as { index: number; content_block: { type: string; id: string; name: string } }
  assert.equal(toolStart.index, 1)
  assert.equal(toolStart.content_block.type, 'tool_use')
  assert.equal(toolStart.content_block.name, 'bash')
  const json = seq
    .filter(([e, p]) => e === 'content_block_delta' && (p.delta as { type: string }).type === 'input_json_delta')
    .map(([, p]) => (p.delta as { partial_json: string }).partial_json)
    .join('')
  assert.deepEqual(JSON.parse(json), { command: 'ls' })
  assert.equal((seq.at(-2)![1].delta as { stop_reason: string }).stop_reason, 'tool_use')
})

test('a stream that dies before [DONE] still ends well-formed', () => {
  const t = new AnthropicStreamTranslator()
  let out = t.push(frame({ content: 'partial' }))
  out += t.flush()
  const seq = events(out).map(([e]) => e)
  assert.equal(seq.at(-1), 'message_stop')
  assert.ok(seq.includes('content_block_stop'))
})
