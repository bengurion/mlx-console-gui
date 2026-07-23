import { useEffect, useState } from 'react'
import { rpc, onPush } from '../api'
import { bytes, shortRepo } from '../format'
import type { ConvertItem, DownloadItem } from '../../../src/shared/protocol'

const STATE_LABEL: Record<DownloadItem['state'], string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  done: 'Complete',
  error: 'Error',
  canceled: 'Canceled',
}

const CONVERT_LABEL: Record<ConvertItem['state'], string> = {
  downloading: 'Downloading source',
  converting: 'Converting',
  done: 'Complete',
  error: 'Error',
  canceled: 'Canceled',
}

export function DownloadsPage() {
  const [items, setItems] = useState<DownloadItem[]>([])
  const [converts, setConverts] = useState<ConvertItem[]>([])
  useEffect(() => onPush<DownloadItem[]>('downloads', setItems), [])
  useEffect(() => onPush<ConvertItem[]>('converts', setConverts), [])

  if (items.length === 0 && converts.length === 0) {
    return <div className="empty muted">No downloads yet.</div>
  }

  return (
    <div className="col">
      {converts.length > 0 && (
        <>
          {items.length > 0 && <div className="small muted">Conversions</div>}
          {converts.map((item) => (
            <ConvertCard key={item.repo} item={item} />
          ))}
          {items.length > 0 && <div className="small muted">Downloads</div>}
        </>
      )}

      {items.map((item) => (
        <div key={item.repo} className="card col">
          <div className="row spread">
            <strong title={item.repo}>{shortRepo(item.repo)}</strong>
            <span className="small muted">{STATE_LABEL[item.state]}</span>
          </div>
          {item.state === 'downloading' && (
            <div className="bar">
              <span style={{ width: `${Math.round(item.progress * 100)}%` }} />
            </div>
          )}
          <div className="row spread small muted">
            <span>
              {item.downloadedBytes != null && item.totalBytes
                ? `${bytes(item.downloadedBytes)} / ${bytes(item.totalBytes)}`
                : item.message ?? ''}
            </span>
            {item.state === 'downloading' && (
              <a onClick={() => rpc('cancelDownload', { repo: item.repo })}>Cancel</a>
            )}
          </div>
          {item.state === 'error' && item.message && (
            <div className="small" style={{ color: 'var(--vscode-errorForeground)' }}>
              {item.message}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * A conversion in progress.
 *
 * `mlx_lm.convert` prints tqdm bars while it fetches the full-precision weights
 * and says little while it quantizes, so this shows the percentage when there
 * is one and the last line it printed otherwise — which at least distinguishes
 * "working" from "stuck".
 */
function ConvertCard({ item }: { item: ConvertItem }) {
  return (
    <div className="card col">
      <div className="row spread">
        <strong title={item.repo}>
          {shortRepo(item.repo)} → {item.bits}-bit
        </strong>
        <span className="small muted">{CONVERT_LABEL[item.state]}</span>
      </div>
      {(item.state === 'converting' || item.state === 'downloading') && (
        <div className="bar">
          <span style={{ width: `${Math.round(item.progress * 100)}%` }} />
        </div>
      )}
      <div className="row spread small muted">
        <span title={item.outPath}>{item.message ?? ''}</span>
        {(item.state === 'converting' || item.state === 'downloading') && (
          <a onClick={() => rpc('cancelConvert', { repo: item.repo })}>Cancel</a>
        )}
      </div>
      {item.state === 'error' && item.message && (
        <div className="small" style={{ color: 'var(--vscode-errorForeground)' }}>
          {item.message}
        </div>
      )}
    </div>
  )
}
