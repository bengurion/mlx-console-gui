import { useEffect, useState } from 'react'
import { rpc, onPush } from '../api'
import { bytes, relativeDate, shortRepo } from '../format'
import { ModelConfig } from './ModelConfig'
import type { EnvStatusLite, LocalModel, ServerStatusLite } from '../../../src/shared/protocol'

export function ModelsPage() {
  const [models, setModels] = useState<LocalModel[]>([])
  const [server, setServer] = useState<ServerStatusLite>()
  const [env, setEnv] = useState<EnvStatusLite>()
  const [busy, setBusy] = useState<string>()
  const [configuring, setConfiguring] = useState<string>()
  const [error, setError] = useState<string>()

  useEffect(() => onPush<LocalModel[]>('models', setModels), [])
  useEffect(() => onPush<ServerStatusLite>('serverStatus', setServer), [])
  useEffect(() => onPush<EnvStatusLite>('envStatus', setEnv), [])
  useEffect(() => {
    void refresh()
  }, [])

  async function refresh() {
    try {
      setModels(await rpc<LocalModel[]>('listModels'))
    } catch (e) {
      setError(msg(e))
    }
  }

  /** Run an RPC with busy state and visible error reporting (never swallow failures). */
  async function act(repo: string, method: 'launchModel' | 'deleteModel' | 'setDefaultModel') {
    setBusy(repo)
    setError(undefined)
    try {
      await rpc(method, { repo })
    } catch (e) {
      setError(msg(e))
    } finally {
      setBusy(undefined)
    }
  }

  if (env && !env.ready) {
    return (
      <div className="empty col">
        <div className="muted">{env.message}</div>
        {env.platformOk ? (
          <button onClick={() => rpc('runSetup').catch((e) => setError(msg(e)))}>Run setup</button>
        ) : (
          <div className="small muted">MLX requires macOS on Apple Silicon.</div>
        )}
      </div>
    )
  }

  return (
    <div className="col">
      {error && (
        <div className="card small" style={{ color: 'var(--vscode-errorForeground)' }}>
          ⚠️ {error}
        </div>
      )}

      {models.length > 0 && (
        <div className="row spread small muted">
          <span>
            {models.length} model{models.length === 1 ? '' : 's'} ·{' '}
            {bytes(models.reduce((sum, m) => sum + m.sizeBytes, 0))} on disk
          </span>
          <a onClick={() => void refresh()}>Refresh</a>
        </div>
      )}

      {models.length === 0 ? (
        <div className="empty muted col" style={{ alignItems: 'center', gap: 8 }}>
          <div>No models downloaded yet.</div>
          {window.__MLX_SHOW__ ? (
            <button onClick={() => window.__MLX_SHOW__?.('search')}>Search Hugging Face</button>
          ) : (
            <div className="small">Use the Search view to add one.</div>
          )}
        </div>
      ) : (
        <div className="grid-cards">
        {models.map((m) => {
          const active = server?.activeModel === m.repo
          const working = busy === m.repo
          // Launching a model that is already resident would drop its weights
          // and reload them — minutes of work for no change. Only offer it when
          // the model is not already loaded or mid-load.
          const loaded = server?.modelState === 'loaded' && server.loadedModel === m.repo
          const loading = server?.modelState === 'loading' && active
          // A load in progress anywhere blocks every launch button: the server
          // holds one model, so a second load would queue behind the first and
          // then displace it — minutes of work to end up somewhere unexpected.
          const otherLoading = server?.modelState === 'loading' && !active
          const willDisplace = Boolean(server?.loadedModel) && !loaded
          const launchLabel = working
            ? 'Working…'
            : loading
              ? 'Loading…'
              : loaded
                ? 'Resident'
                : otherLoading
                  ? 'Wait…'
                  : willDisplace
                    ? 'Switch to this'
                    : 'Launch'
          return (
            <div key={m.repo} className={`card col${active ? ' active' : ''}`}>
              <div className="row spread">
                {/* A converted model has no repo id — its path is its name. */}
                <strong
                  title={m.repo}
                  style={{
                    fontSize: '1.05em',
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {m.local ? shortRepo(m.repo) : m.repo}
                </strong>
                <span className="row">
                  {m.local && <span className="badge">converted</span>}
                  {active && (
                    <span
                      className="pill"
                      style={{
                        color: 'var(--viz-good, #0ca30c)',
                        background: 'color-mix(in srgb, var(--viz-good, #0ca30c) 12%, transparent)',
                      }}
                    >
                      ● active
                    </span>
                  )}
                </span>
              </div>
              <div className="row wrap small" style={{ gap: 10 }}>
                <strong>{bytes(m.sizeBytes)}</strong>
                <span className="muted">{m.nbFiles} files</span>
                {m.lastModified && <span className="muted">{relativeDate(m.lastModified)}</span>}
              </div>
              <div className="row wrap">
                <button
                  disabled={working || loaded || loading || otherLoading}
                  title={
                    loaded
                      ? 'Already resident — loading it again would re-read the same weights.'
                      : loading
                        ? 'Weights are being read into memory.'
                        : otherLoading
                          ? `Waiting for ${server?.activeModel ?? 'another model'} to finish loading.`
                          : willDisplace
                            ? `Loads this model, dropping ${server?.loadedModel} from memory.`
                            : 'Starts the server if needed, then loads this model.'
                  }
                  onClick={() => act(m.repo, 'launchModel')}
                >
                  {launchLabel}
                </button>
                <button
                  className="secondary"
                  disabled={working}
                  onClick={() => act(m.repo, 'setDefaultModel')}
                >
                  Set default
                </button>
                <button
                  className="secondary"
                  onClick={() => setConfiguring((c) => (c === m.repo ? undefined : m.repo))}
                >
                  {configuring === m.repo ? 'Hide settings' : 'Settings'}
                </button>
                {/* Destructive, so quiet: a link at the far edge rather than a
                    button shoulder-to-shoulder with Launch. */}
                <a
                  className="danger small"
                  style={{ marginLeft: 'auto', opacity: working ? 0.5 : undefined }}
                  title={`Delete ${m.repo} from disk`}
                  onClick={() => !working && act(m.repo, 'deleteModel')}
                >
                  Delete
                </a>
              </div>

              {/* Per-model generation settings live with the model, since that
                  is what they belong to. */}
              {configuring === m.repo && <ModelConfig repo={m.repo} />}
            </div>
          )
        })}
        </div>
      )}
    </div>
  )
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
