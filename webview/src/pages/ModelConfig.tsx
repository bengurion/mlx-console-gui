import { useEffect, useState } from 'react'
import { rpc } from '../api'
import { bytes } from '../format'
import type { ModelConfigView } from '../../../src/shared/protocol'

/**
 * Generation settings for one model, edited with the model.
 *
 * These belong here rather than in a global list because they are properties
 * of a model, not of the app: a 120B reasoning model and a 7B coder want
 * different temperatures, and expressing that as a global default plus mental
 * arithmetic is how people end up with the wrong sampler.
 *
 * Each field shows where its current value comes from. Leaving one empty is a
 * real state — it falls back to the model's own recommendation — so an empty
 * box is never the same as typing the number that happens to be shown.
 */

const FIELDS: { key: string; label: string; hint: string; step?: string }[] = [
  { key: 'temperature', label: 'Temperature', hint: 'Lower is more deterministic.', step: '0.05' },
  { key: 'topP', label: 'Top-p', hint: '1.0 disables nucleus sampling.', step: '0.05' },
  { key: 'topK', label: 'Top-k', hint: '0 disables it.', step: '1' },
  { key: 'minP', label: 'Min-p', hint: '0 disables it.', step: '0.01' },
  { key: 'repetitionPenalty', label: 'Repetition penalty', hint: '1.0 disables it.', step: '0.05' },
  { key: 'maxTokens', label: 'Max tokens', hint: 'Cap on one response.', step: '256' },
]

export function ModelConfig({ repo }: { repo: string }) {
  const [config, setConfig] = useState<ModelConfigView>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    void rpc<ModelConfigView>('getModelConfig', { repo })
      .then(setConfig)
      .catch((e) => setError(String(e)))
  }, [repo])

  async function save(key: string, raw: string) {
    setError(undefined)
    const value = raw.trim() === '' ? undefined : Number(raw)
    if (value !== undefined && !Number.isFinite(value)) return setError(`${key} must be a number.`)
    const res = (await rpc('setModelConfig', { repo, patch: { [key]: value } }).catch((e) => ({
      ok: false,
      error: String(e),
    }))) as { ok: boolean; config?: ModelConfigView; error?: string }
    if (res.ok && res.config) setConfig(res.config)
    else setError(res.error ?? 'Could not save.')
  }

  if (error && !config) return <div className="small" style={{ color: 'var(--vscode-errorForeground)' }}>{error}</div>
  if (!config) return <div className="small muted">Reading model configuration…</div>

  const modelFacts = [
    config.contextWindow && `${config.contextWindow.toLocaleString()} token window`,
    config.kvBytesPerToken && `${bytes(config.kvBytesPerToken)}/token KV`,
    config.weightBytes && `${bytes(config.weightBytes)} weights`,
    config.vocabSize && `vocab ${config.vocabSize.toLocaleString()}`,
  ].filter(Boolean)

  return (
    <div className="col" style={{ gap: 6, marginTop: 6 }}>
      {modelFacts.length > 0 ? (
        <div className="small muted">{modelFacts.join(' · ')} — read from the model's own files.</div>
      ) : (
        /* Silence here used to read as "this model has no context window",
           when it means the files were not found — almost always because the
           model sits in a different cache than the configured models
           directory. Say which. */
        <div className="small muted">
          No <code>config.json</code> found for this model under the configured models directory,
          so its context window and KV cost are unknown. The settings below still apply.
        </div>
      )}

      <div className="small muted">
        Empty means “use what the model recommends”. Anything you type here applies to this model
        only.
      </div>

      {FIELDS.map((f) => {
        const override = config.override[f.key]
        const fromModel = config.fromModel[f.key]
        const source =
          override !== undefined
            ? 'set for this model'
            : fromModel !== undefined
              ? "the model's own default"
              : 'the global default'
        return (
          <div key={f.key} className="row spread" style={{ gap: 8 }}>
            <label className="small" style={{ flex: '1 1 auto', minWidth: 0 }}>
              <div>{f.label}</div>
              <div className="muted small">
                {config.effective[f.key] ?? '—'} · from {source}. {f.hint}
              </div>
            </label>
            <input
              type="number"
              step={f.step}
              defaultValue={override ?? ''}
              placeholder={String(fromModel ?? config.global[f.key] ?? '')}
              onBlur={(e) => void save(f.key, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              style={{ width: 110, minWidth: 0 }}
            />
          </div>
        )
      })}

      {Object.keys(config.override).length > 0 && (
        <div className="row">
          <button
            className="secondary"
            onClick={() =>
              void rpc('setModelConfig', {
                repo,
                patch: Object.fromEntries(Object.keys(config.override).map((k) => [k, undefined])),
              }).then(() => rpc<ModelConfigView>('getModelConfig', { repo }).then(setConfig))
            }
          >
            Clear this model's overrides
          </button>
        </div>
      )}

      {error && <div className="small" style={{ color: 'var(--vscode-errorForeground)' }}>{error}</div>}
    </div>
  )
}
