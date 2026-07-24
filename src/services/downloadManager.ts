import { Emitter } from '../core/events'
import { log } from '../core/logging'
import type { PythonHelper } from '../backend/pythonHelper'
import type { DownloadItem } from '../shared/protocol'

/** A sleep that ends early (rejecting) when the download is canceled. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Tracks Hugging Face model downloads and surfaces progress to the UI. */
export class DownloadManager {
  private readonly items = new Map<string, DownloadItem>()
  private readonly controllers = new Map<string, AbortController>()

  private readonly _onDidChange = new Emitter<DownloadItem[]>()
  readonly onDidChange = this._onDidChange.event

  /** Fired with the repo id when a download completes successfully. */
  private readonly _onDidComplete = new Emitter<string>()
  readonly onDidComplete = this._onDidComplete.event

  constructor(private readonly helper: PythonHelper) {}

  list(): DownloadItem[] {
    return [...this.items.values()]
  }

  private update(repo: string, patch: Partial<DownloadItem>) {
    const prev = this.items.get(repo) ?? { repo, state: 'queued', progress: 0 }
    this.items.set(repo, { ...prev, ...patch })
    this._onDidChange.fire(this.list())
  }

  async start(repo: string): Promise<void> {
    const existing = this.items.get(repo)
    if (existing && (existing.state === 'downloading' || existing.state === 'queued')) return

    const controller = new AbortController()
    this.controllers.set(repo, controller)
    this.update(repo, { state: 'downloading', progress: 0, message: 'Starting…' })
    log.info(`Download started: ${repo}`)

    const attempt = () =>
      this.helper.download(
        repo,
        (p) => {
          if (p.event === 'start') {
            this.update(repo, { totalBytes: p.total, message: `${p.nbFiles ?? 0} files` })
          } else if (p.event === 'progress') {
            const progress = p.total ? Math.min(1, (p.downloaded ?? 0) / p.total) : 0
            this.update(repo, {
              progress,
              downloadedBytes: p.downloaded,
              totalBytes: p.total,
              message: p.file,
            })
          }
        },
        controller.signal,
      )

    try {
      // Transient network failures are retried here rather than surfaced:
      // completed files are cache hits and partial bytes resume, so a retry
      // costs seconds, while an "Error" card at 3 a.m. costs the whole night
      // of an unattended 100 GB download.
      const delays = [5_000, 15_000, 60_000]
      for (let i = 0; ; i++) {
        try {
          await attempt()
          break
        } catch (err) {
          if (controller.signal.aborted || i >= delays.length) throw err
          log.warn(`Download failed, retrying in ${delays[i] / 1000}s: ${repo}`, err)
          this.update(repo, { message: `Connection lost — retrying in ${delays[i] / 1000}s…` })
          await abortableDelay(delays[i], controller.signal)
        }
      }
      this.update(repo, { state: 'done', progress: 1, message: 'Complete' })
      this._onDidComplete.fire(repo)
      log.info(`Download complete: ${repo}`)
    } catch (err) {
      if (controller.signal.aborted) {
        this.update(repo, { state: 'canceled', message: 'Canceled — partial data is kept for resume' })
      } else {
        this.update(repo, { state: 'error', message: String(err) })
        log.error(`Download failed: ${repo}`, err)
      }
    } finally {
      this.controllers.delete(repo)
    }
  }

  cancel(repo: string): void {
    this.controllers.get(repo)?.abort()
  }

  dispose() {
    for (const c of this.controllers.values()) c.abort()
    this._onDidChange.dispose()
    this._onDidComplete.dispose()
  }
}
