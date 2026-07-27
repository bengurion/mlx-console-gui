/**
 * Turning a full-precision Hugging Face repo into a quantized MLX model.
 *
 * `mlx_lm.convert` does the work; this decides what to ask it for and reports
 * what it is doing. Two things are worth stating:
 *
 *  - **No editor.** The quantization choice used to be a VSCode quick pick, so
 *    the browser dashboard's Convert button opened a menu nobody could see —
 *    from the browser it looked like the button did nothing. The options are
 *    now data the UI renders, and the whole flow runs in either host.
 *  - **Conversion is a job, not a call.** It downloads the full-precision
 *    weights first, which for a 70B model is an hour and 140 GB. It is tracked
 *    and cancellable like a download, and shows up in the same list.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Emitter } from '../core/events.ts'
import { log } from '../core/logging.ts'
import { convertedRoot, mlxProcessEnv } from '../util/env.ts'
import {
  BF16_BITS,
  CONVERT_BITS,
  PREQUANT_NAME_RE,
  bytesForBits,
  chooseQuantBits,
  explainFit,
  formatBytes,
  parseParamsB,
  isGguf,
} from './modelFit.ts'
import type { ConvertItem, ConvertPlan } from '../shared/protocol.ts'

/** Only what conversion needs from the environment, so this stays testable. */
export interface ConvertEnv {
  ensureReady(interactive?: boolean): Promise<boolean>
  binPath(name: string): string
}

/** Everything spawn-shaped, so tests can run without mlx-lm installed. */
export interface ConvertRunner {
  (bin: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess
}

/**
 * Fetching the source repo in full, before converting.
 *
 * Not an optimization — `mlx_lm.convert` does not work without it. It fetches
 * only weights and configs, and then its own `save()` re-resolves the source
 * with `snapshot_download(local_files_only=True)`, which current
 * huggingface_hub versions refuse for an incomplete snapshot. The whole
 * conversion runs, quantizes, and dies at the last step with
 * `IncompleteSnapshotError: 3 file(s) are missing (.gitattributes, LICENSE,
 * README.md)`. Downloading everything first makes the snapshot complete, and
 * gives a real progress bar for the slow half besides.
 */
export interface ConvertDownloader {
  download(
    repo: string,
    onProgress: (p: { downloaded?: number; total?: number; file?: string }) => void,
    signal?: AbortSignal,
  ): Promise<void>
}

const defaultRunner: ConvertRunner = (bin, args, env) => spawn(bin, args, { env })

export class ConvertManager {
  private readonly items = new Map<string, ConvertItem>()
  private readonly running = new Map<string, ChildProcess>()
  private readonly env: ConvertEnv
  private readonly run: ConvertRunner
  private readonly fetcher: ConvertDownloader | undefined
  private readonly aborts = new Map<string, AbortController>()
  /**
   * Repos whose child got SIGTERM but has not yet closed. Cancel used to
   * release the start-guard immediately, so a quick Retry started a new run —
   * which the old run's close handler then destroyed, deleting the new output
   * directory and marking the new job canceled.
   */
  private readonly stopping = new Set<string>()

  /** Repo facts for the gates; fetched per start so no entry path skips them. */
  facts:
    | ((repo: string) => Promise<{
        paramsB?: number
        arch?: { modelType?: string; supported?: boolean; prequantized?: string }
      }>)
    | undefined

  /** Something else that owns this repo right now — a plain download, typically. */
  busyElsewhere: ((repo: string) => string | undefined) | undefined

  private readonly _onDidChange = new Emitter<ConvertItem[]>()
  readonly onDidChange = this._onDidChange.event

  /** Fired with the output path when a conversion succeeds. */
  private readonly _onDidComplete = new Emitter<string>()
  readonly onDidComplete = this._onDidComplete.event

  constructor(env: ConvertEnv, fetcher?: ConvertDownloader, run: ConvertRunner = defaultRunner) {
    this.env = env
    this.fetcher = fetcher
    this.run = run
  }

  list(): ConvertItem[] {
    return [...this.items.values()]
  }

  /** Three quarters of unified memory: the rest is the OS, the UI and everything else. */
  private budgetBytes(): number {
    return Math.floor(os.totalmem() * 0.75)
  }

  /** Where converted models are written. Kept beside the cache so one setting moves both. */
  outputRoot(): string {
    return convertedRoot()
  }

  outputPath(repo: string, bits: number): string {
    const suffix = bits === BF16_BITS ? 'bf16' : `${bits}bit`
    // The org stays in the name: `Qwen/X` and `unsloth/X` are different
    // models, and dropping the org mapped both to the same directory.
    const name = repo.includes('/') ? repo.replace('/', '--') : repo
    return path.join(this.outputRoot(), `${name}-${suffix}`)
  }

  /** Whether this repo has a conversion in flight (either phase, or stopping). */
  isActive(repo: string): boolean {
    return this.running.has(repo) || this.aborts.has(repo) || this.stopping.has(repo)
  }

  /** Drop cards whose output path or repo matches a deleted model. */
  removeByOutput(repoOrPath: string): void {
    for (const [key, item] of this.items) {
      if (item.outPath !== repoOrPath && item.repo !== repoOrPath) continue
      if (this.isActive(item.repo)) continue
      this.items.delete(key)
    }
    this._onDidChange.fire(this.list())
  }

  /** Drop a settled card. */
  remove(repo: string, bits?: number): void {
    if (this.isActive(repo)) return
    let removed = false
    for (const [key, item] of this.items) {
      if (item.repo !== repo) continue
      if (bits !== undefined && item.bits !== bits) continue
      removed = this.items.delete(key) || removed
    }
    if (removed) this._onDidChange.fire(this.list())
  }

  /**
   * The choices, with the consequence of each spelled out.
   *
   * `exactParamsB` is the Hub's `safetensors.total` when the caller has it;
   * otherwise the count is parsed from the repo id, which is a guess — "7B"
   * in a name is a convention, not metadata. Either way sizes are marked
   * approximate, and a repo whose size is unknown still offers every bit
   * width rather than refusing.
   */
  plan(
    repo: string,
    exactParamsB?: number,
    arch?: { modelType?: string; supported?: boolean; prequantized?: string },
  ): ConvertPlan {
    const budgetBytes = this.budgetBytes()
    const totalBytes = os.totalmem()

    // Converting is format translation, not architecture implementation: a
    // repo whose model_type mlx-lm has no module for would convert cleanly
    // into weights nothing can run. Refused before the download, not after.
    if (arch?.supported === false) {
      return {
        repo,
        budgetBytes,
        totalBytes,
        options: [],
        error:
          `This is a "${arch.modelType}" model — an architecture mlx-lm does not implement, so the ` +
          'converted weights would have nothing to run them. MLX Console GUI serves text-generation ' +
          'models (llama, qwen, gemma, gpt-oss, …); other model kinds need their own runtime.',
      }
    }

    if (isGguf(repo)) {
      return {
        repo,
        budgetBytes,
        totalBytes,
        options: [],
        error: 'GGUF repos cannot be converted — mlx_lm.convert only reads Hugging Face safetensors.',
      }
    }

    // Already-quantized safetensors are just as unconvertible as GGUF, but
    // fail an hour in — after the full download — instead of up front. The
    // repo's own quantization_config is authoritative when the caller has it;
    // the name check remains for when the config could not be fetched.
    const prequant = arch?.prequantized
      ? `already quantized (${arch.prequantized})`
      : PREQUANT_NAME_RE.test(repo)
        ? 'already quantized, by its name'
        : undefined
    if (prequant) {
      return {
        repo,
        budgetBytes,
        totalBytes,
        options: [],
        error:
          `This repo is ${prequant}, and mlx_lm.convert only reads full-precision ` +
          'weights — it dies on the quantization scale tensors mid-run. Convert the original ' +
          'model it was quantized from instead.',
      }
    }

    const paramsB = exactParamsB ?? parseParamsB(repo)
    const recommended = chooseQuantBits(paramsB, budgetBytes)
    // bf16 first: not a quantization, but sometimes exactly what is wanted —
    // the original precision in a format mlx-lm can load.
    const options = [BF16_BITS, ...CONVERT_BITS].map((bits) => {
      const estBytes = paramsB ? bytesForBits(paramsB, bits) : undefined
      const fit = estBytes ? explainFit(estBytes, budgetBytes, totalBytes) : undefined
      return {
        bits,
        recommended: bits === recommended,
        estBytes,
        fit: fit?.verdict ?? ('unknown' as const),
        summary: fit ? `≈ ${formatBytes(estBytes!)} — ${fit.summary}` : 'size unknown',
        detail:
          bits === BF16_BITS
            ? ['Original precision — no quantization, just the MLX format.', fit?.detail]
                .filter(Boolean)
                .join(' ')
            : bits === recommended
              ? `Highest quantization that fits ${formatBytes(budgetBytes)} of usable memory.`
              : (fit?.detail ??
                'Neither the Hub nor the repo id says how many parameters this model has.'),
      }
    })

    // Even 2-bit past the budget: say so once, here, rather than letting every
    // option read as merely "tight".
    const hopeless = paramsB !== undefined && recommended === undefined
    return {
      repo,
      // Rounded for display: an exact count reads as 8.03B, not 8.030261248B.
      paramsB: paramsB === undefined ? undefined : Math.round(paramsB * 100) / 100,
      budgetBytes,
      totalBytes,
      options,
      error: hopeless
        ? `~${Math.round(paramsB!)}B parameters does not fit ${formatBytes(budgetBytes)} of usable memory even at ` +
          `${CONVERT_BITS.at(-1)}-bit. Converting will succeed; loading it will not.`
        : undefined,
    }
  }

  private update(repo: string, patch: Partial<ConvertItem>) {
    const prev: ConvertItem = this.items.get(repo) ?? {
      repo,
      bits: 0,
      outPath: '',
      state: 'converting',
      progress: 0,
    }
    this.items.set(repo, { ...prev, ...patch })
    this._onDidChange.fire(this.list())
  }

  async start(repo: string, bits?: number): Promise<{ ok: boolean; error?: string }> {
    // A refusal answers the caller, but a retry from an existing card has no
    // caller reading the answer — put it on the card too, or the click looks
    // like it did nothing.
    const refuse = (error: string): { ok: false; error: string } => {
      if (this.items.has(repo)) this.update(repo, { state: 'error', message: error })
      return { ok: false, error }
    }
    if (this.isActive(repo)) return { ok: false, error: 'Already converting.' }
    const busy = this.busyElsewhere?.(repo)
    if (busy) return refuse(busy)

    // Fetch the repo's facts here rather than trusting the caller to have
    // done it: the command palette used to call straight in, skipping the
    // architecture and pre-quantized gates the Search page enforced.
    const f = await this.facts?.(repo).catch(() => undefined)
    const plan = this.plan(repo, f?.paramsB, f?.arch)
    if (plan.options.length === 0) return refuse(plan.error ?? 'Cannot convert this repo.')

    const chosen = bits ?? plan.options.find((o) => o.recommended)?.bits ?? 4
    const outPath = this.outputPath(repo, chosen)

    // A done card for another bit width is a real result; starting a new
    // width must not overwrite it (items were keyed by repo alone).
    const prev = this.items.get(repo)
    if (prev && prev.state === 'done' && prev.bits !== chosen) {
      this.items.set(`${repo}#${prev.bits}`, prev)
    }

    if (fs.existsSync(outPath)) {
      return refuse(`${outPath} already exists. Delete it first, or pick another bit width.`)
    }
    // Failing here is much cheaper than failing after an hour of downloading.
    if (!(await this.env.ensureReady(true))) {
      return refuse('The Python environment is not ready — set it up from Settings first.')
    }

    this.update(repo, {
      bits: chosen,
      outPath,
      state: this.fetcher ? 'downloading' : 'converting',
      progress: 0,
      message: 'Starting.',
    })

    // Phase one: the full source snapshot. See ConvertDownloader — without a
    // complete one the conversion runs to the end and then throws away its
    // work.
    if (this.fetcher) {
      const abort = new AbortController()
      this.aborts.set(repo, abort)
      try {
        await this.fetcher.download(
          repo,
          (p) =>
            this.update(repo, {
              // The final 'done' event carries a total but no running count;
              // taking it as 0 would snap a finished bar back to empty.
              ...(p.downloaded != null && p.total
                ? { progress: Math.min(1, p.downloaded / p.total) }
                : {}),
              message: `Downloading ${repo}${p.file ? ` — ${p.file}` : ''}`,
            }),
          abort.signal,
        )
      } catch (err) {
        this.aborts.delete(repo)
        if (abort.signal.aborted) {
          this.update(repo, { state: 'canceled', message: 'Canceled before conversion started.' })
          return { ok: true }
        }
        const message = `Could not download ${repo}: ${err instanceof Error ? err.message : String(err)}`
        this.update(repo, { state: 'error', message })
        return { ok: false, error: message }
      }
      this.aborts.delete(repo)
    }

    // `python -m`, never the venv's bin/mlx_lm.convert launcher: pip bakes the
    // venv's absolute path into those scripts, so a migrated venv leaves them
    // pointing at a python that no longer exists (exit 126).
    const bin = this.env.binPath('python')
    const convertArgs =
      chosen === BF16_BITS
        ? ['--hf-path', repo, '--mlx-path', outPath, '--dtype', 'bfloat16']
        : ['--hf-path', repo, '--mlx-path', outPath, '-q', '--q-bits', String(chosen), '--q-group-size', '64']
    const args = ['-m', 'mlx_lm', 'convert', ...convertArgs]
    log.info(`Converting: ${bin} ${args.join(' ')}`)
    this.update(repo, {
      state: 'converting',
      progress: 0,
      message: chosen === BF16_BITS ? 'Converting.' : 'Quantizing.',
    })

    const child = this.run(bin, args, mlxProcessEnv())
    this.running.set(repo, child)

    const onData = (d: Buffer) => {
      const text = d.toString().trimEnd()
      if (!text) return
      log.info(`[convert ${repo}] ${text}`)
      // tqdm redraws one line with \r; the last fragment is the current state.
      const line = text.split(/[\r\n]/).filter(Boolean).pop() ?? ''
      const pct = /(\d{1,3})%\|/.exec(line)
      this.update(repo, {
        message: line.slice(0, 120),
        ...(pct ? { progress: Math.min(1, Number(pct[1]) / 100) } : {}),
      })
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    let spawnFailed = false
    child.on('error', (err) => {
      spawnFailed = true
      this.running.delete(repo)
      this.update(repo, { state: 'error', message: `Could not start mlx_lm.convert: ${String(err)}` })
      log.error('convert failed to start', err)
    })

    child.on('close', (code, signal) => {
      // A spawn failure already wrote the real reason; the close that follows
      // used to overwrite it with a "Canceled" nobody asked for.
      if (spawnFailed) {
        this.stopping.delete(repo)
        return
      }
      const canceled = this.stopping.has(repo) || signal === 'SIGTERM'
      if (this.running.get(repo) === child) this.running.delete(repo)
      this.stopping.delete(repo)
      if (canceled) {
        // A half-written model directory is worse than none: mlx-lm would find
        // it, try to load it, and fail on a missing shard.
        fs.rmSync(outPath, { recursive: true, force: true })
        return this.update(repo, { state: 'canceled', message: 'Canceled; the partial output was removed.' })
      }
      if (code === 0) {
        this.update(repo, { state: 'done', progress: 1, message: `Saved to ${outPath}` })
        this._onDidComplete.fire(outPath)
        log.info(`Converted model saved to ${outPath}`)
      } else {
        // Same rule as cancel: a half-written model directory is worse than
        // none — and leaving it would make the retry refuse with
        // "already exists" instead of relaunching.
        fs.rmSync(outPath, { recursive: true, force: true })
        const item = this.items.get(repo)
        this.update(repo, {
          state: 'error',
          message: `mlx_lm.convert exited with code ${code}. ${item?.message ?? ''}`.trim(),
        })
      }
    })

    return { ok: true }
  }

  cancel(repo: string): void {
    // Either phase may be the one running.
    this.aborts.get(repo)?.abort()
    const child = this.running.get(repo)
    if (!child) return
    // The start-guard stays held (via `stopping`) until the child actually
    // closes — releasing it here let a fast Retry race the old cleanup.
    this.stopping.add(repo)
    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
    }, 5000).unref()
  }

  dispose() {
    for (const abort of this.aborts.values()) abort.abort()
    this.aborts.clear()
    for (const child of this.running.values()) child.kill('SIGTERM')
    this.running.clear()
    this._onDidChange.dispose()
    this._onDidComplete.dispose()
  }
}
