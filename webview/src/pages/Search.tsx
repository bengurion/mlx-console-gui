import { useEffect, useState, useCallback } from 'react'
import { rpc, onPush, openExternal } from '../api'
import { bytes, count, relativeDate } from '../format'
import type {
  DownloadItem,
  DownloadState,
  FitVerdict,
  MachineProfile,
  ModelSummary,
  SearchQuery,
  SearchResult,
  SortKey,
} from '../../../src/shared/protocol'

const QUANTS = ['', '4bit', '8bit', '6bit', 'bf16']
const SORTS: { key: SortKey; label: string }[] = [
  { key: 'downloads', label: 'Downloads' },
  { key: 'likes', label: 'Likes' },
  { key: 'trending', label: 'Trending' },
  { key: 'lastModified', label: 'Recent' },
]

const FIT_LABEL: Record<FitVerdict, string> = {
  fits: '✓ fits',
  tight: '⚠ tight',
  'too-large': '✗ too large',
  unknown: '? size',
}

const FIT_COLOR: Record<FitVerdict, string> = {
  fits: 'var(--vscode-testing-iconPassed, #3fb950)',
  tight: 'var(--vscode-editorWarning-foreground, #d29922)',
  'too-large': 'var(--vscode-errorForeground, #f85149)',
  unknown: 'var(--vscode-descriptionForeground)',
}

type SizeInfo = { bytes: number; fit: FitVerdict }

export function SearchPage() {
  const [query, setQuery] = useState<SearchQuery>({
    text: '',
    libraryMlx: true,
    mlxCommunity: false,
    sort: 'downloads',
    limit: 50,
    onlyFits: false,
    hideGguf: true,
  })
  const [results, setResults] = useState<ModelSummary[]>([])
  const [total, setTotal] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [sizes, setSizes] = useState<Record<string, SizeInfo>>({})
  const [machine, setMachine] = useState<MachineProfile>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [dl, setDl] = useState<Record<string, DownloadState>>({})

  useEffect(
    () =>
      onPush<DownloadItem[]>('downloads', (items) => {
        const map: Record<string, DownloadState> = {}
        for (const i of items) map[i.repo] = i.state
        setDl(map)
      }),
    [],
  )

  useEffect(() => {
    void rpc<MachineProfile>('getMachine').then(setMachine).catch(() => undefined)
  }, [])

  const doSearch = useCallback(async (q: SearchQuery) => {
    setLoading(true)
    setError(undefined)
    try {
      const found = await rpc<SearchResult>('search', q)
      setResults(found.items)
      setTotal(found.total)
      setTruncated(found.truncated)
      // Refine the heuristic sizes with exact dtype-derived byte counts.
      const repos = found.items.map((m) => m.id)
      if (repos.length) {
        void rpc<Record<string, SizeInfo>>('getModelSizes', { repos })
          .then((exact) => setSizes((prev) => ({ ...prev, ...exact })))
          .catch(() => undefined)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void doSearch(query)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const patch = (p: Partial<SearchQuery>) => setQuery((q) => ({ ...q, ...p }))

  const visible = query.onlyFits
    ? results.filter((m) => (sizes[m.id]?.fit ?? m.fit) !== 'too-large')
    : results
  const mlxCount = visible.filter((m) => m.format === 'mlx').length
  const convCount = visible.filter((m) => m.format === 'convertible').length

  return (
    <div className="col">
      <input
        type="search"
        placeholder="Search Hugging Face models…"
        value={query.text}
        onChange={(e) => patch({ text: e.target.value })}
        onKeyDown={(e) => e.key === 'Enter' && doSearch(query)}
      />
      <div className="row wrap small">
        <label className="check">
          <input
            type="checkbox"
            checked={query.libraryMlx}
            onChange={(e) => patch({ libraryMlx: e.target.checked })}
          />
          MLX only
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={query.mlxCommunity}
            onChange={(e) => patch({ mlxCommunity: e.target.checked })}
          />
          mlx-community
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={query.onlyFits ?? false}
            onChange={(e) => patch({ onlyFits: e.target.checked })}
          />
          Fits my machine
        </label>
      </div>
      <div className="row">
        <select
          value={query.quant ?? ''}
          onChange={(e) => patch({ quant: e.target.value || undefined })}
        >
          {QUANTS.map((q) => (
            <option key={q} value={q}>
              {q ? q : 'Any quant'}
            </option>
          ))}
        </select>
        <select value={query.sort} onChange={(e) => patch({ sort: e.target.value as SortKey })}>
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <button onClick={() => doSearch(query)} disabled={loading}>
        {loading ? 'Searching…' : 'Search'}
      </button>

      {machine && (
        <div className="small muted">
          {bytes(machine.totalRamBytes)} unified memory · {machine.cores} cores · usable budget{' '}
          {bytes(machine.budgetBytes)}
        </div>
      )}

      {error && <div className="card small">⚠️ {error}</div>}

      {!loading && !error && total > 0 && (
        <div className="small muted">
          Showing {visible.length} of {total} — {mlxCount} MLX-ready
          {convCount > 0 && `, ${convCount} convertible`}.
          {query.libraryMlx &&
            ' Uncheck “MLX only” to include safetensors models you can convert.'}
        </div>
      )}

      {!loading && visible.length === 0 && !error && (
        <div className="empty muted col">
          <div>No models found.</div>
          {query.mlxCommunity && (
            <div className="small">Try unchecking “mlx-community” — it limits results to one author.</div>
          )}
          {query.libraryMlx && !query.mlxCommunity && (
            <div className="small">Try unchecking “MLX only” to include other formats.</div>
          )}
        </div>
      )}

      <div className="col">
        {visible.map((m) => (
          <ResultCard key={m.id} model={m} exact={sizes[m.id]} state={dl[m.id]} />
        ))}
      </div>

      {truncated && !loading && (
        <button
          className="secondary"
          onClick={() => {
            const next = { ...query, limit: (query.limit ?? 50) + 50 }
            setQuery(next)
            void doSearch(next)
          }}
        >
          Load more ({total - visible.length} more)
        </button>
      )}
    </div>
  )
}

function ResultCard({
  model,
  exact,
  state,
}: {
  model: ModelSummary
  exact?: SizeInfo
  state?: DownloadState
}) {
  const sizeBytes = exact?.bytes ?? model.sizeBytes
  const fit: FitVerdict = exact?.fit ?? model.fit ?? 'unknown'
  const label =
    state === 'downloading'
      ? 'Downloading…'
      : state === 'queued'
        ? 'Queued'
        : state === 'done'
          ? 'Downloaded'
          : 'Download'
  const busy = state === 'downloading' || state === 'queued' || state === 'done'
  const format = model.format ?? (model.gguf ? 'unsupported' : 'convertible')
  const tags = model.tags
    .filter((t) => !['mlx', 'safetensors', 'transformers'].includes(t))
    .slice(0, 4)

  return (
    <div className="card col">
      <div className="row spread">
        <a onClick={() => openExternal(`https://huggingface.co/${model.id}`)}>
          <strong>{model.id}</strong>
        </a>
        <span className="row">
          {format === 'convertible' && <span className="badge">convert</span>}
          {model.quant && <span className="badge">{model.quant}</span>}
        </span>
      </div>

      <div className="row wrap small muted">
        <span>⬇ {count(model.downloads)}</span>
        <span>♥ {count(model.likes)}</span>
        {sizeBytes ? (
          <span title={exact ? 'Exact size from model metadata' : 'Estimated from parameter count'}>
            {bytes(sizeBytes)}
            {exact ? '' : '≈'}
          </span>
        ) : null}
        {model.updatedAt && <span>{relativeDate(model.updatedAt)}</span>}
        {model.gated && <span className="badge">gated</span>}
      </div>

      {format !== 'unsupported' && (
        <div className="small" style={{ color: FIT_COLOR[fit] }}>
          {FIT_LABEL[fit]}
          {format === 'convertible' && (
            <span className="muted"> · not MLX yet — convert to run it</span>
          )}
        </div>
      )}

      {format === 'unsupported' && (
        <div className="small" style={{ color: 'var(--vscode-editorWarning-foreground)' }}>
          {model.gguf
            ? 'GGUF — mlx-lm cannot run or convert this. Look for an MLX or safetensors build.'
            : 'No safetensors — mlx-lm cannot load or convert this repo.'}
        </div>
      )}

      {tags.length > 0 && (
        <div className="row wrap">
          {tags.map((t) => (
            <span key={t} className="tag">
              {t}
            </span>
          ))}
        </div>
      )}

      <div className="row wrap">
        {format === 'mlx' && (
          <button disabled={busy} onClick={() => rpc('startDownload', { repo: model.id })}>
            {label}
          </button>
        )}
        {format === 'convertible' && (
          <button
            title="Convert to MLX at the highest quantization that fits this machine"
            onClick={() => rpc('convertModel', { repo: model.id })}
          >
            Convert to MLX…
          </button>
        )}
        {format === 'unsupported' && (
          <button disabled>Unsupported</button>
        )}
      </div>
    </div>
  )
}
