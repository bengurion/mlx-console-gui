import { useEffect, useState } from 'react'
import { rpc, onPush } from '../api'
import { InlineSetting } from './InlineSetting'
import type { EnvStatusLite, ServerStatusLite } from '../../../src/shared/protocol'

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
  const [busy, setBusy] = useState(false)

  useEffect(() => onPush<ServerStatusLite>('serverStatus', setServer), [])
  useEffect(() => onPush<EnvStatusLite>('envStatus', setEnv), [])
  useEffect(() => {
    void rpc<ServerStatusLite>('getServerStatus').then(setServer).catch(() => undefined)
    void rpc<EnvStatusLite>('getEnvStatus').then(setEnv).catch(() => undefined)
  }, [])

  const call = async (method: Parameters<typeof rpc>[0]) => {
    setBusy(true)
    try {
      await rpc(method)
    } finally {
      setBusy(false)
    }
  }

  const running = server?.state === 'ready' || server?.state === 'starting'

  return (
    <>
      <div className="card col">
        <div className="row spread">
          <strong>Server</strong>
          <span className="badge">{server?.state ?? 'stopped'}</span>
        </div>
        {server?.activeModel && <div className="small muted">Model: {server.activeModel}</div>}
        {server?.detail && <div className="small muted">{server.detail}</div>}
        <ModelResidency server={server} />
        <div className="row wrap">
          {running ? (
            <button className="secondary" disabled={busy} onClick={() => call('stopServer')}>
              Stop
            </button>
          ) : (
            <button disabled={busy} onClick={() => call('startServer')}>
              Start
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
        {/* Editable here rather than a link elsewhere: the path in use is shown
            above the field that sets it, so you can see what an empty value
            resolves to. */}
        <div className="small muted">In use: <code>{env?.modelsDir ?? '…'}</code></div>
        <InlineSetting short="modelsDir" />
        <div className="small muted">In use: <code>{env?.venvPath ?? '(run setup)'}</code></div>
        <InlineSetting short="venvPath" />
        <InlineSetting short="pythonPath" />
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
