import * as vscode from 'vscode'
import { log } from '../core/logging'
import { Config } from '../config'
import type { ServerManager } from '../backend/serverManager'
import { assembleToolCalls, type ChatEvent, type ChatMessage, type ToolDef } from '../backend/mlxClient'
import { toRequestFields } from '../services/sampling'
import { HarmonyFilter } from './harmony'
import {
  availableFor,
  clampContextToHeadroom,
  defaultMaxOutputTokens,
  effectiveContextWindow,
  preflightCheck,
} from '../services/modelConfig'
import { ModelConfigReader } from '../services/modelConfigReader'
import { MemoryObserver } from '../services/memoryObserver'
import type { MetricsService } from '../services/metricsService'

/**
 * Registers MLX models as a Language Model Chat Provider so they appear in the
 * native model picker (Chat, inline chat, agent mode).
 *
 * The provider API can be version-gated; we access it defensively and fall back
 * to the `@mlx` participant when it is unavailable. VSCode-side provider types
 * are loosely typed here to stay resilient across VSCode versions.
 */
export function registerLmChatProvider(
  server: ServerManager,
  metrics?: MetricsService,
  /** Every locally available model, so the picker is not limited to what a
   * running server happens to report. Embedded mode scans the cache; remote
   * mode asks the daemon. */
  localModels?: () => Promise<string[]>,
): vscode.Disposable | undefined {
  const lm = vscode.lm as unknown as {
    registerLanguageModelChatProvider?: (vendor: string, provider: object) => vscode.Disposable
  }
  if (typeof lm.registerLanguageModelChatProvider !== 'function') {
    log.warn(
      'LanguageModelChatProvider API unavailable — MLX models are reachable via @mlx and external clients only.',
    )
    return undefined
  }
  try {
    const disposable = lm.registerLanguageModelChatProvider(
      'mlx',
      new MlxLmChatProvider(server, metrics, localModels),
    )
    log.info('Registered MLX language model chat provider')
    return disposable
  } catch (err) {
    log.error('Failed to register LM chat provider', err)
    return undefined
  }
}

class MlxLmChatProvider {
  /** Reads each model's trained context length from its own config.json. */
  private readonly modelConfig = new ModelConfigReader()
  /** Learns transient prefill cost from real requests on this machine. */
  readonly memoryObserver = new MemoryObserver()

  constructor(
    private readonly server: ServerManager,
    private readonly metrics?: MetricsService,
    private readonly localModels?: () => Promise<string[]>,
  ) {}

  /** Latest GPU ceiling / in-use figures, when the metrics service is available. */
  private async memory(): Promise<{ ceiling?: number; inUse?: number; headroom?: number }> {
    if (!this.metrics) return {}
    try {
      const m = await this.metrics.sampleOnce()
      const ceiling = m.wiredLimitBytes ?? m.gpu.maxRecommendedWorkingSetBytes
      // Not gpu.inUseBytes: it drops to near zero when a resident model idles.
      const inUse = m.occupiedBytes ?? m.gpu.inUseBytes
      return {
        ceiling,
        inUse,
        headroom: ceiling ? Math.max(0, ceiling - (inUse ?? 0)) : undefined,
      }
    } catch {
      return {}
    }
  }

  /**
   * Sample GPU memory for the duration of a request and record the peak.
   *
   * Returns handles rather than blocking: the caller finishes the watch when
   * the stream ends, or cancels it on error so a failed request contributes no
   * observation.
   */
  private watchMemory(modelId: string, promptTokens: number) {
    let cancelled = false
    let baseline: number | undefined
    let peak = 0

    const tick = async () => {
      const now = await this.metrics?.gpuInUseBytes()
      if (now === undefined) return
      baseline ??= now
      peak = Math.max(peak, now)
    }
    void tick()
    const timer = setInterval(() => void tick(), 1000)

    const stop = () => {
      clearInterval(timer)
    }
    return {
      cancel() {
        cancelled = true
        stop()
      },
      finish: async () => {
        stop()
        if (cancelled || baseline === undefined || !this.metrics) return
        this.memoryObserver.record(modelId, {
          promptTokens,
          baselineBytes: baseline,
          peakBytes: peak,
          kvBytesPerToken: this.modelConfig.kvBytesPerToken(modelId),
        })
        const est = this.memoryObserver.estimate(modelId)
        if (est.usable) {
          log.info(
            `Transient memory for ${shortName(modelId)}: ` +
              `${Math.round(est.bytesPerToken! / 1024)} KiB/token (${est.samples} samples)`,
          )
        }
      },
    }
  }

  /** Advertise the models available in the picker. */
  async provideLanguageModelChatInformation(
    _options: unknown,
    _token: vscode.CancellationToken,
  ): Promise<unknown[]> {
    const ids = new Set<string>()
    const def = Config.defaultModel()
    if (def) ids.add(def)
    if (this.server.activeModel) ids.add(this.server.activeModel)
    try {
      if (this.server.state === 'ready') {
        for (const id of await this.server.client.listModels()) ids.add(id)
      }
    } catch (err) {
      log.warn('listModels for provider info failed', err)
    }
    // The download cache, not just what a running server reports — otherwise
    // a stopped server empties the picker of models that are sitting on disk.
    try {
      for (const id of (await this.localModels?.()) ?? []) ids.add(id)
    } catch (err) {
      log.warn('local model scan for provider info failed', err)
    }
    const mem = await this.memory()
    return [...ids].map((id) => this.toInfo(id, this.headroomFor(id, mem)))
  }

  /**
   * Headroom available to a specific model's KV cache.
   *
   * For the resident model its weights are already counted in `inUse`. For any
   * other model, the resident one will be dropped when it loads, so the right
   * budget is the ceiling minus *its own* weights — not the current occupancy.
   */
  private headroomFor(
    id: string,
    mem: { ceiling?: number; inUse?: number; headroom?: number },
  ): number | undefined {
    if (!mem.ceiling) return undefined
    const resident =
      this.server.modelState === 'loaded' && this.server.loadedModel === id
    if (resident) return mem.headroom

    const weights = this.modelConfig.weightBytes(id)
    if (weights === undefined) return mem.headroom

    // Same rule as the pre-flight check: reclaim our own resident weights, but
    // leave memory held by other processes out of the budget.
    const residentId = this.server.loadedModel
    const available = availableFor(
      mem.ceiling,
      mem.inUse ?? 0,
      (residentId ? this.modelConfig.weightBytes(residentId) : 0) ?? 0,
    )
    return Math.max(0, available - weights)
  }

  private toInfo(id: string, headroomBytes?: number): unknown {
    // Prefer the model's own trained window; an explicit user setting still wins.
    const { value, source } = effectiveContextWindow({
      userConfigured: Config.contextWindowOverride(),
      fromModel: this.modelConfig.contextLength(id),
      fallback: Config.contextWindow(),
    })

    // A trained window is a capability claim, not a memory guarantee: advertise
    // only what the KV cache can actually fit. An explicit user setting is
    // respected as-is — they asked for that number.
    const perToken = this.modelConfig.kvBytesPerToken(id)
    const { window, clamped } =
      source === 'user'
        ? { window: value, clamped: false }
        : clampContextToHeadroom({ modelWindow: value, headroomBytes, kvBytesPerToken: perToken })

    log.info(
      `${shortName(id)}: context window ${window} (${source}` +
        `${clamped ? `, clamped from ${value} to fit memory` : ''})`,
    )
    return {
      id,
      name: shortName(id),
      family: 'mlx',
      version: '1.0.0',
      maxInputTokens: window,
      maxOutputTokens:
        Config.maxOutputTokensOverride() ??
        this.modelConfig.generationDefaults(id).maxTokens ??
        defaultMaxOutputTokens(window),
      capabilities: { toolCalling: true, imageInput: false },
    }
  }

  /** Stream a response for the selected model. */
  async provideLanguageModelChatResponse(
    model: { id: string },
    messages: unknown[],
    options: { tools?: unknown[] } | undefined,
    progress: vscode.Progress<unknown>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (!(await this.server.ensureRunning(false))) {
      progress.report(
        new vscode.LanguageModelTextPart('MLX server is not running. Run “MLX: Start Server”.'),
      )
      return
    }
    // Pre-flight: refuse a load that provably cannot fit, warn when it is tight.
    // Skipped when the model is already resident — that memory is already spent.
    const resident =
      this.server.modelState === 'loaded' && this.server.loadedModel === model.id
    if (!resident) {
      const mem = await this.memory()
      const residentId = this.server.loadedModel
      const check = preflightCheck({
        weightBytes: this.modelConfig.weightBytes(model.id),
        ceilingBytes: mem.ceiling,
        gpuInUseBytes: mem.inUse,
        // Our resident model is dropped on load; other apps' memory is not.
        residentWeightBytes: residentId ? this.modelConfig.weightBytes(residentId) : undefined,
        alreadyResident: resident,
      })
      if (check.verdict !== 'ok') log.warn(`Pre-flight (${check.verdict}): ${check.message}`)
      if (check.verdict === 'will-not-fit') {
        progress.report(new vscode.LanguageModelTextPart(`**Not enough memory.** ${check.message}`))
        return
      }
      if (check.verdict === 'tight') {
        progress.report(new vscode.LanguageModelTextPart(`_${check.message}_\n\n`))
      }
    }

    // Marks the model as loading when it differs from what is resident; the
    // server swaps weights inside the first request, which can take minutes.
    this.server.beginModelUse(model.id)

    const oaiMessages = convertMessages(messages)
    if (oaiMessages.length === 0) {
      // mlx_lm.server answers an empty `messages` array with a bare 404, which
      // reads like a missing endpoint. Fail here with something actionable.
      log.warn('No convertible content in request — not sending an empty messages array')
      progress.report(
        new vscode.LanguageModelTextPart(
          'Nothing to send — the attached content could not be read as text.',
        ),
      )
      return
    }
    const tools = convertTools(options?.tools)
    // Per-model overrides win over the global generation defaults.
    // Precedence: user settings and per-model overrides win, then whatever the
    // model itself recommends in generation_config.json, then our defaults.
    const sampling = toRequestFields(
      Config.samplingFor(model.id, this.modelConfig.generationDefaults(model.id)),
    )
    const signal = toAbortSignal(token)
    // Watch GPU memory across this request so transient prefill cost can be
    // measured rather than guessed. Sampling is one ioreg call per tick.
    const watch = this.watchMemory(model.id, approxTokens(oaiMessages))
    const toolEvents: ChatEvent[] = []
    // gpt-oss models emit raw harmony channel markup; route it instead of
    // rendering `<|channel|>analysis…` into the chat view.
    const harmony = new HarmonyFilter()
    const textToolCalls: Array<{ name: string; args: string }> = []

    const emit = (events: ReturnType<HarmonyFilter['push']>) => {
      for (const h of events) {
        if (h.type === 'content') progress.report(new vscode.LanguageModelTextPart(h.text))
        else if (h.type === 'reasoning') reportThinking(progress, h.text)
        else textToolCalls.push({ name: h.name, args: h.args })
      }
    }

    try {
      for await (const ev of this.server.client.streamChat(
        {
          model: model.id,
          messages: oaiMessages,
          tools,
          ...sampling,
        },
        signal,
      )) {
        if (token.isCancellationRequested) break
        // Any event proves the server finished loading and started generating.
        this.server.confirmModelLoaded(model.id)
        if (ev.type === 'content') {
          emit(harmony.push(ev.text))
        } else if (ev.type === 'toolCallDelta') {
          toolEvents.push(ev)
        }
      }
      emit(harmony.flush())
      await watch.finish()

      // Tool calls the model wrote as harmony commentary text rather than as
      // structured `tool_calls` deltas.
      for (const [i, call] of textToolCalls.entries()) {
        let input: object = {}
        try {
          input = call.args.trim() ? JSON.parse(call.args) : {}
        } catch {
          log.warn(`Discarding harmony tool call ${call.name}: arguments were not valid JSON`)
          continue
        }
        progress.report(new vscode.LanguageModelToolCallPart(`harmony_${i}`, call.name, input))
      }

      for (const call of assembleToolCalls(toolEvents)) {
        let input: object = {}
        try {
          input = call.function.arguments ? JSON.parse(call.function.arguments) : {}
        } catch {
          input = {}
        }
        progress.report(new vscode.LanguageModelToolCallPart(call.id, call.function.name, input))
      }
    } catch (err) {
      watch.cancel()
      this.server.abortModelLoad()
      log.error('provideLanguageModelChatResponse failed', err)
      progress.report(new vscode.LanguageModelTextPart(`\n\n_MLX error: ${String(err)}_`))
    }
  }

  async provideTokenCount(
    _model: unknown,
    text: string | unknown,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    const s = typeof text === 'string' ? text : extractText(text)
    return Math.max(1, Math.ceil(s.length / 4))
  }
}

// ---- conversion helpers (duck-typed for cross-version resilience) ----

/** Rough prompt size. Exact token counts need the tokenizer; ~4 chars/token is
 * close enough to regress transient memory against. */
function approxTokens(messages: ChatMessage[]): number {
  let chars = 0
  for (const m of messages) chars += (m.content ?? '').length
  return Math.max(1, Math.ceil(chars / 4))
}

function shortName(id: string): string {
  const parts = id.split('/')
  return parts[parts.length - 1]
}

function roleOf(role: unknown): 'user' | 'assistant' {
  // LanguageModelChatMessageRole: User = 1, Assistant = 2
  return role === 2 ? 'assistant' : 'user'
}

/** Mime types we can usefully inline as text when a file is attached. */
function isTextualMime(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    /^application\/(json|xml|yaml|x-yaml|javascript|typescript|toml|sql|x-sh)$/.test(mime) ||
    mime.endsWith('+json') ||
    mime.endsWith('+xml')
  )
}

/**
 * Text of a single message part.
 *
 * Attachments arrive as `LanguageModelDataPart` (binary `.data` + `.mimeType`)
 * rather than `.value`. Returning '' for those made attachment-only turns
 * collapse to an empty `messages` array, which mlx_lm.server answers with 404.
 */
function partText(p: unknown): string {
  if (typeof p === 'string') return p
  const o = p as { value?: unknown; data?: unknown; mimeType?: unknown }
  if (typeof o?.value === 'string') return o.value

  const data = o?.data
  if (data instanceof Uint8Array) {
    const mime = typeof o.mimeType === 'string' ? o.mimeType : 'text/plain'
    if (!isTextualMime(mime)) return `[attachment: ${mime}, ${data.byteLength} bytes — not text]`
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(data)
    } catch {
      return ''
    }
  }
  return ''
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(partText).join('')
  return partText(content)
}

function isToolCallPart(p: unknown): p is { callId: string; name: string; input: unknown } {
  const o = p as { callId?: unknown; name?: unknown }
  return typeof o?.callId === 'string' && typeof o?.name === 'string'
}

function isToolResultPart(p: unknown): p is { callId: string; content: unknown } {
  const o = p as { callId?: unknown; content?: unknown }
  return typeof o?.callId === 'string' && o?.content !== undefined && (o as { name?: unknown }).name === undefined
}

function convertMessages(messages: unknown[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const raw of messages) {
    const m = raw as { role?: unknown; content?: unknown }
    const role = roleOf(m.role)
    const parts = Array.isArray(m.content) ? m.content : [m.content]
    let text = ''
    const toolCalls: NonNullable<ChatMessage['tool_calls']> = []

    for (const p of parts) {
      if (isToolResultPart(p)) {
        out.push({ role: 'tool', tool_call_id: p.callId, content: extractText(p.content) })
      } else if (isToolCallPart(p)) {
        toolCalls.push({
          id: p.callId,
          type: 'function',
          function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) },
        })
      } else {
        text += partText(p)
      }
    }

    if (text || toolCalls.length) {
      const msg: ChatMessage = { role, content: text || null }
      if (toolCalls.length) msg.tool_calls = toolCalls
      out.push(msg)
    }
  }
  return out
}

function convertTools(tools: unknown[] | undefined): ToolDef[] | undefined {
  if (!tools || tools.length === 0) {
    log.info('Request carried no tools (plain chat, or agent mode is off)')
    return undefined
  }
  const defs: ToolDef[] = tools.map((t) => {
    const tool = t as { name: string; description?: string; inputSchema?: unknown }
    return {
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    }
  })

  // Tool schemas are prompt tokens like anything else. A full native + MCP set
  // can be tens of thousands of tokens, which silently crowds out the actual
  // conversation, so make the cost visible rather than mysterious.
  const approxTokens = Math.ceil(JSON.stringify(defs).length / 4)
  const budget = Config.contextWindow()
  log.info(
    `Forwarding ${defs.length} tools (~${approxTokens} tokens): ${defs.map((d) => d.function.name).join(', ')}`,
  )
  if (approxTokens > budget * 0.5) {
    log.warn(
      `Tool definitions are ~${approxTokens} tokens against a ${budget}-token window — ` +
        'little room is left for the conversation. Raise mlxConsole.contextWindow, or ' +
        'disable some MCP servers / tool sets in the agent-mode tool picker.',
    )
  }
  return defs
}

/**
 * Surface model reasoning as a thinking part when the running VSCode supports
 * it. Older versions have no such part — there we drop it rather than printing
 * the model's private scratchpad into the answer.
 */
function reportThinking(progress: vscode.Progress<unknown>, text: string): void {
  const Thinking = (vscode as unknown as { LanguageModelThinkingPart?: new (t: string) => unknown })
    .LanguageModelThinkingPart
  if (typeof Thinking === 'function') {
    progress.report(new Thinking(text))
  }
}

function toAbortSignal(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController()
  if (token.isCancellationRequested) controller.abort()
  else token.onCancellationRequested(() => controller.abort())
  return controller.signal
}
