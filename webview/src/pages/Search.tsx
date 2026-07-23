import { useEffect, useState, useCallback } from 'react'
import { rpc, onPush, openExternal } from '../api'
import { bytes, count, relativeDate } from '../format'
import type {
  ConvertItem,
  ConvertPlan,
  ConvertState,
  SearchScope,
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

const SCOPES: { key: SearchScope; label: string; hint: string }[] = [
  { key: 'mlx', label: 'MLX-ready', hint: 'Already MLX — download and run' },
  { key: 'convertible', label: 'MLX + convertible', hint: 'Adds safetensors models you can convert' },
  { key: 'all', label: 'Everything', hint: 'Includes GGUF, which mlx-lm cannot run or convert' },
]

/**
 * Parameter-count buckets.
 *
 * Sizes come from the Hub's own safetensors metadata, so these are exact
 * rather than parsed out of "7B" in a repo name — which is why 4x7B mixtures
 * and mislabelled repos land in the right bucket.
 */
const SIZES: { label: string; minB?: number; maxB?: number }[] = [
  { label: 'Any size' },
  { label: 'Under 1B', maxB: 1 },
  { label: '1 – 4B', minB: 1, maxB: 4 },
  { label: '4 – 9B', minB: 4, maxB: 9 },
  { label: '9 – 20B', minB: 9, maxB: 20 },
  { label: '20 – 40B', minB: 20, maxB: 40 },
  { label: '40 – 80B', minB: 40, maxB: 80 },
  { label: '80B and up', minB: 80 },
]
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
  fits: 'var(--viz-good, #0ca30c)',
  tight: 'var(--viz-warn, #b45309)',
  'too-large': 'var(--viz-crit, #d03b3b)',
  unknown: 'var(--vscode-descriptionForeground)',
}

/** The verdict as a tinted pill — the one thing to see first on a card. */
function FitPill({ fit }: { fit: FitVerdict }) {
  return (
    <span
      className="pill"
      style={{
        color: FIT_COLOR[fit],
        background: `color-mix(in srgb, ${FIT_COLOR[fit]} 12%, transparent)`,
      }}
    >
      {FIT_LABEL[fit]}
    </span>
  )
}

/** Colour for the finer-grained verdicts a conversion plan reports. */
const PLAN_COLOR: Record<string, string> = {
  ...FIT_COLOR,
  'over-budget': 'var(--vscode-editorWarning-foreground, #d29922)',
}

export function SearchPage() {
  const [query, setQuery] = useState<SearchQuery>({
    text: '',
    // Convertible by default: the Hub has far more safetensors models than MLX
    // ones, and converting is a button now.
    scope: 'convertible',
    mlxCommunity: false,
    sort: 'downloads',
    limit: 50,
    onlyFits: false,
  })
  const [results, setResults] = useState<ModelSummary[]>([])
  const [total, setTotal] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [scanned, setScanned] = useState(0)
  const [exhausted, setExhausted] = useState(true)
  const [machine, setMachine] = useState<MachineProfile>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [dl, setDl] = useState<Record<string, DownloadState>>({})
  const [conv, setConv] = useState<Record<string, ConvertState>>({})

  useEffect(
    () =>
      onPush<DownloadItem[]>('downloads', (items) => {
        const map: Record<string, DownloadState> = {}
        for (const i of items) map[i.repo] = i.state
        setDl(map)
      }),
    [],
  )

  useEffect(
    () =>
      onPush<ConvertItem[]>('converts', (items) => {
        const map: Record<string, ConvertState> = {}
        for (const i of items) map[i.repo] = i.state
        setConv(map)
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
      setScanned(found.scanned)
      setExhausted(found.exhausted)
      // Sizes arrive with the search now — the expanded Hub query carries the
      // safetensors metadata, so the second round of per-repo requests is gone.
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

  const visible = query.onlyFits ? results.filter((m) => m.fit !== 'too-large') : results
  const mlxCount = visible.filter((m) => m.format === 'mlx').length
  const convCount = visible.filter((m) => m.format === 'convertible').length

  return (
    <div className="col">
      <div className="toolbar">
        <input
          type="search"
          placeholder="Search Hugging Face models…"
          value={query.text}
          onChange={(e) => patch({ text: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && doSearch(query)}
        />
        <button onClick={() => doSearch(query)} disabled={loading}>
          {loading ? 'Searching…' : 'Search'}
        </button>
      </div>
      <div className="filters small">
        <select
          value={query.scope}
          title={SCOPES.find((sc) => sc.key === query.scope)?.hint}
          onChange={(e) => patch({ scope: e.target.value as SearchScope })}
        >
          {SCOPES.map((sc) => (
            <option key={sc.key} value={sc.key} title={sc.hint}>
              {sc.label}
            </option>
          ))}
        </select>
        <select
          value={SIZES.findIndex(
            (b) => b.minB === query.params?.minB && b.maxB === query.params?.maxB,
          )}
          onChange={(e) => {
            const b = SIZES[Number(e.target.value)] ?? SIZES[0]
            patch({ params: b.minB === undefined && b.maxB === undefined ? undefined : { minB: b.minB, maxB: b.maxB } })
          }}
        >
          {SIZES.map((b, i) => (
            <option key={b.label} value={i}>
              {b.label}
            </option>
          ))}
        </select>
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
              Sort: {s.label}
            </option>
          ))}
        </select>
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
        {machine && (
          <span className="muted" style={{ marginLeft: 'auto' }}>
            {bytes(machine.totalRamBytes)} unified · usable budget {bytes(machine.budgetBytes)}
          </span>
        )}
      </div>

      {error && <div className="card small">⚠️ {error}</div>}

      {!loading && !error && total > 0 && (
        <div className="small muted">
          Showing {Math.min(visible.length, query.limit)} of {total} — {mlxCount} MLX-ready
          {convCount > 0 && `, ${convCount} convertible`}.{' '}
          {/* What was searched, not just what matched: "12 results" out of 200
              examined and out of the whole Hub mean very different things. */}
          {exhausted
            ? `That is every match in ${scanned.toLocaleString()} entries.`
            : `Found in the first ${scanned.toLocaleString()} entries — narrow the search for more.`}
          {query.scope === 'mlx' && ' Switch to “MLX + convertible” to include models you can convert.'}
        </div>
      )}

      {!loading && visible.length === 0 && !error && (
        <div className="empty muted col">
          <div>No models found.</div>
          {query.mlxCommunity && (
            <div className="small">Try unchecking “mlx-community” — it limits results to one author.</div>
          )}
          {query.scope === 'mlx' && !query.mlxCommunity && (
            <div className="small">Try “MLX + convertible” — far more of the Hub ships safetensors than MLX.</div>
          )}
          {query.params && (
            <div className="small">The size filter is exact; try a wider band.</div>
          )}
        </div>
      )}

      <div className="grid-cards">
        {visible.map((m) => (
          <ResultCard
            key={m.id}
            model={m}
            state={dl[m.id]}
            convertState={conv[m.id]}
          />
        ))}
      </div>

      {truncated && !loading && (
        <div className="row" style={{ justifyContent: 'center' }}>
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
        </div>
      )}
    </div>
  )
}

function ResultCard({
  model,
  state,
  convertState,
}: {
  model: ModelSummary
  state?: DownloadState
  convertState?: ConvertState
}) {
  // The quantization choice used to be an editor quick pick, which the browser
  // dashboard could not show at all — the button simply did nothing there. It
  // opens inside the card now, so both hosts get the same flow.
  const [plan, setPlan] = useState<ConvertPlan>()
  const [planError, setPlanError] = useState<string>()
  const sizeBytes = model.sizeBytes
  const fit: FitVerdict = model.fit ?? 'unknown'
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
    .slice(0, 3)

  return (
    <div className="card col">
      <div className="row spread">
        <a
          onClick={() => openExternal(`https://huggingface.co/${model.id}`)}
          title={model.id}
          style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          <strong>{model.id}</strong>
        </a>
        <span className="row">
          {/* The CTA button already says Convert; a chip repeating it is noise. */}
          {model.quant && <span className="badge">{model.quant}</span>}
        </span>
      </div>

      {/* What matters, in the order it matters: does it fit, what does it
          cost, then the popularity noise — muted, since it never decides
          whether a model runs on this machine. */}
      <div className="row wrap small" style={{ gap: 10, alignItems: 'center' }}>
        {format !== 'unsupported' && <FitPill fit={fit} />}
        {sizeBytes ? (
          <strong
            title={
              model.sizeExact
                ? 'Exact, from the model’s safetensors metadata'
                : 'Estimated from the parameter count in the repo name'
            }
          >
            {bytes(sizeBytes)}
            {model.sizeExact ? '' : '≈'}
          </strong>
        ) : null}
        {model.paramsB != null && (
          <strong title="Parameters, from the Hub’s safetensors metadata (experts included)">
            {model.paramsB >= 1 ? `${model.paramsB.toFixed(model.paramsB < 10 ? 1 : 0)}B` : `${Math.round(model.paramsB * 1000)}M`}
          </strong>
        )}
        <span className="muted">⬇ {count(model.downloads)}</span>
        <span className="muted">♥ {count(model.likes)}</span>
        {model.updatedAt && <span className="muted">{relativeDate(model.updatedAt)}</span>}
        {model.gated && <span className="badge">gated</span>}
      </div>

      {format === 'convertible' && (
        <div className="small muted">Not MLX yet — convert to run it.</div>
      )}

      {format === 'unsupported' && (
        <div className="small" style={{ color: 'var(--vscode-editorWarning-foreground)' }}>
          {model.gguf
            ? 'GGUF — mlx-lm cannot run or convert this.'
            : 'No safetensors — mlx-lm cannot load or convert this repo.'}
          {/* The Hub records what a quantization was made from, so a dead end
              can point at the source that is not one. */}
          {model.baseModel
            ? ` Its source is ${model.baseModel}.`
            : ' Look for an MLX or safetensors build.'}
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

      {planError && (
        <div className="small" style={{ color: 'var(--vscode-errorForeground)' }}>
          {planError}
        </div>
      )}

      {plan && (
        <div className="col" style={{ gap: 4 }}>
          <div className="small muted">
            {plan.repo !== model.id && <strong>{plan.repo}</strong>}{' '}
            {plan.paramsB
              ? `~${plan.paramsB}B parameters · ${bytes(plan.budgetBytes)} usable of ${bytes(plan.totalBytes)}`
              : 'The repo id does not say how big this model is — sizes below are unknown, not zero.'}
          </div>
          {plan.error && (
            <div className="small" style={{ color: 'var(--vscode-editorWarning-foreground)' }}>
              {plan.error}
            </div>
          )}
          {plan.options.map((o) => (
            <button
              key={o.bits}
              className="secondary"
              title={o.detail}
              onClick={() => {
                setPlan(undefined)
                void rpc<{ ok: boolean; error?: string }>('convertModel', {
                  // plan.repo, not model.id: for a GGUF card the plan is for
                  // the source model, which is what actually converts.
                  repo: plan.repo,
                  bits: o.bits,
                }).then((r) => !r.ok && setPlanError(r.error))
              }}
            >
              <span>
                {o.bits}-bit{o.recommended ? ' · recommended' : ''}
              </span>
              <span className="small" style={{ color: PLAN_COLOR[o.fit] }}>
                {' '}
                {o.summary}
              </span>
            </button>
          ))}
          <div className="small muted">
            Conversion downloads the full-precision weights first — that is the slow part. Progress
            appears under Downloads.
          </div>
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
            disabled={convertState === 'converting' || convertState === 'downloading'}
            title="Pick a quantization and convert this repo to MLX"
            onClick={() => {
              if (plan) return setPlan(undefined)
              setPlanError(undefined)
              void rpc<ConvertPlan>('getConvertPlan', { repo: model.id })
                .then(setPlan)
                .catch((e: Error) => setPlanError(e.message))
            }}
          >
            {convertState === 'converting' || convertState === 'downloading'
              ? 'Converting…'
              : convertState === 'done'
                ? 'Converted'
                : plan
                  ? 'Cancel'
                  : 'Convert to MLX…'}
          </button>
        )}
        {format === 'unsupported' &&
          (model.baseModel ? (
            <button
              title={`Convert ${model.baseModel}, the safetensors model this was quantized from`}
              onClick={() => {
                setPlanError(undefined)
                void rpc<ConvertPlan>('getConvertPlan', { repo: model.baseModel })
                  .then(setPlan)
                  .catch((e: Error) => setPlanError(e.message))
              }}
            >
              Convert the source instead…
            </button>
          ) : (
            <button disabled>Unsupported</button>
          ))}
      </div>
    </div>
  )
}
