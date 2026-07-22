import * as vscode from 'vscode'
import { log } from '../util/logger'
import type { PythonHelper } from '../backend/pythonHelper'
import type { DownloadItem } from '../shared/protocol'

/** Tracks Hugging Face model downloads and surfaces progress to the UI. */
export class DownloadManager {
  private readonly items = new Map<string, DownloadItem>()
  private readonly controllers = new Map<string, AbortController>()

  private readonly _onDidChange = new vscode.EventEmitter<DownloadItem[]>()
  readonly onDidChange = this._onDidChange.event

  /** Fired with the repo id when a download completes successfully. */
  private readonly _onDidComplete = new vscode.EventEmitter<string>()
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

    try {
      await this.helper.download(
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
      this.update(repo, { state: 'done', progress: 1, message: 'Complete' })
      this._onDidComplete.fire(repo)
      log.info(`Download complete: ${repo}`)
    } catch (err) {
      if (controller.signal.aborted) {
        this.update(repo, { state: 'canceled', message: 'Canceled' })
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
