import { useEffect, useState } from 'react'
import { rpc, onPush } from '../api'
import { bytes } from '../format'
import type { MetricsSnapshot, ModelProfile } from '../../../src/shared/protocol'

/** A labelled bar. `max` of 0/undefined renders the label only. */
function Bar({
  label,
  value,
  max,
  detail,
  tone,
}: {
  label: string
  value?: number
  max?: number
  detail?: string
  tone?: 'warn' | 'bad'
}) {
  const pct = value !== undefined && max ? Math.min(100, (value / max) * 100) : undefined
  const color =
    tone === 'bad'
      ? 'var(--vscode-errorForeground, #f85149)'
      : tone === 'warn'
        ? 'var(--vscode-editorWarning-foreground, #d29922)'
        : 'var(--vscode-charts-blue, #3794ff)'

  return (
    <div style={{ marginBottom: 6 }}>
      <div className="row spread small">
        <span className="muted">{label}</span>
        <span>{detail ?? (pct !== undefined ? `${pct.toFixed(0)}%` : '—')}</span>
      </div>
      <div
        style={{
          height: 4,
          borderRadius: 2,
          background: 'var(--vscode-editorWidget-border, #444)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct ?? 0}%`,
            height: '100%',
            background: color,
            transition: 'width 300ms linear',
          }}
        />
      </div>
    </div>
  )
}

/**
 * Live CPU / memory / GPU metrics.
 *
 * GPU numbers come from the IOAccelerator performance statistics, which are
 * readable without sudo. `powermetrics` would give more detail but needs root,
 * so per-process GPU attribution is not available — the GPU figures are
 * device-wide, not just this server.
 */
export function MetricsPage() {
  const [m, setM] = useState<MetricsSnapshot>()

  useEffect(() => onPush<MetricsSnapshot>('metrics', setM), [])
  useEffect(() => {
    void rpc<MetricsSnapshot>('getMetrics').then(setM).catch(() => undefined)
  }, [])

  const gpu = m?.gpu
  // The real allocation ceiling Metal reports, which is what a model must fit
  // inside — not the 75%-of-RAM heuristic used for rough fit estimates.
  const ceiling = m?.wiredLimitBytes ?? gpu?.maxRecommendedWorkingSetBytes
  // ioreg's in-use figure only counts what the GPU has mapped right now; an
  // idle resident model reads near zero. occupiedBytes is the honest number.
  const inUse = m?.occupiedBytes ?? gpu?.inUseBytes
  const gpuMapped = gpu?.inUseBytes
  const nearCeiling = inUse !== undefined && ceiling ? inUse / ceiling : undefined

  async function editCeiling() {
    const currentMb = ceiling ? Math.round(ceiling / (1024 * 1024)) : 0
    const answer = window.prompt(
      'GPU wired memory limit in MB (0 = system default).\n' +
        'Raising this lets larger models load, but leaving too little for macOS ' +
        'can cause heavy swapping. Resets on reboot.',
      String(currentMb),
    )
    if (answer === null) return
    const megabytes = Number(answer.trim())
    if (!Number.isFinite(megabytes) || megabytes < 0) return
    await rpc('setWiredLimit', { megabytes }).catch(() => undefined)
  }

  return (
    <div className="card col">
      <div className="row spread">
        <strong>Metrics</strong>
        <span className="badge">{gpu?.deviceName ?? 'system'}</span>
      </div>

      <Bar
        label={`CPU (${m?.cpu.cores ?? '—'} cores)`}
        value={m?.cpu.percent}
        max={100}
        detail={m?.cpu.percent !== undefined ? `${m.cpu.percent.toFixed(0)}%` : '—'}
      />

      {m?.memory && (
        <Bar
          label="Memory"
          value={m.memory.usedBytes}
          max={m.memory.totalBytes}
          detail={`${bytes(m.memory.usedBytes)} / ${bytes(m.memory.totalBytes)}`}
          tone={m.memory.usedBytes / m.memory.totalBytes > 0.9 ? 'warn' : undefined}
        />
      )}
      {m?.memory && (
        <div className="small muted" style={{ marginTop: -2, marginBottom: 6 }}>
          wired {bytes(m.memory.wiredBytes)} · active {bytes(m.memory.activeBytes)} · compressed{' '}
          {bytes(m.memory.compressedBytes)} · free {bytes(m.memory.freeBytes)}
        </div>
      )}

      <Bar label="GPU" value={gpu?.utilizationPercent} max={100} />

      <div className="divider" />
      <div className="row spread">
        <strong className="small">GPU memory</strong>
        <a onClick={editCeiling}>Edit limit</a>
      </div>

      <Bar
        label="In use"
        value={inUse}
        max={ceiling}
        detail={`${bytes(inUse)}${ceiling ? ` / ${bytes(ceiling)}` : ''}`}
        tone={nearCeiling !== undefined && nearCeiling > 0.9 ? 'bad' : nearCeiling !== undefined && nearCeiling > 0.75 ? 'warn' : undefined}
      />

      <div className="small muted">
        {m?.wiredLimitBytes ? (
          <>
            Ceiling {bytes(m.wiredLimitBytes)} — set explicitly via{' '}
            <code>iogpu.wired_limit_mb</code>.
          </>
        ) : (
          <>
            Ceiling {bytes(gpu?.maxRecommendedWorkingSetBytes)} — the system default
            (max recommended working set). No explicit <code>iogpu.wired_limit_mb</code> is set.
          </>
        )}
      </div>
      {gpuMapped !== undefined && inUse !== undefined && inUse - gpuMapped > 1024 ** 3 && (
        <div className="small muted">
          Of that, {bytes(gpuMapped)} is mapped by the GPU right now — the rest is held by
          the server process but idle. On unified memory both come from the same pool.
        </div>
      )}
      <div className="small muted">
        Driver allocated {bytes(gpu?.allocatedBytes)} · max single buffer{' '}
        {bytes(gpu?.maxBufferBytes)} · unified memory {bytes(gpu?.memoryBytes)}
      </div>

      {m?.process && (
        <>
          <div className="divider" />
          <div className="small">
            <strong>mlx_lm.server</strong> (pid {m.process.pid}) — RSS {bytes(m.process.rssBytes)},{' '}
            {m.process.cpuPercent.toFixed(0)}% CPU
          </div>
        </>
      )}

      <div className="divider" />
      <PromptCacheAdvice m={m} />

      <div className="divider" />
      <ConcurrencyAdvice m={m} />

      <div className="divider" />
      <ModelProfileCard />

      <div className="divider" />
      <PerProcessGpu serverPid={m?.process?.pid} />
    </div>
  )
}

interface ProcessGpuSample {
  name: string
  pid: number
  gpuMsPerS: number
}

/**
 * Opt-in per-process GPU attribution.
 *
 * Device-wide figures come from IOAccelerator and need no privileges. Only
 * `powermetrics` attributes GPU *time* to a process, and it requires root —
 * so this is an explicit, on-demand action rather than part of the poll loop.
 */
function PerProcessGpu({ serverPid }: { serverPid?: number }) {
  const [samples, setSamples] = useState<ProcessGpuSample[]>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function sample() {
    setBusy(true)
    setError(undefined)
    try {
      const res = (await rpc('samplePerProcessGpu')) as {
        ok: boolean
        samples?: ProcessGpuSample[]
        error?: string
        needsAuth?: boolean
      }
      if (res.ok) setSamples(res.samples ?? [])
      else if (!res.needsAuth) setError(res.error ?? 'Sampling failed.')
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const top = (samples ?? [])
    .filter((s) => s.gpuMsPerS > 0)
    .sort((a, b) => b.gpuMsPerS - a.gpuMsPerS)
    .slice(0, 5)

  return (
    <div>
      <div className="row spread">
        <strong className="small">Per-process GPU</strong>
        <a onClick={() => void sample()}>{busy ? 'Sampling…' : 'Sample (needs root)'}</a>
      </div>

      {samples === undefined && !error && (
        <div className="small muted">
          Figures above are device-wide (IOAccelerator). Attributing GPU time to a process
          requires <code>sudo powermetrics</code>; you enter your own password in a terminal.
        </div>
      )}

      {top.length > 0 && (
        <div className="small" style={{ marginTop: 4 }}>
          {top.map((s) => (
            <div key={s.pid} className="row spread">
              <span className={s.pid === serverPid ? undefined : 'muted'}>
                {s.name}
                {s.pid === serverPid ? ' (MLX server)' : ''}
              </span>
              <span>{s.gpuMsPerS.toFixed(0)} ms/s</span>
            </div>
          ))}
        </div>
      )}
      {samples !== undefined && top.length === 0 && !error && (
        <div className="small muted">No process reported GPU time in that sample.</div>
      )}

      {samples !== undefined && (
        <div className="small muted" style={{ marginTop: 4 }}>
          GPU <em>time</em> only — macOS has no per-process GPU memory accounting at any
          privilege level, so the memory figures above stay device-wide.
        </div>
      )}

      {error && (
        <div className="small" style={{ color: 'var(--vscode-errorForeground, #f85149)' }}>
          {error}
        </div>
      )}
    </div>
  )
}

/**
 * Live sizing advice for the KV prompt cache.
 *
 * The recommendation is advisory and never enforced: the input accepts any
 * value, including one larger than the machine can hold. Over-committing is a
 * legitimate choice — it is just shown for what it is.
 */
function PromptCacheAdvice({ m }: { m?: MetricsSnapshot }) {
  const advice = m?.promptCache
  const [draftGb, setDraftGb] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string>()

  if (!advice) return null

  const configured = advice.configuredBytes
  const recommended = advice.recommendedBytes
  const headroom = advice.headroomBytes

  async function apply(valueBytes: number) {
    setBusy(true)
    setNote(undefined)
    try {
      const res = (await rpc('updateSetting', {
        key: 'mlxConsole.server.promptCacheBytes',
        value: valueBytes,
      })) as { ok: boolean; error?: string }
      setNote(res.ok ? 'Saved — restart the server to apply.' : (res.error ?? 'Failed.'))
    } catch (e) {
      setNote(String(e))
    } finally {
      setBusy(false)
    }
  }

  // Only a warning, never a block: the user may deliberately over-commit.
  const overHeadroom =
    headroom !== undefined && configured > 0 && configured > headroom

  return (
    <div>
      <div className="row spread">
        <strong className="small">KV prompt cache</strong>
        <a onClick={() => void rpc('unloadModel').catch(() => undefined)}>Clear &amp; reload</a>
        {recommended !== undefined && (
          <a onClick={() => void apply(recommended)} style={{ marginLeft: 8 }}>
            {busy ? 'Saving…' : `Use ${bytes(recommended)}`}
          </a>
        )}
      </div>

      <div className="small">
        Configured:{' '}
        <strong>{configured > 0 ? bytes(configured) : 'unbounded (server default)'}</strong>
        {recommended !== undefined && <> · recommended {bytes(recommended)}</>}
        {headroom !== undefined && <> · headroom {bytes(headroom)}</>}
      </div>

      <div className="small muted">{advice.reason}</div>

      {configured === 0 && (
        <div className="small muted">
          Unbounded means mlx_lm.server trims only by entry count (10 caches), so long
          conversations can grow into whatever the model leaves free.
        </div>
      )}

      {overHeadroom && (
        <div className="small" style={{ color: 'var(--vscode-editorWarning-foreground, #d29922)' }}>
          Configured cache exceeds current headroom — a long context may push the model out of
          memory. Allowed, but expect swapping.
        </div>
      )}

      <div className="row" style={{ gap: 6, marginTop: 4 }}>
        <input
          type="number"
          min={0}
          step={1}
          placeholder="GB (0 = unbounded)"
          value={draftGb}
          onChange={(e) => setDraftGb(e.target.value)}
          style={{ flex: 1 }}
        />
        <button
          className="secondary"
          disabled={busy || draftGb.trim() === ''}
          onClick={() => {
            const gb = Number(draftGb)
            if (Number.isFinite(gb) && gb >= 0) void apply(Math.floor(gb * 1024 ** 3))
          }}
        >
          Set
        </button>
      </div>
      {note && <div className="small muted">{note}</div>}
    </div>
  )
}

/**
 * Sizing advice for `decodeConcurrency`.
 *
 * The server default (32) is built for a shared inference host: each parallel
 * sequence keeps its own KV cache, so on a single-user machine with a large
 * model it is wildly over-provisioned.
 */
function ConcurrencyAdvice({ m }: { m?: MetricsSnapshot }) {
  const c = m?.concurrency
  if (!c) return null

  const effective = c.configured > 0 ? c.configured : c.serverDefault
  const risky = c.recommended !== undefined && effective > c.recommended

  return (
    <div>
      <div className="row spread">
        <strong className="small">Decode concurrency</strong>
        {c.recommended !== undefined && (
          <a
            onClick={() =>
              void rpc('updateSetting', {
                key: 'mlxConsole.server.decodeConcurrency',
                value: c.recommended,
              }).catch(() => undefined)
            }
          >
            Use {c.recommended}
          </a>
        )}
      </div>
      <div className="small">
        In effect: <strong>{effective}</strong>
        {c.configured === 0 && ' (server default)'}
        {c.recommended !== undefined && <> · recommended {c.recommended}</>}
        {c.perSequenceBytes !== undefined && <> · {bytes(c.perSequenceBytes)} per sequence</>}
      </div>
      <div className="small muted">{c.reason}</div>
      {risky && (
        <div className="small" style={{ color: 'var(--vscode-editorWarning-foreground, #d29922)' }}>
          {effective} parallel sequences would need up to{' '}
          {bytes((c.perSequenceBytes ?? 0) * effective)} of KV cache. Allowed, but a burst of
          concurrent requests can exhaust memory.
        </div>
      )}
    </div>
  )
}

/**
 * What the extension read from the active model's own files.
 *
 * Pushed by the host whenever the resident model changes, so this needs no
 * action from the user — it simply reflects the model in memory.
 */
function ModelProfileCard() {
  const [p, setP] = useState<ModelProfile>()
  useEffect(() => onPush<ModelProfile>('modelProfile', setP), [])

  if (!p) return null

  const gen = p.generation ? Object.entries(p.generation) : []

  return (
    <div>
      <div className="row spread">
        <strong className="small">From the model</strong>
        <span className="small muted">{p.modelId.split('/').pop()}</span>
      </div>

      <div className="small">
        {p.contextWindow !== undefined && <>context {p.contextWindow.toLocaleString()} tokens</>}
        {p.kvBytesPerToken !== undefined && <> · KV {bytes(p.kvBytesPerToken)}/token</>}
        {p.weightBytes !== undefined && <> · weights {bytes(p.weightBytes)}</>}
        {p.vocabSize !== undefined && <> · vocab {p.vocabSize.toLocaleString()}</>}
      </div>

      <div className="small muted">
        {gen.length
          ? `Sampling from the model: ${gen.map(([k, v]) => `${k} ${v}`).join(', ')}`
          : 'The model ships no sampling defaults — extension defaults apply.'}
      </div>

      <div className="small" style={{ marginTop: 4 }}>
        <strong>Speculative decoding:</strong>{' '}
        {p.draft.configured ? p.draft.configured : 'off'}
      </div>
      <div className="small muted">{p.draft.reason}</div>
      {p.draft.modelId && p.draft.modelId !== p.draft.configured && (
        <a
          className="small"
          onClick={() =>
            void rpc('updateSetting', {
              key: 'mlxConsole.server.draftModel',
              value: p.draft.modelId,
            }).catch(() => undefined)
          }
        >
          Use {p.draft.modelId}
        </a>
      )}
    </div>
  )
}
