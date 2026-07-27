/**
 * Translating the Anthropic Messages API into OpenAI chat completions.
 *
 * Claude Code (and every other Anthropic SDK client) speaks one protocol:
 * `POST /v1/messages`, with Anthropic's request shape, response shape, and
 * SSE event grammar. `mlx_lm.server` speaks only chat completions. Pointing
 * `ANTHROPIC_BASE_URL` at this proxy therefore 404'd — which Anthropic
 * clients report, misleadingly, as a problem with the *model*.
 *
 * This module is the payload-shaped half of the bridge, kept pure so the
 * awkward cases — tool_result ordering, streamed tool-call fragments, frames
 * straddling chunks — are testable without sockets. The proxy owns the
 * sockets and calls in here.
 *
 * What deliberately does not survive the round trip:
 * - `thinking`/`redacted_thinking` blocks in requests (local templates have
 *   no slot for them) and `reasoning_content` in responses — an Anthropic
 *   thinking block demands a signature we cannot forge, so reasoning is
 *   dropped rather than emitted malformed.
 * - Images: replaced with a marker so the message is not silently emptied;
 *   mlx-lm serves text-generation models only.
 */

/** OpenAI finish_reason → Anthropic stop_reason. */
function stopReason(finish: unknown, sawToolUse: boolean): string {
  if (sawToolUse || finish === 'tool_calls') return 'tool_use'
  if (finish === 'length') return 'max_tokens'
  return 'end_turn'
}

/** `system` may be a string or a list of text blocks; either way it's text. */
function systemText(system: unknown): string {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return system
    .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
    .join('\n')
}

/** Flatten a tool_result's content — string, or a list of blocks — to text. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => {
      const block = b as { type?: string; text?: string }
      if (block?.type === 'text') return block.text ?? ''
      if (block?.type === 'image') return '[image omitted: this server runs text-only models]'
      return ''
    })
    .join('\n')
}

function parseArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== 'string' || !args.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(args)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

interface ContentBlock {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
  source?: unknown
}

/**
 * An Anthropic Messages request as a chat-completions request.
 *
 * The interesting rule is tool results: Anthropic nests them as
 * `tool_result` blocks inside the *next user message*, OpenAI wants them as
 * standalone `role: "tool"` messages following the assistant's call. They
 * are emitted first, in order, before whatever user text shares the message.
 */
export function messagesToChat(body: Record<string, unknown>): Record<string, unknown> {
  const messages: Record<string, unknown>[] = []

  const sys = systemText(body.system)
  if (sys) messages.push({ role: 'system', content: sys })

  for (const raw of Array.isArray(body.messages) ? body.messages : []) {
    const m = raw as { role?: string; content?: unknown }
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content })
      continue
    }
    const blocks = (Array.isArray(m.content) ? m.content : []) as ContentBlock[]

    if (m.role === 'assistant') {
      let text = ''
      const toolCalls: Record<string, unknown>[] = []
      for (const b of blocks) {
        if (b.type === 'text') text += b.text ?? ''
        else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id ?? `tool_${toolCalls.length}`,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          })
        }
        // thinking / redacted_thinking: dropped, see module comment.
      }
      const msg: Record<string, unknown> = { role: 'assistant', content: text || null }
      if (toolCalls.length) msg.tool_calls = toolCalls
      messages.push(msg)
      continue
    }

    let text = ''
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        messages.push({
          role: 'tool',
          tool_call_id: b.tool_use_id,
          content: resultText(b.content) || (b.is_error ? 'Error' : ''),
        })
      } else if (b.type === 'text') text += b.text ?? ''
      else if (b.type === 'image') text += '[image omitted: this server runs text-only models]'
    }
    if (text) messages.push({ role: 'user', content: text })
  }

  const out: Record<string, unknown> = {
    model: body.model,
    messages,
    max_tokens: body.max_tokens,
    stream: body.stream === true,
  }
  if (body.temperature !== undefined) out.temperature = body.temperature
  if (body.top_p !== undefined) out.top_p = body.top_p
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((raw) => {
      const t = raw as { name?: string; description?: string; input_schema?: unknown }
      return {
        type: 'function',
        function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? {} },
      }
    })
  }
  const choice = body.tool_choice as { type?: string; name?: string } | undefined
  if (choice?.type === 'any') out.tool_choice = 'required'
  else if (choice?.type === 'tool') out.tool_choice = { type: 'function', function: { name: choice.name } }
  else if (choice?.type === 'none') out.tool_choice = 'none'
  else if (choice?.type === 'auto') out.tool_choice = 'auto'

  return out
}

/**
 * A (non-streaming, already harmony-filtered) chat completion as an
 * Anthropic message.
 */
export function chatToMessages(body: unknown): Record<string, unknown> {
  const obj = body as {
    id?: string
    model?: string
    choices?: { message?: { content?: unknown; tool_calls?: unknown[] }; finish_reason?: string }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const choice = obj?.choices?.[0]
  const msg = choice?.message ?? {}

  const content: Record<string, unknown>[] = []
  if (typeof msg.content === 'string' && msg.content) content.push({ type: 'text', text: msg.content })
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
  for (const [i, raw] of toolCalls.entries()) {
    const tc = raw as { id?: string; function?: { name?: string; arguments?: string } }
    content.push({
      type: 'tool_use',
      id: tc.id ?? `tool_${i}`,
      name: tc.function?.name ?? '',
      input: parseArgs(tc.function?.arguments),
    })
  }

  return {
    id: `msg_${obj?.id ?? 'local'}`,
    type: 'message',
    role: 'assistant',
    model: obj?.model ?? '',
    content,
    stop_reason: stopReason(choice?.finish_reason, toolCalls.length > 0),
    stop_sequence: null,
    usage: {
      input_tokens: obj?.usage?.prompt_tokens ?? 0,
      output_tokens: obj?.usage?.completion_tokens ?? 0,
    },
  }
}

/**
 * A rough token count for `/v1/messages/count_tokens`.
 *
 * `mlx_lm.server` has no tokenize route, so honesty is not on offer — but
 * Anthropic clients use this for context-window bookkeeping, where the
 * standard chars/4 heuristic is close enough to keep auto-compaction sane.
 */
export function estimateTokens(body: Record<string, unknown>): number {
  const text = JSON.stringify([body.system ?? '', body.messages ?? [], body.tools ?? []])
  return Math.max(1, Math.round(text.length / 4))
}

function sse(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}

/**
 * A streaming chat completion as Anthropic SSE, chunk by chunk.
 *
 * Feed it the (already harmony-rewritten) OpenAI SSE text; it returns
 * Anthropic event frames. Anthropic's grammar is stateful — blocks open and
 * close, and the message has a start and an end — so this buffers partial
 * frames exactly like StreamRewriter and tracks which block is open.
 *
 * Token accounting: mlx_lm.server puts usage on its chunks; the last one
 * seen wins. If none arrives, content-bearing chunks are counted instead —
 * mlx streams roughly one token per chunk, and Claude Code only uses the
 * number for cost display and compaction timing.
 */
export class AnthropicStreamTranslator {
  private buffer = ''
  private started = false
  private finished = false
  private blockIndex = -1
  private open: 'text' | 'tool' | null = null
  private toolIndex: number | null = null
  private finish: string | undefined
  private sawToolUse = false
  private chunkTokens = 0
  private usage: { prompt_tokens?: number; completion_tokens?: number } | undefined
  private id = 'stream'
  private model = ''

  push(chunk: string): string {
    this.buffer += chunk
    let out = ''
    let cut: number
    while ((cut = this.buffer.indexOf('\n\n')) !== -1) {
      const frame = this.buffer.slice(0, cut)
      this.buffer = this.buffer.slice(cut + 2)
      out += this.frame(frame)
    }
    return out
  }

  /** End of upstream stream: whatever [DONE] would have produced. */
  flush(): string {
    const tail = this.buffer
    this.buffer = ''
    let out = tail ? this.frame(tail) : ''
    out += this.finalize()
    return out
  }

  private frame(frame: string): string {
    const match = /^data: (.*)$/ms.exec(frame.trim())
    if (!match) return '' // comments and blank keep-alives have no Anthropic form
    if (match[1].trim() === '[DONE]') return this.finalize()

    let payload: {
      id?: string
      model?: string
      usage?: { prompt_tokens?: number; completion_tokens?: number }
      choices?: {
        delta?: {
          content?: unknown
          tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
        }
        finish_reason?: string | null
      }[]
    }
    try {
      payload = JSON.parse(match[1])
    } catch {
      return ''
    }

    let out = ''
    if (!this.started) {
      this.started = true
      this.id = payload.id ?? this.id
      this.model = payload.model ?? this.model
      out += sse('message_start', {
        type: 'message_start',
        message: {
          id: `msg_${this.id}`,
          type: 'message',
          role: 'assistant',
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })
    }
    if (payload.usage) this.usage = payload.usage

    const choice = payload.choices?.[0]
    const delta = choice?.delta

    if (typeof delta?.content === 'string' && delta.content) {
      if (this.open !== 'text') {
        out += this.closeBlock()
        this.blockIndex += 1
        this.open = 'text'
        out += sse('content_block_start', {
          type: 'content_block_start',
          index: this.blockIndex,
          content_block: { type: 'text', text: '' },
        })
      }
      this.chunkTokens += 1
      out += sse('content_block_delta', {
        type: 'content_block_delta',
        index: this.blockIndex,
        delta: { type: 'text_delta', text: delta.content },
      })
    }

    for (const tc of delta?.tool_calls ?? []) {
      const index = tc.index ?? 0
      if (this.open !== 'tool' || this.toolIndex !== index) {
        out += this.closeBlock()
        this.blockIndex += 1
        this.open = 'tool'
        this.toolIndex = index
        this.sawToolUse = true
        out += sse('content_block_start', {
          type: 'content_block_start',
          index: this.blockIndex,
          content_block: {
            type: 'tool_use',
            id: tc.id ?? `tool_${index}`,
            name: tc.function?.name ?? '',
            input: {},
          },
        })
      }
      if (tc.function?.arguments) {
        this.chunkTokens += 1
        out += sse('content_block_delta', {
          type: 'content_block_delta',
          index: this.blockIndex,
          delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
        })
      }
    }

    if (choice?.finish_reason) this.finish = choice.finish_reason
    return out
  }

  private closeBlock(): string {
    if (this.open === null) return ''
    const index = this.blockIndex
    this.open = null
    this.toolIndex = null
    return sse('content_block_stop', { type: 'content_block_stop', index })
  }

  private finalize(): string {
    if (this.finished) return ''
    this.finished = true
    let out = ''
    // A stream that produced nothing still owes a well-formed message.
    if (!this.started) {
      this.started = true
      out += sse('message_start', {
        type: 'message_start',
        message: {
          id: `msg_${this.id}`,
          type: 'message',
          role: 'assistant',
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })
    }
    out += this.closeBlock()
    out += sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason(this.finish, this.sawToolUse), stop_sequence: null },
      usage: {
        input_tokens: this.usage?.prompt_tokens ?? 0,
        output_tokens: this.usage?.completion_tokens ?? this.chunkTokens,
      },
    })
    out += sse('message_stop', { type: 'message_stop' })
    return out
  }
}
