import { useEffect, useState } from 'react'
import { onPush, rpc } from '../api'
import type { SetupDetection, SetupProgress } from '../../../src/shared/protocol'

const GB = 1024 ** 3

type Phase = 'idle' | 'installing' | 'done' | 'error'

/**
 * First-run onboarding for the desktop app.
 *
 * One decision — where everything lives — then one button. Anything the
 * machine already has (the extension's venv, a configured models directory)
 * is offered for adoption rather than rebuilt: a venv is minutes of pip, but
 * a models directory can be hundreds of gigabytes.
 */
export function SetupPage() {
  const [detected, setDetected] = useState<SetupDetection>()
  const [root, setRoot] = useState<string>()
  const [adoptVenv, setAdoptVenv] = useState(true)
  const [adoptModels, setAdoptModels] = useState(true)
  const [phase, setPhase] = useState<Phase>('idle')
  const [lines, setLines] = useState<string[]>([])
  const [error, setError] = useState<string>()

  useEffect(() => {
    void rpc<SetupDetection>('setupDetect').then((d) => {
      setDetected(d)
      setRoot((r) => r ?? d.defaultRoot)
    })
    return onPush<SetupProgress>('setupProgress', (p) =>
      setLines((prev) => [...prev, p.message]),
    )
  }, [])

  async function pick() {
    const chosen = await rpc<string | undefined>('setupPickRoot')
    if (chosen) setRoot(chosen)
  }

  async function install() {
    if (!root) return
    setPhase('installing')
    setError(undefined)
    setLines([])
    try {
      const r = await rpc<{ ok: boolean; error?: string }>('setupInstall', {
        root,
        adoptVenv: adoptVenv ? detected?.existingVenv : undefined,
        adoptModelsDir: adoptModels ? detected?.existingModelsDir : undefined,
      })
      if (r.ok) {
        setPhase('done')
        setLines((prev) => [...prev, 'Install complete — opening the dashboard…'])
      } else {
        setPhase('error')
        setError(r.error ?? 'Install failed. See the lines above.')
      }
    } catch (e) {
      setPhase('error')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (!detected) return <div className="card small muted">Looking at this machine…</div>

  const busy = phase === 'installing'
  return (
    <div className="col" style={{ maxWidth: 640, margin: '0 auto' }}>
      <div className="card col">
        <h2>Welcome to MLX Console</h2>
        <div className="small muted">
          Pick a folder to install into. Everything lives there — the Python environment,
          downloaded models, settings and logs — so moving or removing MLX Console later means
          moving or removing that one folder.
        </div>

        <div className="row spread" style={{ alignItems: 'center' }}>
          <code className="small">{root}</code>
          <button className="secondary" disabled={busy} onClick={() => void pick()}>
            Choose Folder…
          </button>
        </div>

        {detected.freeBytes !== undefined && (
          <div className="small muted">
            {(detected.freeBytes / GB).toFixed(0)} GB free on this volume. Models are large —
            a single 8-bit 70B model is ~70 GB.
          </div>
        )}

        {!detected.python && (
          <div className="card small" style={{ borderLeft: '3px solid var(--vscode-editorError-foreground,#f14c4c)' }}>
            No Python 3 was found. Install it first (for example <code>brew install python</code>),
            then reopen MLX Console.
          </div>
        )}
        {detected.python && (
          <div className="small muted">Using {detected.python.version} at {detected.python.path}.</div>
        )}

        {detected.existingVenv && (
          <label className="small">
            <input
              type="checkbox"
              checked={adoptVenv}
              disabled={busy}
              onChange={(e) => setAdoptVenv(e.currentTarget.checked)}
            />{' '}
            Keep using the existing mlx-lm environment at <code>{detected.existingVenv}</code>{' '}
            instead of installing a fresh one
          </label>
        )}
        {detected.existingModelsDir && (
          <label className="small">
            <input
              type="checkbox"
              checked={adoptModels}
              disabled={busy}
              onChange={(e) => setAdoptModels(e.currentTarget.checked)}
            />{' '}
            Keep models where they are, in <code>{detected.existingModelsDir}</code>
          </label>
        )}

        <div className="row">
          <button disabled={busy || !root || !detected.python} onClick={() => void install()}>
            {busy ? 'Installing…' : phase === 'error' ? 'Retry Install' : 'Install'}
          </button>
        </div>

        {lines.length > 0 && (
          <pre className="small" style={{ maxHeight: 200, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
            {lines.join('\n')}
          </pre>
        )}
        {error && (
          <div className="card small" style={{ borderLeft: '3px solid var(--vscode-editorError-foreground,#f14c4c)' }}>
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
