/**
 * Streaming filter for OpenAI "harmony" response format, which gpt-oss models
 * emit as raw text when the server does not parse it for us.
 *
 * A harmony response is a sequence of channel-tagged blocks:
 *
 *   <|start|>assistant<|channel|>analysis<|message|>reasoning…<|end|>
 *   <|start|>assistant<|channel|>final<|message|>the answer<|return|>
 *
 * and tool calls arrive on the commentary channel with a recipient header:
 *
 *   <|start|>assistant<|channel|>commentary to=functions.foo <|constrain|>json<|message|>{…}<|call|>
 *
 * Without this filter the control tokens and the model's private reasoning are
 * rendered verbatim in the chat view. Text that contains no harmony tokens at
 * all passes through untouched, so non-gpt-oss models are unaffected.
 */

export type HarmonyEvent =
  | { type: 'content'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'toolCall'; name: string; args: string }

/** Control tokens we recognise. Longest first so matching is unambiguous. */
const TOKENS = [
  '<|constrain|>',
  '<|channel|>',
  '<|message|>',
  '<|return|>',
  '<|start|>',
  '<|call|>',
  '<|end|>',
] as const

const MAX_TOKEN_LEN = Math.max(...TOKENS.map((t) => t.length))

/** Does `s` end with something that could still grow into a control token? */
function partialTokenTail(s: string): number {
  const start = Math.max(0, s.length - MAX_TOKEN_LEN + 1)
  for (let i = start; i < s.length; i++) {
    if (s[i] !== '<') continue
    const tail = s.slice(i)
    if (TOKENS.some((t) => t.startsWith(tail))) return s.length - i
  }
  return 0
}

/** `commentary to=functions.get_weather` -> `get_weather` */
function recipientOf(header: string): string | undefined {
  const m = header.match(/to\s*=\s*(?:functions?\.)?([A-Za-z0-9_.-]+)/)
  return m ? m[1] : undefined
}

/** `analysis`, `final`, `commentary`… — the first word of the channel header. */
function channelOf(header: string): string {
  return (header.trim().split(/\s+/)[0] ?? '').toLowerCase()
}

/**
 * Incremental harmony parser. Feed it raw deltas; it yields cleaned events.
 * Text arriving before any `<|channel|>` is treated as final content, so plain
 * OpenAI-style streams work unchanged.
 */
export class HarmonyFilter {
  private buffer = ''
  /** Set while we are between `<|channel|>` and `<|message|>`. */
  private header: string | undefined
  private channel = 'final'
  private recipient: string | undefined
  /** Accumulates a tool call's arguments across deltas. */
  private toolArgs = ''
  private sawHarmony = false

  push(chunk: string): HarmonyEvent[] {
    this.buffer += chunk
    return this.drain(false)
  }

  /** Flush whatever remains at end of stream. */
  flush(): HarmonyEvent[] {
    return this.drain(true)
  }

  /** True once a harmony control token has been seen — useful for diagnostics. */
  get isHarmony(): boolean {
    return this.sawHarmony
  }

  private drain(final: boolean): HarmonyEvent[] {
    const out: HarmonyEvent[] = []

    for (;;) {
      const hit = this.nextToken()
      if (!hit) break
      this.sawHarmony = true
      this.emitText(this.buffer.slice(0, hit.index), out)
      this.buffer = this.buffer.slice(hit.index + hit.token.length)
      this.onToken(hit.token, out)
    }

    // No complete token left. Emit the safe prefix, holding back anything that
    // could still turn into a control token when the next delta arrives.
    const hold = final ? 0 : partialTokenTail(this.buffer)
    if (this.buffer.length > hold) {
      this.emitText(this.buffer.slice(0, this.buffer.length - hold), out)
      this.buffer = this.buffer.slice(this.buffer.length - hold)
    }

    if (final && this.recipient && this.toolArgs.trim()) {
      out.push({ type: 'toolCall', name: this.recipient, args: this.toolArgs })
      this.recipient = undefined
      this.toolArgs = ''
    }
    return out
  }

  private nextToken(): { index: number; token: string } | undefined {
    let best: { index: number; token: string } | undefined
    for (const token of TOKENS) {
      const index = this.buffer.indexOf(token)
      if (index === -1) continue
      // Earliest match wins; on a tie the longer token wins (TOKENS is sorted).
      if (!best || index < best.index) best = { index, token }
    }
    return best
  }

  /** Route accumulated text according to the channel we are currently in. */
  private emitText(text: string, out: HarmonyEvent[]) {
    if (!text) return
    if (this.header !== undefined) {
      this.header += text
      return
    }
    if (this.recipient) {
      this.toolArgs += text
      return
    }
    if (this.channel === 'analysis') out.push({ type: 'reasoning', text })
    else if (this.channel === 'commentary') out.push({ type: 'reasoning', text })
    else out.push({ type: 'content', text })
  }

  private onToken(token: string, out: HarmonyEvent[]) {
    switch (token) {
      case '<|channel|>':
        this.header = ''
        break
      case '<|message|>': {
        const header = this.header ?? ''
        this.header = undefined
        this.channel = channelOf(header) || this.channel
        this.recipient = this.channel === 'commentary' ? recipientOf(header) : undefined
        this.toolArgs = ''
        break
      }
      case '<|call|>':
      case '<|end|>':
      case '<|return|>':
        if (this.recipient) {
          out.push({ type: 'toolCall', name: this.recipient, args: this.toolArgs })
          this.recipient = undefined
          this.toolArgs = ''
        }
        // `<|start|>` of the next block re-establishes the channel; until then
        // assume final so stray text is shown rather than silently dropped.
        this.channel = 'final'
        this.header = undefined
        break
      case '<|start|>':
        // Role header (`assistant`, `functions.foo to=…`) runs until <|channel|>
        // or <|message|>; swallow it by treating it as a header.
        this.header = ''
        break
      case '<|constrain|>':
        // Type hint inside a channel header (e.g. `json`); stays part of header.
        break
    }
  }
}

/** One-shot convenience wrapper for non-streaming responses. */
export function parseHarmony(text: string): HarmonyEvent[] {
  const f = new HarmonyFilter()
  return [...f.push(text), ...f.flush()]
}

/** Just the user-visible answer, with reasoning and control tokens removed. */
export function stripHarmony(text: string): string {
  return parseHarmony(text)
    .filter((e) => e.type === 'content')
    .map((e) => (e as { text: string }).text)
    .join('')
}
