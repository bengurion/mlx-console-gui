/**
 * Minimal OpenAI-compatible client for a running `mlx_lm.server`.
 * Supports non-streaming and streaming (SSE) chat completions, including
 * function/tool calling, plus the /v1/models listing.
 */

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ToolDef {
  type: 'function'
  function: { name: string; description?: string; parameters?: unknown }
}

export interface ChatParams {
  model: string
  messages: ChatMessage[]
  temperature?: number
  top_p?: number
  top_k?: number
  min_p?: number
  repetition_penalty?: number
  max_tokens?: number
  stop?: string[]
  tools?: ToolDef[]
  tool_choice?: 'auto' | 'none' | 'required'
}

/** Events emitted while streaming a chat completion. */
export type ChatEvent =
  | { type: 'content'; text: string }
  | { type: 'toolCallDelta'; index: number; id?: string; name?: string; argsDelta?: string }
  | { type: 'done'; finishReason: string | null }

export interface ChatResult {
  content: string
  toolCalls: ToolCall[]
  finishReason: string | null
}

export interface MlxClientOptions {
  /** Resolver for the base URL including the `/v1` suffix. Read fresh each call. */
  baseUrl: () => string
  /** Optional bearer token resolver. */
  apiKey?: () => string
}

export class MlxClientError extends Error {
  readonly status?: number
  readonly body?: string
  constructor(message: string, status?: number, body?: string) {
    super(message)
    this.name = 'MlxClientError'
    this.status = status
    this.body = body
  }
}

export class MlxClient {
  private readonly opts: MlxClientOptions
  constructor(opts: MlxClientOptions) {
    this.opts = opts
  }

  private url(path: string): string {
    return this.opts.baseUrl().replace(/\/$/, '') + path
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    const key = this.opts.apiKey?.()
    if (key) h['Authorization'] = `Bearer ${key}`
    return h
  }

  /** GET /v1/models — returns the model ids the server currently knows about. */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await fetch(this.url('/models'), { headers: this.headers(), signal })
    if (!res.ok) {
      throw new MlxClientError(`listModels failed (${res.status})`, res.status, await safeText(res))
    }
    const json = (await res.json()) as { data?: Array<{ id: string }> }
    return (json.data ?? []).map((m) => m.id)
  }

  /** Lightweight readiness probe. */
  async ping(signal?: AbortSignal): Promise<boolean> {
    try {
      const res = await fetch(this.url('/models'), { headers: this.headers(), signal })
      return res.ok
    } catch {
      return false
    }
  }

  /** Non-streaming chat completion. */
  async chat(params: ChatParams, signal?: AbortSignal): Promise<ChatResult> {
    const res = await fetch(this.url('/chat/completions'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ ...params, stream: false }),
      signal,
    })
    if (!res.ok) {
      throw new MlxClientError(
        explainChatFailure('chat', res.status, params),
        res.status,
        await safeText(res),
      )
    }
    const json = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string; tool_calls?: ToolCall[] }
        finish_reason?: string | null
      }>
    }
    const choice = json.choices?.[0]
    return {
      content: choice?.message?.content ?? '',
      toolCalls: choice?.message?.tool_calls ?? [],
      finishReason: choice?.finish_reason ?? null,
    }
  }

  /** Streaming chat completion. Yields content/tool-call deltas as they arrive. */
  async *streamChat(params: ChatParams, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
    const res = await fetch(this.url('/chat/completions'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ ...params, stream: true }),
      signal,
    })
    if (!res.ok || !res.body) {
      throw new MlxClientError(
        explainChatFailure('streamChat', res.status, params),
        res.status,
        await safeText(res),
      )
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let finishReason: string | null = null

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let nl: number
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') {
            yield { type: 'done', finishReason }
            return
          }
          let chunk: StreamChunk
          try {
            chunk = JSON.parse(data) as StreamChunk
          } catch {
            continue
          }
          const choice = chunk.choices?.[0]
          if (!choice) continue
          if (choice.finish_reason) finishReason = choice.finish_reason
          const delta = choice.delta
          if (delta?.content) {
            yield { type: 'content', text: delta.content }
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              yield {
                type: 'toolCallDelta',
                index: tc.index ?? 0,
                id: tc.id,
                name: tc.function?.name,
                argsDelta: tc.function?.arguments,
              }
            }
          }
        }
      }
      yield { type: 'done', finishReason }
    } finally {
      reader.releaseLock()
    }
  }
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
}

/** Assemble streamed toolCallDelta events into complete ToolCall objects. */
export function assembleToolCalls(events: ChatEvent[]): ToolCall[] {
  const byIndex = new Map<number, ToolCall>()
  for (const ev of events) {
    if (ev.type !== 'toolCallDelta') continue
    const existing = byIndex.get(ev.index) ?? {
      id: ev.id ?? `call_${ev.index}`,
      type: 'function' as const,
      function: { name: '', arguments: '' },
    }
    if (ev.id) existing.id = ev.id
    if (ev.name) existing.function.name = ev.name
    if (ev.argsDelta) existing.function.arguments += ev.argsDelta
    byIndex.set(ev.index, existing)
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
}

/**
 * mlx_lm.server answers several unrelated problems with a bare 404: an unknown
 * `model` (it falls through to a Hugging Face lookup that misses) and an empty
 * `messages` array both land there. Say which one it looks like.
 */
export function explainChatFailure(op: string, status: number, params: ChatParams): string {
  if (status !== 404) return `${op} failed (${status})`
  if (!params.messages?.length) {
    return `${op} failed (404): the request had no messages — nothing was sent to the model.`
  }
  return (
    `${op} failed (404): the server does not have "${params.model}" loaded. ` +
    'Check the model id against GET /v1/models, or pick a downloaded model.'
  )
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
