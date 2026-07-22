/**
 * The mlx_lm.server command line, in one place.
 *
 * Both the extension and the headless CLI start the same server, and a flag
 * that only one of them passes is a difference you would only notice as a
 * mysterious change in memory use. Keeping this pure also makes the "0 means
 * leave the server's own default alone" rule directly testable.
 */

export interface ServerArgsConfig {
  bindHost: string
  port: number
  /** 0 / empty / undefined means: omit the flag entirely. */
  promptCacheSize?: number
  promptCacheBytes?: number
  decodeConcurrency?: number
  promptConcurrency?: number
  prefillStepSize?: number
  draftModel?: string
  numDraftTokens?: number
  extraArgs?: string[]
  logLevel?: string
}

export function buildServerArgs(c: ServerArgsConfig): string[] {
  const args = ['--host', c.bindHost, '--port', String(c.port), '--log-level', c.logLevel ?? 'INFO']

  const push = (flag: string, value: number | undefined) => {
    if (value !== undefined && value > 0) args.push(flag, String(value))
  }

  // KV-cache budget: the practical ceiling on how much context stays cached.
  push('--prompt-cache-size', c.promptCacheSize)
  push('--prompt-cache-bytes', c.promptCacheBytes)
  // Concurrency and speculative decoding: omitted at 0/'' so mlx_lm.server
  // keeps its own defaults rather than being pinned to ours.
  push('--decode-concurrency', c.decodeConcurrency)
  push('--prompt-concurrency', c.promptConcurrency)
  push('--prefill-step-size', c.prefillStepSize)

  const draft = c.draftModel?.trim()
  if (draft) {
    args.push('--draft-model', draft)
    // Only meaningful alongside a draft model.
    push('--num-draft-tokens', c.numDraftTokens)
  }

  args.push(...(c.extraArgs ?? []).filter((a) => a.trim().length > 0))
  return args
}
