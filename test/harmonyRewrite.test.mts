/**
 * Turning harmony responses into ordinary OpenAI ones.
 *
 * The awkward part is streaming: control tokens straddle SSE frames, so the
 * filter has to persist across the whole response rather than run per frame.
 * These use payloads shaped like the ones mlx_lm.server actually returns.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StreamRewriter, rewriteCompletion, rewriteText } from '../src/services/harmonyRewrite.ts'

/** Captured from this machine: gpt-oss answering "2+2? answer with the number only". */
const REAL_HARMONY =
  '<|channel|>analysis<|message|>The user asks "2+2? answer with the number only". So answer "4".' +
  '<|end|><|start|>assistant<|channel|>final<|message|>4'

test('the answer is separated from the reasoning', () => {
  const { content, reasoning } = rewriteText(REAL_HARMONY)
  assert.equal(content, '4', 'only the final channel is the answer')
  assert.match(reasoning, /The user asks/)
  assert.equal(content.includes('<|'), false, 'no control tokens survive')
})

test('a non-harmony response is returned byte for byte', () => {
  const plain = 'Just an ordinary answer, with a <| that is not a token.'
  const { content, reasoning, toolCalls } = rewriteText(plain)
  assert.equal(content, plain)
  assert.equal(reasoning, '')
  assert.deepEqual(toolCalls, [])
})

test('a completion body keeps its shape, gaining reasoning_content', () => {
  const body = {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    model: 'gpt-oss',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: REAL_HARMONY } }],
    usage: { total_tokens: 42 },
  }
  const out = rewriteCompletion(body) as typeof body & {
    choices: { message: { reasoning_content?: string } }[]
  }

  assert.equal(out.choices[0].message.content, '4')
  assert.match(out.choices[0].message.reasoning_content ?? '', /The user asks/)
  // Everything a client might rely on has to survive untouched.
  assert.equal(out.id, 'chatcmpl-1')
  assert.deepEqual(out.usage, { total_tokens: 42 })
  assert.equal(out.choices[0].finish_reason, 'stop')
  assert.equal((out.choices[0].message as { role: string }).role, 'assistant')
})

test('bodies that are not completions pass through untouched', () => {
  const error = { error: { message: 'model not found', type: 'invalid_request_error' } }
  assert.deepEqual(rewriteCompletion(error), error)

  const models = { object: 'list', data: [{ id: 'a' }] }
  assert.deepEqual(rewriteCompletion(models), models)

  // A completion with no harmony in it must be returned as the same object,
  // not a rebuilt one that might drop an unknown field.
  const plain = { choices: [{ message: { content: 'hello', extra: 1 } }] }
  assert.deepEqual(rewriteCompletion(plain), plain)
})

/** Build the SSE frame mlx_lm.server emits for one delta. */
const frame = (content: string) =>
  `data: ${JSON.stringify({
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`

/** Pull the content out of rewritten SSE text. */
function contentOf(sse: string): string {
  return sse
    .split('\n\n')
    .map((f) => /^data: (.*)$/ms.exec(f.trim())?.[1])
    .filter((d): d is string => Boolean(d) && d !== '[DONE]')
    .map((d) => JSON.parse(d).choices?.[0]?.delta?.content ?? '')
    .join('')
}

test('control tokens split across frames are still removed', () => {
  const rewriter = new StreamRewriter()
  // The token is deliberately cut in half across two frames, which is what
  // makes per-frame filtering impossible.
  let out = ''
  out += rewriter.push(frame('<|chan'))
  out += rewriter.push(frame('nel|>analysis<|message|>thinking hard'))
  out += rewriter.push(frame('<|end|><|start|>assistant<|channel|>final<|message|>Hello'))
  out += rewriter.push(frame(', world'))
  out += rewriter.flush()

  assert.equal(contentOf(out), 'Hello, world')
  assert.equal(out.includes('<|channel|>'), false, 'no control tokens survive')

  // The reasoning is moved, not dropped: it travels as reasoning_content,
  // which clients that understand it render separately and others ignore.
  assert.equal(out.includes('"content":"thinking hard"'), false, 'not in the answer')
  assert.match(out, /"reasoning_content":"thinking hard"/)
})

test('the stream keeps its framing, including [DONE]', () => {
  const rewriter = new StreamRewriter()
  const out = rewriter.push(frame('hi') + 'data: [DONE]\n\n') + rewriter.flush()

  assert.ok(out.endsWith('data: [DONE]\n\n'), 'the terminator survives verbatim')
  assert.equal(contentOf(out), 'hi')
})

test('a frame arriving in pieces is held until it is complete', () => {
  const rewriter = new StreamRewriter()
  const whole = frame('partial')
  const first = rewriter.push(whole.slice(0, 20))
  assert.equal(first, '', 'nothing is emitted from half a frame')

  const rest = rewriter.push(whole.slice(20)) + rewriter.flush()
  assert.equal(contentOf(rest), 'partial')
})

test('non-data lines and unparseable frames are passed along', () => {
  const rewriter = new StreamRewriter()
  const out = rewriter.push(': keep-alive comment\n\n' + 'data: {not json}\n\n') + rewriter.flush()
  assert.match(out, /: keep-alive comment/)
  assert.match(out, /data: \{not json\}/)
})

// ---- upstream failures -----------------------------------------------------

test('a refused connection says the server is not running', async () => {
  const { describeUpstreamFailure } = await import('../src/services/harmonyProxy.ts')

  // Node reports every transport failure as `TypeError: fetch failed` and puts
  // the errno on `cause`, so the surface message names the proxy for a fault
  // that is nothing to do with it.
  const refused = Object.assign(new TypeError('fetch failed'), {
    cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:8080' },
  })
  const message = describeUpstreamFailure(refused, 'http://127.0.0.1:8080')
  assert.match(message, /not running/)
  assert.match(message, /mlx-console start/)
  assert.equal(message.includes('fetch failed'), false, 'the useless wording is gone')

  const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
  assert.match(describeUpstreamFailure(reset, 'http://x'), /closed the connection/)

  // An unrecognised failure still names the upstream and says something.
  const odd = Object.assign(new TypeError('fetch failed'), { cause: { code: 'EHOSTDOWN' } })
  assert.match(describeUpstreamFailure(odd, 'http://x'), /Could not reach http:\/\/x: EHOSTDOWN/)

  assert.match(describeUpstreamFailure(new Error('plain'), 'http://x'), /plain/)
})
