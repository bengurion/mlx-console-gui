/**
 * Turning a harmony response into an ordinary OpenAI one.
 *
 * `mlx_lm.server` returns whatever the model generated, and gpt-oss generates
 * harmony: channel-tagged blocks carrying the model's private reasoning, its
 * tool calls, and the actual answer, all as raw text in `content`. This
 * extension's own chat view filters that (see chat/harmony.ts). Every other
 * client — VS Code's chat, Continue, Cline, curl — shows the control tokens
 * and the reasoning verbatim, which reads as a broken model.
 *
 * The same filter can be applied in front of the server so every client
 * benefits. This module is the payload-shaped half: what to do with a chat
 * completion body, streaming or not. It is pure, so the awkward cases are
 * testable without sockets.
 *
 * Reasoning is not discarded but moved to `reasoning_content`, the field
 * DeepSeek-style APIs use and several clients already render separately. A
 * client that ignores it simply sees a clean answer.
 */
import { HarmonyFilter, type HarmonyEvent } from '../chat/harmony.ts'

export interface RewrittenChoice {
  content: string
  reasoning: string
  toolCalls: { name: string; args: string }[]
}

function collect(events: HarmonyEvent[], into: RewrittenChoice): void {
  for (const e of events) {
    if (e.type === 'content') into.content += e.text
    else if (e.type === 'reasoning') into.reasoning += e.text
    else into.toolCalls.push({ name: e.name, args: e.args })
  }
}

/** Run one complete message through the filter. */
export function rewriteText(text: string): RewrittenChoice {
  const out: RewrittenChoice = { content: '', reasoning: '', toolCalls: [] }
  const filter = new HarmonyFilter()
  collect(filter.push(text), out)
  collect(filter.flush(), out)
  return out
}

/**
 * Rewrite a non-streaming `/v1/chat/completions` body.
 *
 * Anything that is not a recognisable completion — an error object, a body
 * from some other route — is returned untouched rather than mangled.
 */
export function rewriteCompletion(body: unknown): unknown {
  const obj = body as { choices?: unknown }
  if (!obj || !Array.isArray(obj.choices)) return body

  const choices = obj.choices.map((raw) => {
    const choice = raw as {
      message?: { content?: unknown; tool_calls?: unknown[] }
      [k: string]: unknown
    }
    const content = choice.message?.content
    if (typeof content !== 'string') return choice

    const { content: clean, reasoning, toolCalls } = rewriteText(content)
    // No harmony in it: leave the payload exactly as it arrived.
    if (clean === content && !reasoning && !toolCalls.length) return choice

    const message: Record<string, unknown> = { ...choice.message, content: clean }
    if (reasoning) message.reasoning_content = reasoning
    if (toolCalls.length) {
      message.tool_calls = [
        ...((choice.message?.tool_calls as unknown[]) ?? []),
        ...toolCalls.map((c, i) => ({
          id: `harmony_${i}`,
          type: 'function',
          function: { name: c.name, arguments: c.args },
        })),
      ]
    }
    return { ...choice, message }
  })

  return { ...obj, choices }
}

/**
 * Rewrite a streaming response, chunk by chunk.
 *
 * Harmony control tokens straddle SSE frames — a `<|chan` can end one delta
 * and `nel|>` begin the next — so the filter has to persist across the whole
 * stream rather than being applied per frame. That is exactly what
 * HarmonyFilter's buffering is for.
 */
export class StreamRewriter {
  private readonly filter = new HarmonyFilter()
  private buffer = ''

  /**
   * Feed raw SSE bytes; get back rewritten SSE bytes.
   *
   * Frames are only emitted once complete, so a partially received frame is
   * held rather than forwarded and corrected later.
   */
  push(chunk: string): string {
    this.buffer += chunk
    let out = ''
    let cut: number
    while ((cut = this.buffer.indexOf('\n\n')) !== -1) {
      const frame = this.buffer.slice(0, cut)
      this.buffer = this.buffer.slice(cut + 2)
      out += this.frame(frame) + '\n\n'
    }
    return out
  }

  /** Anything still buffered at end of stream, plus the filter's tail. */
  flush(): string {
    const tail = this.buffer
    this.buffer = ''
    const remaining = this.filter.flush()
    let out = tail ? this.frame(tail) + '\n\n' : ''
    const text = remaining
      .filter((e) => e.type === 'content')
      .map((e) => (e as { text: string }).text)
      .join('')
    if (text) out += `data: ${JSON.stringify(deltaChunk(text))}\n\n`
    return out
  }

  private frame(frame: string): string {
    const match = /^data: (.*)$/ms.exec(frame.trim())
    // Comments, blank frames and `data: [DONE]` pass through as they are.
    if (!match || match[1].trim() === '[DONE]') return frame

    let payload: { choices?: { delta?: { content?: unknown } }[] }
    try {
      payload = JSON.parse(match[1])
    } catch {
      return frame
    }
    const delta = payload.choices?.[0]?.delta
    if (!delta || typeof delta.content !== 'string') return frame

    const events = this.filter.push(delta.content)
    const content = events
      .filter((e) => e.type === 'content')
      .map((e) => (e as { text: string }).text)
      .join('')
    const reasoning = events
      .filter((e) => e.type === 'reasoning')
      .map((e) => (e as { text: string }).text)
      .join('')

    // A delta that was entirely control tokens or reasoning produces no
    // content. Emitting `content: ""` is harmless and keeps the stream's
    // shape — chunk counts and finish reasons — intact.
    const next = {
      ...payload,
      choices: payload.choices!.map((c, i) =>
        i === 0
          ? {
              ...c,
              delta: {
                ...delta,
                content,
                ...(reasoning ? { reasoning_content: reasoning } : {}),
              },
            }
          : c,
      ),
    }
    return `data: ${JSON.stringify(next)}`
  }
}

/** A minimal delta chunk, for content recovered at end of stream. */
function deltaChunk(content: string) {
  return {
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  }
}
