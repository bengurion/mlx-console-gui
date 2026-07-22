import { useEffect, useState } from 'react'
import { rpc, onPush, copy, openSettings } from '../api'
import { SettingsPage } from './Settings'
import type {
  EnvStatusLite,
  ExternalClientsInfo,
  ServerStatusLite,
} from '../../../src/shared/protocol'

export function ServerPage() {
  const [server, setServer] = useState<ServerStatusLite>()
  const [env, setEnv] = useState<EnvStatusLite>()
  const [ext, setExt] = useState<ExternalClientsInfo>()
  const [busy, setBusy] = useState(false)

  useEffect(() => onPush<ServerStatusLite>('serverStatus', setServer), [])
  useEffect(() => onPush<EnvStatusLite>('envStatus', setEnv), [])
  useEffect(() => {
    void rpc<ServerStatusLite>('getServerStatus').then(setServer)
    void rpc<EnvStatusLite>('getEnvStatus').then(setEnv)
    refreshExternal()
  }, [])
  // Refresh snippets whenever the server status changes (base URL / active model).
  useEffect(() => {
    if (server) refreshExternal()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.advertisedBaseUrl, server?.activeModel, server?.exposeToLan])

  function refreshExternal() {
    void rpc<ExternalClientsInfo>('getExternalClients').then(setExt).catch(() => undefined)
  }

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
    <div className="col">
      {/* Environment */}
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
      </div>

      {/* Storage */}
      <div className="card col">
        <strong>Storage</strong>
        <div className="row spread small">
          <span className="muted">Models download dir</span>
          <a onClick={() => openSettings('mlxConsole.modelsDir')}>Change</a>
        </div>
        <code className="small">{env?.modelsDir ?? '…'}</code>
        <div className="row spread small">
          <span className="muted">Python env (mlx-lm)</span>
          <a onClick={() => openSettings('mlxConsole.venvPath')}>Change</a>
        </div>
        <code className="small">{env?.venvPath ?? '(run setup)'}</code>
      </div>

      {/* Server */}
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

      {/* All settings */}
      <SettingsPage />

      {/* Metrics moved to the Dashboard view, where the measurements live. */}

      {/* External clients */}
      {ext && (
        <div className="card col">
          <strong>External clients</strong>
          <div className="small muted">
            Point OpenAI-compatible tools at this local server.
          </div>
          <div className="row spread">
            <code className="small">{ext.baseUrl}</code>
            <a onClick={() => copy(ext.baseUrl)}>Copy</a>
          </div>
          <div className="small">
            LAN exposure: <strong>{ext.exposeToLan ? 'on' : 'off'}</strong>{' '}
            <a onClick={() => openSettings('mlxConsole.server.exposeToLan')}>Configure</a>
          </div>

          <div className="divider" />
          <div className="row spread">
            <strong className="small">opencode</strong>
            <a onClick={() => copy(ext.snippets.opencode)}>Copy config</a>
          </div>
          <pre className="snippet">{ext.snippets.opencode}</pre>

          <div className="row spread">
            <strong className="small">GitHub Copilot (BYOK)</strong>
            <a onClick={() => copy(ext.snippets.copilot)}>Copy steps</a>
          </div>
          <pre className="snippet">{ext.snippets.copilot}</pre>
        </div>
      )}

    </div>
  )
}

/**
 * Weight residency, which is distinct from server state: `mlx_lm.server` keeps
 * exactly one model live and loads it lazily during the first request that
 * names it. There is no idle timeout — it stays until displaced or the process
 * stops — so the UI explains both the stall and the stickiness.
 */
function ModelResidency({ server }: { server?: ServerStatusLite }) {
  const [elapsed, setElapsed] = useState(0)
  const loading = server?.modelState === 'loading'
  const startedAt = server?.loadStartedAt

  useEffect(() => {
    if (!loading || !startedAt) return
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [loading, startedAt])

  if (!server || server.state !== 'ready') return null

  if (loading) {
    return (
      <div className="small" style={{ marginTop: 4 }}>
        <strong>Loading weights… {elapsed}s</strong>
        <div className="muted">
          The server reads the model during the first request, so the reply starts only once this
          finishes. Large models take minutes.
        </div>
      </div>
    )
  }

  if (server.modelState === 'loaded' && server.loadedModel) {
    return (
      <div className="small" style={{ marginTop: 4 }}>
        <strong>In memory:</strong> {server.loadedModel}
        {server.lastLoadSeconds !== undefined && ` (loaded in ${server.lastLoadSeconds}s)`}
        <div className="muted">
          Stays resident until you pick another model or stop the server — there is no idle
          timeout. Switching drops these weights and loads the new ones.
        </div>
      </div>
    )
  }

  return (
    <div className="small muted" style={{ marginTop: 4 }}>
      No weights loaded yet — the first request loads the selected model.
    </div>
  )
}
