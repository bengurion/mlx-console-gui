import { useEffect, useState } from 'react'
import { rpc, onPush, openSettings } from '../api'
import type { EnvStatusLite, LocalModel, ServerStatusLite } from '../../../src/shared/protocol'

/**
 * Environment, storage and server control.
 *
 * These sit on the Dashboard rather than with the settings: they are the state
 * of the machine — what is installed, where the weights live, whether the
 * server is up — which is what you want in front of you alongside the
 * measurements. The settings view is for the values you tune.
 */
export function SystemStatus() {
  const [server, setServer] = useState<ServerStatusLite>()
  const [env, setEnv] = useState<EnvStatusLite>()
  const [models, setModels] = useState<LocalModel[]>([])
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => onPush<ServerStatusLite>('serverStatus', setServer), [])
  useEffect(() => onPush<EnvStatusLite>('envStatus', setEnv), [])
  useEffect(() => onPush<LocalModel[]>('models', setModels), [])
  useEffect(() => {
    void rpc<ServerStatusLite>('getServerStatus').then(setServer).catch(() => undefined)
    void rpc<EnvStatusLite>('getEnvStatus').then(setEnv).catch(() => undefined)
    void rpc<LocalModel[]>('listModels').then(setModels).catch(() => undefined)
  }, [])

  // Default the choice to whatever is already loaded or selected, so the
  // button describes the obvious action rather than an arbitrary first entry.
  useEffect(() => {
    if (choice) return
    const preferred = server?.loadedModel ?? server?.activeModel
    if (preferred && models.some((m) => m.repo === preferred)) setChoice(preferred)
    else if (models.length) setChoice(models[0].repo)
  }, [models, server?.loadedModel, server?.activeModel, choice])

  const call = async (method: Parameters<typeof rpc>[0]) => {
    setBusy(true)
    try {
      await rpc(method)
    } finally {
      setBusy(false)
    }
  }

  async function launch() {
    setBusy(true)
    try {
      await rpc('launchModel', { repo: choice })
    } finally {
      setBusy(false)
    }
  }

  const running = server?.state === 'ready' || server?.state === 'starting'
  const isResident = server?.modelState === 'loaded' && server.loadedModel === choice
  const loading = server?.modelState === 'loading'

  return (
    <>
      <div className="card col">
        <div className="row spread">
          <strong>Server</strong>
          <span className="badge">{server?.state ?? 'stopped'}</span>
        </div>
        {server?.detail && <div className="small muted">{server.detail}</div>}
        <ModelResidency server={server} />

        {/*
          Starting the server on its own leaves it idle — it loads nothing
          until a request names a model. So the choice is made here, and the
          button does both: start if needed, then load.
        */}
        <div className="row wrap" style={{ gap: 6 }}>
          <select
            value={choice}
            disabled={loading}
            onChange={(e) => setChoice(e.target.value)}
            style={{ flex: '1 1 220px', minWidth: 0 }}
          >
            {models.length === 0 && <option value="">No models downloaded</option>}
            {models.map((m) => (
              <option key={m.repo} value={m.repo}>
                {m.repo}
                {m.repo === server?.loadedModel ? ' — resident' : ''}
              </option>
            ))}
          </select>

          <button
            disabled={busy || loading || !choice || isResident}
            title={
              isResident
                ? 'Already resident — loading it again would re-read the same weights.'
                : server?.loadedModel
                  ? `Loads ${choice}, dropping ${server.loadedModel} from memory.`
                  : 'Starts the server if needed, then loads this model.'
            }
            onClick={() => void launch()}
          >
            {loading ? 'Loading…' : isResident ? 'Resident' : server?.loadedModel ? 'Switch' : 'Start & load'}
          </button>

          {running && (
            <button className="secondary" disabled={busy} onClick={() => call('stopServer')}>
              Stop
            </button>
          )}
          <button className="secondary" disabled={busy} onClick={() => call('restartServer')}>
            Restart
          </button>
        </div>
      </div>

      <div className="card col">
        <div className="row spread">
          <strong>Environment</strong>
          <span className="badge">{env?.ready ? 'ready' : 'setup needed'}</span>
        </div>
        <div className="small muted">{env?.message}</div>
        {/* env.message already names the mlx-lm version, so show the extension
            version here rather than repeating it. */}
        <div className="small muted">MLX Console {env?.extensionVersion ?? '…'}</div>
        {!env?.ready && env?.platformOk && (
          <button disabled={busy} onClick={() => call('runSetup')}>
            Install / update mlx-lm
          </button>
        )}

        <div className="divider" />

        <strong className="small">Storage</strong>
        {/* Read-only here. The Dashboard reports what is in use; changing it is
            the settings view's job, and Change takes you straight to the field
            rather than making you find it. */}
        <div className="row spread small">
          <span className="muted">Models download dir</span>
          <a onClick={() => openSettings('modelsDir')}>Change</a>
        </div>
        <code className="small">{env?.modelsDir ?? '…'}</code>
        <div className="row spread small">
          <span className="muted">Python env (mlx-lm)</span>
          <a onClick={() => openSettings('venvPath')}>Change</a>
        </div>
        <code className="small">{env?.venvPath ?? '(run setup)'}</code>
      </div>
    </>
  )
}

/**
 * Weight residency, which is distinct from server state: `mlx_lm.server` keeps
 * exactly one model live and loads it lazily during the first request that
 * names it. There is no idle timeout — it stays until displaced or the process
 * stops — so the UI explains both the stall and the stickiness.
 */
function ModelResidency({ server }: { server?: ServerStatusLite }) {
  const [now, setNow] = useState(Date.now())

  // Only tick while something is actually loading.
  useEffect(() => {
    if (server?.modelState !== 'loading') return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [server?.modelState])

  if (!server || server.state === 'stopped') return null

  if (server.modelState === 'loading') {
    const seconds = server.loadStartedAt ? Math.floor((now - server.loadStartedAt) / 1000) : 0
    return (
      <div className="small">
        Loading {server.activeModel ?? 'model'} — {seconds}s
        <div className="muted">
          Weights load inside the first request, so it will not answer until this finishes.
          {server.lastLoadSeconds ? ` Last load took ${Math.round(server.lastLoadSeconds)}s.` : ''}
        </div>
      </div>
    )
  }

  if (server.modelState === 'loaded' && server.loadedModel) {
    return (
      <div className="small">
        <strong>{server.loadedModel}</strong> is resident
        <div className="muted">
          It stays in memory until another model displaces it or the server stops — there is no
          idle timeout.
          {server.lastLoadSeconds
            ? ` Loading it took ${Math.round(server.lastLoadSeconds)}s.`
            : ''}
        </div>
      </div>
    )
  }

  return (
    <div className="small muted">
      No weights loaded yet — the first request loads the selected model.
    </div>
  )
}
