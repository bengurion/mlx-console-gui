import { useEffect, useState } from 'react'
import { rpc, onPush, copy } from '../api'
import { bytes } from '../format'
import type { MetricsSnapshot, ModelProfile, ProcessGpuPush } from '../../../src/shared/protocol'

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

      {/*
        Per-core, because the average hides the shape of the work. Prompt
        prefill saturates every core; token generation is memory-bound and
        often pins one or two while the rest idle — which averages to a number
        that looks like nothing is running.
      */}
      {m?.cpu.perCore && m.cpu.perCore.length > 1 && (
        <div className="row" style={{ gap: 2, marginBottom: 6 }} title="Per-core utilisation">
          {m.cpu.perCore.map((pct, i) => (
            <div
              key={i}
              title={`Core ${i}: ${pct.toFixed(0)}%`}
              style={{
                flex: 1,
                height: 18,
                minWidth: 3,
                background: 'rgba(128,128,128,0.25)',
                borderRadius: 2,
                display: 'flex',
                alignItems: 'flex-end',
              }}
            >
              <div
                style={{
                  width: '100%',
                  height: `${Math.max(2, Math.min(100, pct))}%`,
                  background:
                    pct > 80
                      ? 'var(--vscode-editorWarning-foreground)'
                      : 'var(--vscode-charts-blue, #3794ff)',
                  borderRadius: 2,
                }}
              />
            </div>
          ))}
        </div>
      )}

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
        Max single buffer {bytes(gpu?.maxBufferBytes)} · unified memory {bytes(gpu?.memoryBytes)}
      </div>
      {/*
        `Alloc system memory` routinely exceeds installed RAM, which made
        "driver allocated" read as an impossible figure. It counts address
        space rather than pages: allocations mapped but not resident, the same
        pages counted once per client that maps them, and purgeable ranges
        whose backing has already been reclaimed. Labelled for what it is, and
        the caveat is shown exactly when the number would otherwise look wrong.
      */}
      <div className="small muted">
        GPU address space {bytes(gpu?.allocatedBytes)}
        {gpu?.allocatedBytes && gpu.memoryBytes && gpu.allocatedBytes > gpu.memoryBytes
          ? ' — more than the machine has, because this counts mappings and reserved ranges, not resident pages'
          : ''}
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

      {/* Prompt-cache and concurrency sizing moved to the settings view: they
          are values you set, not measurements. What they are sized against is
          still measured here. */}

      <div className="divider" />
      <ModelProfileCard />

      <div className="divider" />
      <PerProcessGpu serverPid={m?.process?.pid} />
    </div>
  )
}

/**
 * The two sizing controls, for the settings view.
 *
 * They live with the settings rather than the metrics because each one writes
 * a value; the numbers they quote come from the same live snapshot either way.
 */
export function TuningAdvice() {
  const [m, setM] = useState<MetricsSnapshot>()
  useEffect(() => onPush<MetricsSnapshot>('metrics', setM), [])
  useEffect(() => {
    void rpc<MetricsSnapshot>('getMetrics').then(setM).catch(() => undefined)
  }, [])

  return (
    <div className="card col">
      <strong>Memory tuning</strong>
      <div className="small muted">
        Sized against live headroom. Both are advisory — the input accepts any value, including
        one this machine cannot hold.
      </div>
      <div className="divider" />
      <PromptCacheAdvice m={m} />
      <div className="divider" />
      <ConcurrencyAdvice m={m} />
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
  const [needsAuth, setNeedsAuth] = useState(false)
  const [enabled, setEnabled] = useState<boolean>()
  const [secret, setSecret] = useState('')
  const [updatedAt, setUpdatedAt] = useState<number>()
  const [command, setCommand] = useState<string>()
  const [power, setPower] = useState<ProcessGpuPush['power']>()

  // Once authorised the host samples on a timer and pushes the result, so this
  // stays live without the view asking for anything.
  useEffect(
    () =>
      onPush<ProcessGpuPush>('processGpu', (p) => {
        setEnabled(p.enabled)
        if (p.samples) setSamples(p.samples)
        if (p.power) setPower(p.power)
        setUpdatedAt(p.at)
        setError(p.error)
      }),
    [],
  )

  useEffect(() => {
    void rpc<{ enabled: boolean; command: string }>('rootGpuStatus')
      .then((r) => {
        setEnabled(r.enabled)
        setCommand(r.command)
      })
      .catch(() => undefined)
  }, [])

  async function sample() {
    setBusy(true)
    setError(undefined)
    setNeedsAuth(false)
    try {
      const res = (await rpc('samplePerProcessGpu')) as {
        ok: boolean
        samples?: ProcessGpuSample[]
        error?: string
        needsAuth?: boolean
      }
      if (res.ok) setSamples(res.samples ?? [])
      else if (res.needsAuth) setNeedsAuth(true)
      else setError(res.error ?? 'Sampling failed.')
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Authorise once, then poll.
   *
   * The credential is sent to the local host, used to install a rule covering
   * exactly this one read-only command, and dropped. It is never stored here
   * either — the field is cleared whatever the outcome.
   */
  async function authorise() {
    setBusy(true)
    setError(undefined)
    try {
      const res = (await rpc('enableRootGpu', { secret })) as { ok: boolean; error?: string }
      if (res.ok) {
        setEnabled(true)
        setNeedsAuth(false)
      } else setError(res.error ?? 'Could not authorise sampling.')
    } catch (e) {
      setError(String(e))
    } finally {
      setSecret('')
      setBusy(false)
    }
  }

  async function revoke() {
    setBusy(true)
    try {
      const res = (await rpc('disableRootGpu', { secret })) as { ok: boolean; error?: string }
      if (res.ok) setEnabled(false)
      else setError(res.error ?? 'Could not remove the rule.')
    } finally {
      setSecret('')
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
        <span className="row" style={{ gap: 8 }}>
          {enabled && (
            <span className="small muted">
              auto, every 20s
              {updatedAt ? ` · ${new Date(updatedAt).toLocaleTimeString()}` : ''}
            </span>
          )}
          <a onClick={() => void sample()}>{busy ? 'Working…' : 'Sample now'}</a>
          {enabled && <a onClick={() => void revoke()}>Revoke</a>}
        </span>
      </div>

      {/* Prompt whenever authorisation is what is missing — including after a
          sample came back needing it, not only on a cold start. */}
      {(enabled === false || needsAuth) && (
        <div className="col" style={{ gap: 4 }}>
          <div className="small muted">
            Figures above are device-wide (IOAccelerator). Attributing GPU time to a process needs{' '}
            <code>powermetrics</code>, which requires root.
          </div>
          <div className="small muted">
            Authorise once and it samples automatically every 20 seconds. Your password is used
            here only to permit that single read-only command, and is not stored — see{' '}
            <code>rootAccess.ts</code> for exactly what is granted.
          </div>
          <div className="row" style={{ gap: 6 }}>
            <input
              type="password"
              placeholder="Account password"
              value={secret}
              autoComplete="off"
              onChange={(e) => setSecret(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && secret) void authorise()
              }}
              style={{ maxWidth: 260 }}
            />
            <button disabled={busy || !secret} onClick={() => void authorise()}>
              {busy ? 'Authorising…' : 'Authorise'}
            </button>
          </div>
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

      {/* Device power from the same privileged run: the figure that says what
          the GPU is costing, rather than how busy it looks. */}
      {power && (
        <div className="small" style={{ marginTop: 4 }}>
          {power.milliwatts !== undefined && <>GPU draw {(power.milliwatts / 1000).toFixed(2)} W</>}
          {power.frequencyMhz !== undefined && <> · {power.frequencyMhz} MHz</>}
          {power.idleResidencyPercent !== undefined && (
            <> · idle {power.idleResidencyPercent.toFixed(1)}%</>
          )}
        </div>
      )}

      {samples !== undefined && (
        <div className="small muted" style={{ marginTop: 4 }}>
          Attribution is GPU <em>time</em>; the memory figures stay device-wide because macOS
          keeps no per-process GPU memory accounting at any privilege level. Not a limitation
          of this sampler — there is no API that reports it.
        </div>
      )}

      {/* Secondary: the same command to run yourself, for anyone who would
          rather not type a password into an app — which is a reasonable
          preference, not a fallback for failure. */}
      {needsAuth && <RootCommand command={command} />}

      {error && (
        <div className="small" style={{ color: 'var(--vscode-errorForeground, #f85149)' }}>
          {error}
        </div>
      )}
    </div>
  )
}

/**
 * When the host cannot open a terminal — the headless daemon has none — hand
 * over the exact command instead of failing silently. It is read-only
 * telemetry, and short enough to read before running.
 */
function RootCommand({ command }: { command?: string }) {
  if (!command) return null
  return (
    <div className="col" style={{ gap: 4, marginTop: 4 }}>
      <div className="small">Run this yourself, then sample again:</div>
      <pre className="snippet">{command}</pre>
      <div className="row">
        <button className="secondary" onClick={() => copy(command)}>
          Copy command
        </button>
      </div>
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
