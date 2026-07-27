import { useEffect, useState } from 'react'
import { rpc, onPush, copy } from '../api'
import { Code } from './Code'
import type {
  ServerStatusLite,
  VsCodeIntegrationInfo,
  VsCodeIntegrationResult,
} from '../../../src/shared/protocol'

/**
 * Wire Claude Code to this server, from here.
 *
 * Claude Code is configured through `claudeCode.environmentVariables` in the
 * editor's own settings.json — a file none of this project's settings pages
 * touch. Getting five env vars exactly right by hand (the base URL must be an
 * origin without `/v1`, the model id must match a repo id character for
 * character, and forgetting the small-fast model 404s every subagent) proved
 * error-prone enough that the console now writes them itself, with a backup.
 */
export function ClaudeCodeCard() {
  const [info, setInfo] = useState<VsCodeIntegrationInfo>()
  const [server, setServer] = useState<ServerStatusLite>()
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [results, setResults] = useState<VsCodeIntegrationResult>()
  const [busy, setBusy] = useState(false)

  const refresh = () =>
    void rpc<VsCodeIntegrationInfo>('getVsCodeIntegration')
      .then((i) => {
        setInfo(i)
        // Default-check every installed, readable editor exactly once.
        setChecked((prev) =>
          Object.keys(prev).length
            ? prev
            : Object.fromEntries(
                i.editors.filter((e) => e.installed && !e.parseError).map((e) => [e.id, true]),
              ),
        )
      })
      .catch(() => undefined)

  useEffect(() => onPush<ServerStatusLite>('serverStatus', setServer), [])
  useEffect(refresh, [])
  // The written block carries the base URL and model, so track them live.
  useEffect(() => {
    if (server) refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.advertisedBaseUrl, server?.activeModel])

  if (!info) return null

  const installed = info.editors.filter((e) => e.installed)
  const chosen = installed.filter((e) => checked[e.id] && !e.parseError)
  const anyStale = installed.some((e) => e.staleKeys.length > 0)

  const apply = (what: { wire?: boolean; unwire?: boolean; cleanup?: boolean }) => {
    setBusy(true)
    setResults(undefined)
    void rpc<VsCodeIntegrationResult>('applyVsCodeIntegration', {
      editors: chosen.map((e) => e.id),
      ...what,
    })
      .then((r) => {
        setResults(r)
        refresh()
      })
      .catch(() => undefined)
      .finally(() => setBusy(false))
  }

  return (
    <div className="card col">
      <strong>Claude Code</strong>
      <div className="small muted">
        Claude Code speaks the Anthropic protocol, which the filtered endpoint serves at{' '}
        <code>/v1/messages</code>. Writing the settings below into an editor&apos;s
        settings.json points its Claude Code at this server — a timestamped backup is made
        first, and your other settings and comments are left alone.
      </div>
      <div className="small muted">
        <strong>This is a switch, not an extra model:</strong> while wired, Claude Code talks{' '}
        <em>only</em> to this server — Anthropic&apos;s own models are unavailable until you
        remove the wiring again. Entirely optional: for one-off sessions, use the terminal
        snippet below instead and your settings are never touched.
      </div>

      {!info.endpointRunning && (
        <div className="small">
          ⚠ The filtered endpoint is not running, and Claude Code cannot use the raw server.{' '}
          <a
            onClick={() =>
              void rpc('updateSetting', { key: 'mlxConsole.cleanEndpoint.enabled', value: true })
                .then(refresh)
                .catch(() => undefined)
            }
          >
            Enable it
          </a>{' '}
          (port {info.endpointPort}).
        </div>
      )}

      <Code
        text={info.env.map((e) => `${e.name} = ${e.value}`).join('\n')}
      />

      <div className="col">
        {installed.map((e) => (
          <label key={e.id} className="row" style={{ gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              disabled={Boolean(e.parseError)}
              checked={Boolean(checked[e.id]) && !e.parseError}
              onChange={(ev) => setChecked({ ...checked, [e.id]: ev.target.checked })}
            />
            <span>{e.label}</span>
            {e.wired && <span className="badge">wired</span>}
            {e.staleKeys.length > 0 && (
              <span className="badge">{e.staleKeys.length} stale key{e.staleKeys.length === 1 ? '' : 's'}</span>
            )}
            {e.parseError && <span className="small muted">{e.parseError} — fix it first</span>}
          </label>
        ))}
        {!installed.length && (
          <div className="small muted">No VS Code, Cursor, Insiders or VSCodium install found.</div>
        )}
      </div>

      <div className="row" style={{ gap: 8 }}>
        <button disabled={busy || !chosen.length} onClick={() => apply({ wire: true })}>
          Write Claude Code settings
        </button>
        {installed.some((e) => e.hasWiring) && (
          <button className="secondary" disabled={busy || !chosen.length} onClick={() => apply({ unwire: true })}>
            Remove wiring (back to Anthropic)
          </button>
        )}
        {anyStale && (
          <button className="secondary" disabled={busy || !chosen.length} onClick={() => apply({ cleanup: true })}>
            Clean up stale keys
          </button>
        )}
      </div>

      <div className="row spread">
        <span className="small muted">One-off session from a terminal — no settings written:</span>
        <a onClick={() => copy(info.snippet)}>Copy</a>
      </div>
      <Code text={info.snippet} />

      {results && (
        <div className="col small">
          {results.results.length === 0 && <div className="muted">Nothing written.</div>}
          {results.results.map((r) => {
            const editor = info.editors.find((e) => e.id === r.editor)
            return (
              <div key={r.editor}>
                {r.ok
                  ? r.changed
                    ? `✓ ${editor?.label ?? r.editor} updated — backup: ${r.backupPath ?? 'none (new file)'}`
                    : `✓ ${editor?.label ?? r.editor} already correct, nothing changed`
                  : `✗ ${editor?.label ?? r.editor}: ${r.error ?? 'failed'}`}
              </div>
            )
          })}
          <div className="muted">
            Reload the editor window (or restart Claude Code) to pick up the new environment.
          </div>
        </div>
      )}
    </div>
  )
}
