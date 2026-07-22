import { useEffect, useState } from 'react'
import { rpc, onPush, copy } from '../api'
import { InlineSetting } from './InlineSetting'
import type { ExternalClientsInfo, ServerStatusLite } from '../../../src/shared/protocol'

/**
 * Connecting other tools to this server.
 *
 * Its own view because it is a task you do once per tool and then forget,
 * rather than something to scroll past whenever you check on the server. The
 * snippets are generated host-side from the live base URL and active model, so
 * what you copy is what is actually running.
 */
export function ClientsPage() {
  const [ext, setExt] = useState<ExternalClientsInfo>()
  const [server, setServer] = useState<ServerStatusLite>()

  const refresh = () =>
    void rpc<ExternalClientsInfo>('getExternalClients').then(setExt).catch(() => undefined)

  useEffect(() => onPush<ServerStatusLite>('serverStatus', setServer), [])
  useEffect(refresh, [])
  // The base URL and model appear in the snippets, so regenerate when they move.
  useEffect(() => {
    if (server) refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.advertisedBaseUrl, server?.activeModel, server?.exposeToLan])

  if (!ext) return <div className="card small muted">Loading…</div>

  return (
    <div className="col">
      <div className="card col">
        <strong>Endpoint</strong>
        <div className="small muted">Point OpenAI-compatible tools at this local server.</div>
        <div className="row spread">
          <code className="small">{ext.baseUrl}</code>
          <a onClick={() => copy(ext.baseUrl)}>Copy</a>
        </div>
        <InlineSetting short="server.exposeToLan" />
        <InlineSetting short="server.port" />
        <InlineSetting short="server.apiKey" />
        {ext.hasApiKey ? (
          <div className="small muted">
            An API key is configured; clients must send it as a bearer token.
          </div>
        ) : (
          <div className="small muted">
            No API key set — any non-empty key is accepted, which most clients insist on sending.
          </div>
        )}
      </div>

      <div className="card col">
        <div className="row spread">
          <strong>opencode</strong>
          <a onClick={() => copy(ext.snippets.opencode)}>Copy config</a>
        </div>
        <pre className="snippet">{ext.snippets.opencode}</pre>
      </div>

      <div className="card col">
        <div className="row spread">
          <strong>GitHub Copilot (BYOK)</strong>
          <a onClick={() => copy(ext.snippets.copilot)}>Copy steps</a>
        </div>
        <pre className="snippet">{ext.snippets.copilot}</pre>
      </div>
    </div>
  )
}
