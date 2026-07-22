import { useEffect, useMemo, useState } from 'react'
import { onPush, rpc, copy } from '../api'
import { bytes } from '../format'
import type { MetricsSnapshot, ModelProfile, ServerStatusLite } from '../../../src/shared/protocol'

/**
 * Local impact: what running this model is costing the machine.
 *
 * The other views answer "is it working". This one answers "what did it take",
 * which on unified memory is a different and harder question. Three ideas
 * shape it:
 *
 *  1. **The budget is one pool.** Weights, KV cache, the desktop and every
 *     other app draw from the same memory, and GPU memory is wired — macOS
 *     cannot page it out to make room. So the headline is a budget, not a
 *     utilisation percentage.
 *  2. **Pressure, not utilisation, is the harm signal.** A pinned GPU is a
 *     machine doing its job. Swap-outs while a model is resident are a machine
 *     being squeezed. Those are shown separately and weighted differently.
 *  3. **What is measured is distinguished from what is inferred.** macOS
 *     exposes no per-process GPU memory accounting at any privilege level, so
 *     "held by others" is arithmetic, and says so.
 */

type Sample = { at: number; occupied?: number; swapOut?: number; gpu?: number }
const HISTORY = 90 // ~3 minutes at the 2s sample rate

export function ImpactPage() {
  const [m, setMetrics] = useState<MetricsSnapshot>()
  const [status, setStatus] = useState<ServerStatusLite>()
  const [profile, setProfile] = useState<ModelProfile>()
  const [history, setHistory] = useState<Sample[]>([])
  const [gpuProcs, setGpuProcs] = useState<{ name: string; pid: number; gpuMsPerS: number }[]>()
  const [gpuError, setGpuError] = useState<string>()
  const [sampling, setSampling] = useState(false)

  useEffect(
    () =>
      onPush<MetricsSnapshot>('metrics', (next) => {
        setMetrics(next)
        setHistory((h) =>
          [
            ...h,
            {
              at: next.at,
              occupied: next.occupiedBytes,
              swapOut: next.paging?.swapOutBytesPerSec,
              gpu: next.gpu.utilizationPercent,
            },
          ].slice(-HISTORY),
        )
      }),
    [],
  )
  useEffect(() => onPush<ServerStatusLite>('serverStatus', setStatus), [])
  useEffect(() => onPush<ModelProfile>('modelProfile', setProfile), [])

  const ceiling = m?.wiredLimitBytes ?? m?.gpu.maxRecommendedWorkingSetBytes
  const held = m?.occupiedBytes ?? 0
  const total = m?.memory?.totalBytes

  /**
   * The budget, in the order it gets spent.
   *
   * "Others" is everything committed that is not the server: derived by
   * subtraction because the OS will not attribute GPU memory per process.
   */
  const budget = useMemo(() => {
    if (!m?.memory || !ceiling) return undefined
    const others = Math.max(0, m.memory.usedBytes - held)
    const free = Math.max(0, ceiling - held - others)
    return { model: held, others, free, ceiling }
  }, [m, ceiling, held])

  const swapping = (m?.paging?.swapOutBytesPerSec ?? 0) > 0
  const swapUsed = m?.swap?.usedBytes ?? 0

  const requestGpuAttribution = async () => {
    setSampling(true)
    setGpuError(undefined)
    try {
      const res = await rpc<{
        ok: boolean
        samples?: { name: string; pid: number; gpuMsPerS: number }[]
        error?: string
        needsAuth?: boolean
      }>('samplePerProcessGpu')
      if (res.ok) setGpuProcs(res.samples ?? [])
      else if (res.needsAuth) setGpuError('needs-auth')
      else setGpuError(res.error ?? 'Sampling failed.')
    } catch (e) {
      setGpuError(e instanceof Error ? e.message : String(e))
    } finally {
      setSampling(false)
    }
  }

  return (
    <div className="col">
      <VerdictCard
        swapping={swapping}
        swapUsed={swapUsed}
        held={held}
        ceiling={ceiling}
        model={status?.loadedModel}
      />

      <div className="card col">
        <strong>Unified memory budget</strong>
        <div className="small muted">
          One pool for CPU and GPU. Wired memory cannot be paged out, so anything the model takes
          is taken from everything else.
        </div>
        {budget ? (
          <>
            <StackedBar
              parts={[
                { label: 'model', bytes: budget.model, color: 'var(--vscode-charts-blue, #3794ff)' },
                { label: 'other apps', bytes: budget.others, color: 'var(--vscode-badge-background)' },
                { label: 'free', bytes: budget.free, color: 'transparent' },
              ]}
              total={budget.ceiling}
            />
            <div className="row wrap" style={{ gap: 16, marginTop: 4 }}>
              <Figure label="Held by the server" value={bytes(budget.model)} measured />
              <Figure label="Held by everything else" value={bytes(budget.others)} />
              <Figure label="Headroom left" value={bytes(budget.free)} />
              <Figure
                label="Usable ceiling"
                value={bytes(budget.ceiling)}
                note={
                  m?.wiredLimitBytes
                    ? 'iogpu.wired_limit_mb'
                    : 'Metal max_recommended_working_set_size'
                }
                measured
              />
              {total && <Figure label="Installed memory" value={bytes(total)} measured />}
            </div>
            <div className="small muted" style={{ marginTop: 4 }}>
              “Held by everything else” is inferred by subtraction — macOS exposes no per-process
              GPU memory accounting at any privilege level.
            </div>
          </>
        ) : (
          <div className="small muted">Waiting for the first sample…</div>
        )}
      </div>

      <PressureCard metrics={m} />

      {profile && <ContextCostCard profile={profile} headroom={budget?.free} />}

      <div className="card col">
        <div className="row spread">
          <strong>Per-process GPU</strong>
          <button disabled={sampling} onClick={requestGpuAttribution}>
            {sampling ? 'Sampling…' : gpuProcs ? 'Sample again' : 'Enable with root'}
          </button>
        </div>
        <div className="small muted">
          <code>powermetrics</code> attributes GPU <em>time</em> per process and needs root. It is
          read-only telemetry; the command runs in a terminal so you type your own password, and
          nothing here ever sees it.
        </div>

        {gpuError === 'needs-auth' && <RootFallback />}
        {gpuError && gpuError !== 'needs-auth' && (
          <div className="small" style={{ color: 'var(--vscode-errorForeground)' }}>
            {gpuError}
          </div>
        )}

        {gpuProcs &&
          (gpuProcs.length ? (
            <table style={{ width: '100%', fontSize: '0.9em', marginTop: 6 }}>
              <tbody>
                {gpuProcs
                  .slice()
                  .sort((a, b) => b.gpuMsPerS - a.gpuMsPerS)
                  .slice(0, 12)
                  .map((p) => (
                    <tr key={p.pid}>
                      <td>{p.name}</td>
                      <td className="muted" style={{ width: 70 }}>
                        {p.pid}
                      </td>
                      <td style={{ width: 110, textAlign: 'right' }}>
                        {p.gpuMsPerS.toFixed(1)} ms/s
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : (
            <div className="small muted">No process used the GPU during the sample.</div>
          ))}

        <div className="small muted">
          GPU <em>time</em> only. There is no per-process GPU <em>memory</em> figure to be had on
          macOS, at any privilege level — which is why the budget above infers it.
        </div>
      </div>

      <TrendCard history={history} ceiling={ceiling} />
    </div>
  )
}

/** The one-line answer, in the terms that matter. */
function VerdictCard(props: {
  swapping: boolean
  swapUsed: number
  held: number
  ceiling?: number
  model?: string
}) {
  const { swapping, swapUsed, held, ceiling, model } = props
  const share = ceiling ? held / ceiling : 0

  const verdict = swapping
    ? { text: 'Swapping while a model is resident — the machine is being squeezed.', tone: 'bad' }
    : share > 0.9
      ? { text: 'Very little headroom left. Another app asking for memory will hurt.', tone: 'warn' }
      : swapUsed > 2 * 1024 ** 3
        ? { text: 'Not swapping now, but swap is already in use from earlier pressure.', tone: 'warn' }
        : held > 0
          ? { text: 'Comfortable. The model fits with room to spare.', tone: 'ok' }
          : { text: 'Nothing resident — no model is costing you anything.', tone: 'ok' }

  const color =
    verdict.tone === 'bad'
      ? 'var(--vscode-errorForeground)'
      : verdict.tone === 'warn'
        ? 'var(--vscode-editorWarning-foreground)'
        : 'var(--vscode-testing-iconPassed, #3fb950)'

  return (
    <div className="card col">
      <div className="row" style={{ gap: 8 }}>
        <span style={{ color, fontSize: '1.6em', lineHeight: 1 }}>●</span>
        <div className="col" style={{ gap: 2 }}>
          <strong>{verdict.text}</strong>
          <span className="small muted">
            {model ? `${model} resident` : 'no model resident'}
            {ceiling ? ` · ${bytes(held)} of ${bytes(ceiling)} (${Math.round(share * 100)}%)` : ''}
          </span>
        </div>
      </div>
    </div>
  )
}

/** Pressure: the difference between a busy machine and a suffering one. */
function PressureCard({ metrics }: { metrics?: MetricsSnapshot }) {
  const p = metrics?.paging
  const mem = metrics?.memory
  const rate = (n?: number) => (n === undefined ? 'measuring…' : n > 0 ? `${bytes(n)}/s` : 'none')

  return (
    <div className="card col">
      <strong>Memory pressure</strong>
      <div className="small muted">
        Utilisation says the machine is working. These say it is running out of room.
      </div>
      <div className="row wrap" style={{ gap: 16, marginTop: 4 }}>
        <Figure
          label="Swapping out"
          value={rate(p?.swapOutBytesPerSec)}
          alarm={(p?.swapOutBytesPerSec ?? 0) > 0}
          measured
        />
        <Figure label="Swapping in" value={rate(p?.swapInBytesPerSec)} measured />
        <Figure
          label="Swap in use"
          value={bytes(metrics?.swap?.usedBytes)}
          note={metrics?.swap ? `of ${bytes(metrics.swap.totalBytes)}` : undefined}
          measured
        />
        <Figure label="Compressed" value={bytes(mem?.compressedBytes)} measured />
        <Figure label="Wired" value={bytes(mem?.wiredBytes)} measured />
        <Figure label="GPU" value={`${metrics?.gpu.utilizationPercent ?? 0}%`} measured />
        <Figure label="CPU" value={`${Math.round(metrics?.cpu.percent ?? 0)}%`} measured />
      </div>
    </div>
  )
}

/** What context length actually costs, in this machine's remaining memory. */
function ContextCostCard({ profile, headroom }: { profile: ModelProfile; headroom?: number }) {
  const perToken = profile.kvBytesPerToken
  if (!perToken) return null

  const lengths = [8_192, 32_768, 65_536, 131_072].filter(
    (n) => !profile.contextWindow || n <= profile.contextWindow,
  )
  if (profile.contextWindow && !lengths.includes(profile.contextWindow)) {
    lengths.push(profile.contextWindow)
  }
  const affordable = headroom ? Math.floor(headroom / perToken) : undefined

  return (
    <div className="card col">
      <strong>What context costs</strong>
      <div className="small muted">
        KV cache is not in the model's file size. It grows with every token held, at{' '}
        {bytes(perToken)} per token for this model — derived from its attention shape, not guessed.
      </div>
      <table style={{ width: '100%', fontSize: '0.9em', marginTop: 4 }}>
        <tbody>
          {lengths.map((n) => {
            const cost = n * perToken
            const overBudget = headroom !== undefined && cost > headroom
            return (
              <tr key={n}>
                <td>{n.toLocaleString()} tokens</td>
                <td
                  style={{
                    textAlign: 'right',
                    color: overBudget ? 'var(--vscode-errorForeground)' : undefined,
                  }}
                >
                  {bytes(cost)}
                  {overBudget ? ' · over budget' : ''}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {affordable !== undefined && (
        <div className="small muted">
          Today's headroom pays for about {affordable.toLocaleString()} tokens of KV cache
          {profile.contextWindow && affordable < profile.contextWindow
            ? ` — less than this model's ${profile.contextWindow.toLocaleString()}-token window.`
            : '.'}
        </div>
      )}
    </div>
  )
}

/** A sparkline of the last few minutes: has it been getting worse? */
function TrendCard({ history, ceiling }: { history: Sample[]; ceiling?: number }) {
  if (history.length < 3) {
    return (
      <div className="card">
        <strong>Trend</strong>
        <div className="small muted">Collecting samples…</div>
      </div>
    )
  }
  const span = Math.max(1, history.length - 1)
  const path = (pick: (s: Sample) => number | undefined, max: number) =>
    history
      .map((s, i) => {
        const v = pick(s) ?? 0
        return `${(i / span) * 100},${30 - Math.min(1, v / (max || 1)) * 30}`
      })
      .join(' ')

  const peakSwap = Math.max(...history.map((s) => s.swapOut ?? 0), 1)

  return (
    <div className="card col">
      <strong>Last {Math.round((history.length * 2) / 60)} minutes</strong>
      <svg viewBox="0 0 100 30" preserveAspectRatio="none" style={{ width: '100%', height: 60 }}>
        <polyline
          points={path((s) => s.occupied, ceiling ?? 1)}
          fill="none"
          stroke="var(--vscode-charts-blue, #3794ff)"
          strokeWidth="0.8"
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          points={path((s) => s.swapOut, peakSwap)}
          fill="none"
          stroke="var(--vscode-errorForeground)"
          strokeWidth="0.8"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="small muted">
        <span style={{ color: 'var(--vscode-charts-blue, #3794ff)' }}>■</span> memory held against
        the ceiling · <span style={{ color: 'var(--vscode-errorForeground)' }}>■</span> swap-out
        rate (peak {bytes(peakSwap)}/s)
      </div>
    </div>
  )
}

/** When the host cannot elevate for you, hand over the exact command. */
function RootFallback() {
  const command =
    'sudo powermetrics --samplers gpu_power --show-process-gpu -n 1 -i 1000'
  return (
    <div className="col" style={{ gap: 4, marginTop: 4 }}>
      <div className="small">
        This host cannot open a terminal for you. Run it yourself — it is read-only, and you can
        read it before you run it:
      </div>
      <pre className="snippet">{command}</pre>
      <div className="row">
        <button className="secondary" onClick={() => copy(command)}>
          Copy command
        </button>
      </div>
    </div>
  )
}

function Figure(props: {
  label: string
  value: string
  note?: string
  measured?: boolean
  alarm?: boolean
}) {
  return (
    <div className="col" style={{ gap: 0, minWidth: 120 }}>
      <span
        style={{
          fontSize: '1.15em',
          color: props.alarm ? 'var(--vscode-errorForeground)' : undefined,
        }}
      >
        {props.value}
      </span>
      <span className="small muted">
        {props.label}
        {/* Say which numbers are read from the system and which are derived. */}
        {props.measured ? '' : ' (inferred)'}
      </span>
      {props.note && <span className="small muted">{props.note}</span>}
    </div>
  )
}

function StackedBar({
  parts,
  total,
}: {
  parts: { label: string; bytes: number; color: string }[]
  total: number
}) {
  return (
    <div
      className="bar"
      style={{ height: 14, display: 'flex', border: '1px solid var(--vscode-panel-border)' }}
    >
      {parts.map((p) => (
        <div
          key={p.label}
          title={`${p.label}: ${bytes(p.bytes)}`}
          style={{
            width: `${Math.max(0, Math.min(100, (p.bytes / total) * 100))}%`,
            background: p.color,
            height: '100%',
          }}
        />
      ))}
    </div>
  )
}
