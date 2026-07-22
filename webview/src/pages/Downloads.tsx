import { useEffect, useState } from 'react'
import { rpc, onPush } from '../api'
import { bytes, shortRepo } from '../format'
import type { DownloadItem } from '../../../src/shared/protocol'

const STATE_LABEL: Record<DownloadItem['state'], string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  done: 'Complete',
  error: 'Error',
  canceled: 'Canceled',
}

export function DownloadsPage() {
  const [items, setItems] = useState<DownloadItem[]>([])
  useEffect(() => onPush<DownloadItem[]>('downloads', setItems), [])

  if (items.length === 0) {
    return <div className="empty muted">No downloads yet.</div>
  }

  return (
    <div className="col">
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
