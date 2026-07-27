import { useEffect, useState } from 'react'
import { rpc, onPush, copy } from '../api'
import { Code } from './Code'
import { ClaudeCodeCard } from './ClaudeCode'
import type { ExternalClientsInfo, ServerStatusLite } from '../../../src/shared/protocol'

/**
 * How to connect something to this server.
 *
 * Instructions only — no settings. The port, LAN exposure and API key are
 * configured in the settings view; repeating them here would mean two places
 * to change the same value and two chances to disagree about it. What belongs
 * here is what to paste where, generated from the live base URL and model so
 * it is correct rather than illustrative.
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
        <div className="small muted">
          An ordinary OpenAI-compatible API. Anything that speaks it can use this server.
        </div>
        <div className="row spread">
          <code className="small">{ext.cleanUrl ?? ext.baseUrl}</code>
          <a onClick={() => copy(ext.cleanUrl ?? ext.baseUrl)}>Copy</a>
        </div>
        {ext.cleanUrl ? (
          /* The snippets below use this one, so say why it differs from the
             server's own port before someone "corrects" it. */
          <div className="small muted">
            This is the filtered endpoint. It forwards to <code>{ext.baseUrl}</code> and strips the
            harmony channels gpt-oss models emit, so the answer arrives without the model's
            reasoning in front of it. The raw server stays available on its own port.
          </div>
        ) : (
          <div className="small muted">
            Using a gpt-oss model? Enable <code>cleanEndpoint</code> in Settings — otherwise
            clients receive the model's reasoning channel as part of every answer.
          </div>
        )}
        <div className="small muted">
          {ext.hasApiKey
            ? 'An API key is configured — clients must send it as a bearer token.'
            : 'No API key required. Most clients insist on sending one anyway; any non-empty value works.'}
          {ext.exposeToLan && ' Reachable from your network, not just this machine.'}
        </div>
        {ext.activeModel && (
          <div className="small muted">
            Model id to use: <code>{ext.activeModel}</code>
          </div>
        )}
      </div>

      <ClaudeCodeCard />

      <Snippet
        title="VS Code — without this extension"
        note="Nothing about reaching the server from an editor depends on this extension being installed."
        text={ext.snippets.vscode}
      />

      <Snippet
        title="VS Code — GitHub Copilot (BYOK)"
        note="Uses the built-in model picker. Needs a Copilot Business or Enterprise seat."
        text={ext.snippets.copilot}
      />

      <Snippet title="opencode" text={ext.snippets.opencode} />

      <Snippet
        title="Anything else"
        note="Check the server is answering before blaming the client."
        text={ext.snippets.curl}
      />

      <Snippet
        title="When a correct configuration looks broken"
        note="Three things that produce misleading failures. All three were hit for real."
        text={ext.snippets.gotchas}
      />
    </div>
  )
}

function Snippet({ title, note, text }: { title: string; note?: string; text: string }) {
  return (
    <div className="card col">
      <div className="row spread">
        <strong>{title}</strong>
        <a onClick={() => copy(text)}>Copy</a>
      </div>
      {note && <div className="small muted">{note}</div>}
      {/* Highlighted, since these are meant to be read before they are copied.
          Copy still takes the plain text. */}
      <Code text={text} />
    </div>
  )
}
