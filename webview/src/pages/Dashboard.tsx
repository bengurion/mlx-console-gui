import { useEffect, useMemo, useState } from 'react'
import { onPush, rpc } from '../api'
import { bytes } from '../format'
import { CoreGrid, LineChart, PoolBar, RowBar } from '../charts'
import { MetricsPage } from './Metrics'
import { SystemStatus } from './SystemStatus'
import type {
  MetricsSnapshot,
  ModelProfile,
  ServerStatusLite,
  TopInfo,
} from '../../../src/shared/protocol'

/**
 * Local impact: what running this model is costing the machine — live.
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
 *     being squeezed. Those are charted separately and weighted differently.
 *  3. **The dashboard predicts, not just reports.** The occupancy trend is
 *     regressed live: if memory keeps growing at the current rate, it says
 *     when the ceiling arrives — before the swapping starts.
 */

type Sample = {
  at: number
  occupied?: number
  swapOut?: number
  swapIn?: number
  gpu?: number
  cpu?: number
}
const HISTORY = 300 // ~10 minutes at the 2s sample rate

/* ------------------------------------------------------------------------- *
 * The logic engine
 * ------------------------------------------------------------------------- */

/** Least-squares slope of occupancy, bytes per second, over the last window. */
function occupancySlope(history: Sample[], windowSamples = 45): number | undefined {
  const recent = history.slice(-windowSamples).filter((s) => s.occupied !== undefined)
  if (recent.length < 8) return undefined
  const t0 = recent[0].at
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  for (const s of recent) {
    const x = (s.at - t0) / 1000
    const y = s.occupied!
    sx += x; sy += y; sxx += x * x; sxy += x * y
  }
  const denom = recent.length * sxx - sx * sx
  if (denom === 0) return undefined
  return (recent.length * sxy - sx * sy) / denom
}

interface Verdict {
  tone: 'good' | 'warning' | 'serious' | 'critical'
  icon: string
  text: string
}

const TONE_COLOR: Record<Verdict['tone'], string> = {
  good: 'var(--viz-good)',
  warning: 'var(--viz-warn)',
  serious: 'var(--viz-serious)',
  critical: 'var(--viz-crit)',
}

interface Derived {
  verdict: Verdict
  /** Seconds until the ceiling at the current growth rate, when it is near. */
  etaSeconds?: number
  slope?: number
  affordableTokens?: number
  swappingNow: boolean
}

function derive(args: {
  history: Sample[]
  metrics?: MetricsSnapshot
  budget?: { model: number; others: number; free: number; ceiling: number }
  profile?: ModelProfile
  status?: ServerStatusLite
}): Derived {
  const { history, metrics, budget, profile, status } = args
  const resident = status?.modelState === 'loaded' && Boolean(status.loadedModel)
  const share = budget ? (budget.model + budget.others) / budget.ceiling : 0

  // Sustained, not instantaneous: one swap-out sample is housekeeping, three
  // in the last ten is a machine genuinely out of room.
  const recentOut = history.slice(-10).filter((s) => (s.swapOut ?? 0) > 0).length
  const swappingNow = recentOut >= 3 && (history.at(-1)?.swapOut ?? 0) > 0

  const slope = occupancySlope(history)
  let etaSeconds: number | undefined
  if (slope !== undefined && slope > 1024 * 1024 && budget) {
    const eta = budget.free / slope
    if (eta > 0 && eta < 45 * 60) etaSeconds = eta
  }

  const affordableTokens =
    budget && profile?.kvBytesPerToken
      ? Math.max(0, Math.floor(budget.free / profile.kvBytesPerToken))
      : undefined

  const swapUsed = metrics?.swap?.usedBytes ?? 0

  /*
   * The in-between states matter most: mlx_lm.server loads weights lazily,
   * so right after "Launch" the honest-but-useless answer is "nothing
   * resident". Say what is actually happening instead.
   */
  const model = status?.activeModel?.split('/').pop() ?? status?.activeModel
  const loading = status?.modelState === 'loading'
  const pendingFirstRequest =
    status?.state === 'ready' && Boolean(status.activeModel) && status.modelState === 'none'

  const verdict: Verdict = swappingNow
    ? { tone: 'critical', icon: '✕', text: 'Swapping while a model is resident — the machine is being squeezed.' }
    : share > 0.92
      ? { tone: 'serious', icon: '▲', text: 'Almost no headroom left. The next allocation will hurt.' }
      : etaSeconds !== undefined && etaSeconds < 300
        ? { tone: 'serious', icon: '▲', text: `Memory is growing fast — ceiling in ~${formatEta(etaSeconds)} at this rate.` }
        : swapUsed > 2 * 1024 ** 3
          ? { tone: 'warning', icon: '△', text: 'Not swapping now, but swap already holds earlier pressure.' }
          : etaSeconds !== undefined && !loading
            ? { tone: 'warning', icon: '△', text: `Memory is trending up — ceiling in ~${formatEta(etaSeconds)} if it keeps this rate.` }
            : loading
              ? { tone: 'good', icon: '⟳', text: `Loading ${model} — weights are being read into memory.` }
              : pendingFirstRequest
                ? { tone: 'good', icon: '✓', text: `Server up — ${model} loads on its first request.` }
                : resident
                  ? { tone: 'good', icon: '✓', text: 'Comfortable. The model fits with room to spare.' }
                  : { tone: 'good', icon: '✓', text: 'Nothing resident — no model is costing you anything.' }

  return { verdict, etaSeconds, slope, affordableTokens, swappingNow }
}

function formatEta(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`
  return `${Math.round(seconds / 60)} min`
}

const clock = (t: number) =>
  new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/* ------------------------------------------------------------------------- *
 * The page
 * ------------------------------------------------------------------------- */

export function DashboardPage() {
  const [m, setMetrics] = useState<MetricsSnapshot>()
  const [status, setStatus] = useState<ServerStatusLite>()
  const [profile, setProfile] = useState<ModelProfile>()
  const [history, setHistory] = useState<Sample[]>([])
  const [top, setTop] = useState<TopInfo>()

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
              swapIn: next.paging?.swapInBytesPerSec,
              gpu: next.gpu.utilizationPercent,
              cpu: next.cpu.percent,
            },
          ].slice(-HISTORY),
        )
      }),
    [],
  )
  useEffect(() => onPush<ServerStatusLite>('serverStatus', setStatus), [])
  useEffect(() => onPush<ModelProfile>('modelProfile', setProfile), [])

  // Per-process memory: psutil-backed, polled gently — spawning Python every
  // two seconds would cost more than it tells.
  useEffect(() => {
    let live = true
    const ask = () => void rpc<TopInfo>('topProcesses').then((t) => live && setTop(t)).catch(() => undefined)
    ask()
    const timer = setInterval(ask, 15_000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])

  const ceiling = m?.wiredLimitBytes ?? m?.gpu.maxRecommendedWorkingSetBytes
  const held = m?.occupiedBytes ?? 0
  const total = m?.memory?.totalBytes

  /**
   * The budget, in the order it gets spent. "Others" is everything committed
   * that is not the server: derived by subtraction because the OS will not
   * attribute GPU memory per process.
   */
  const budget = useMemo(() => {
    if (!m?.memory || !ceiling) return undefined
    const others = Math.max(0, m.memory.usedBytes - held)
    const free = Math.max(0, ceiling - held - others)
    return { model: held, others, free, ceiling }
  }, [m, ceiling, held])

  const logic = useMemo(
    () => derive({ history, metrics: m, budget, profile, status }),
    [history, m, budget, profile, status],
  )

  const xs = history.map((s) => s.at)

  return (
    <div className="col">
      {/* -- the one-line answer, and the numbers behind it ---------------- */}
      <div className="card col">
        <div className="row" style={{ gap: 10 }}>
          <span
            aria-hidden
            style={{
              color: TONE_COLOR[logic.verdict.tone],
              fontSize: '1.4em',
              lineHeight: 1,
              fontWeight: 700,
            }}
          >
            {logic.verdict.icon}
          </span>
          <div className="col" style={{ gap: 2 }}>
            <strong>{logic.verdict.text}</strong>
            <span className="small muted">
              {status?.loadedModel
                ? `${status.loadedModel} resident`
                : status?.modelState === 'loading'
                  ? `${status.activeModel} loading…`
                  : status?.activeModel
                    ? `${status.activeModel} selected · nothing resident yet`
                    : 'no model resident'}
              {ceiling ? ` · ${bytes(held)} of ${bytes(ceiling)}` : ''}
            </span>
          </div>
        </div>
        <div className="row wrap" style={{ gap: 18, marginTop: 6 }}>
          <Stat label="of ceiling in use" value={budget ? `${Math.round(((budget.model + budget.others) / budget.ceiling) * 100)}%` : '—'} />
          <Stat label="headroom" value={bytes(budget?.free)} />
          <Stat
            label="context affordable now"
            value={logic.affordableTokens !== undefined ? `${compact(logic.affordableTokens)} tok` : '—'}
            note={profile?.kvBytesPerToken ? `${bytes(profile.kvBytesPerToken)}/token` : 'needs a resident model'}
          />
          <Stat label="GPU now" value={m ? `${m.gpu.utilizationPercent ?? 0}%` : '—'} />
          <Stat label="CPU now" value={m ? `${Math.round(m.cpu.percent ?? 0)}%` : '—'} />
          {logic.etaSeconds !== undefined && (
            <Stat
              label="to ceiling at this rate"
              value={`~${formatEta(logic.etaSeconds)}`}
              tone={logic.etaSeconds < 300 ? 'serious' : 'warning'}
              note={`growing ${bytes(logic.slope ?? 0)}/s`}
            />
          )}
        </div>
      </div>

      {/* -- live charts ---------------------------------------------------- */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))', gap: 12 }}>
        <div className="card col">
          <strong>Memory held</strong>
          <div className="small muted">Weights + KV cache against the wired ceiling.</div>
          <LineChart
            xs={xs}
            series={[{ name: 'held by the server', color: 'var(--viz-1)', points: history.map((s) => s.occupied) }]}
            area
            yMax={ceiling}
            yFormat={(v) => bytes(v)}
            xFormat={clock}
            threshold={ceiling ? { value: ceiling, label: `ceiling ${bytes(ceiling)}` } : undefined}
          />
        </div>

        <div className="card col">
          <strong>Compute</strong>
          <div className="small muted">Prefill saturates everything; decode pins a core or two.</div>
          <LineChart
            xs={xs}
            series={[
              { name: 'GPU', color: 'var(--viz-1)', points: history.map((s) => s.gpu) },
              { name: 'CPU', color: 'var(--viz-2)', points: history.map((s) => s.cpu) },
            ]}
            yMax={100}
            yFormat={(v) => `${Math.round(v)}%`}
            xFormat={clock}
          />
          {m?.cpu.perCore && m.cpu.perCore.length > 1 && (
            <>
              <CoreGrid perCore={m.cpu.perCore} />
              <div className="small muted">per core, live</div>
            </>
          )}
        </div>

        <div className="card col">
          <strong>Pressure</strong>
          <div className="small muted">
            Utilisation is the machine working; swap-outs are the machine running out of room.
          </div>
          <LineChart
            xs={xs}
            series={[
              { name: 'swap out', color: 'var(--viz-2)', points: history.map((s) => s.swapOut) },
              { name: 'swap in', color: 'var(--viz-3)', points: history.map((s) => s.swapIn) },
            ]}
            yFloor={64 * 1024 * 1024}
            yFormat={(v) => `${bytes(v)}/s`}
            xFormat={clock}
          />
          <div className="row wrap" style={{ gap: 18 }}>
            <Stat label="swap in use" value={bytes(m?.swap?.usedBytes)} note={m?.swap ? `of ${bytes(m.swap.totalBytes)}` : undefined} />
            <Stat label="compressed" value={bytes(m?.memory?.compressedBytes)} />
            <Stat label="wired" value={bytes(m?.memory?.wiredBytes)} />
          </div>
        </div>

        {profile?.kvBytesPerToken && (
          <div className="card col">
            <strong>What context costs</strong>
            <div className="small muted">
              KV cache is not in the file size: {bytes(profile.kvBytesPerToken)} per token held,
              from this model's attention shape.
            </div>
            <ContextCurve profile={profile} headroom={budget?.free} affordable={logic.affordableTokens} />
          </div>
        )}
      </div>

      {/* -- the pool ------------------------------------------------------- */}
      <div className="card col">
        <strong>Unified memory budget</strong>
        <div className="small muted">
          One pool for CPU and GPU. Wired memory cannot be paged out, so anything the model takes
          is taken from everything else.
        </div>
        {budget ? (
          <>
            <PoolBar
              parts={[
                { label: 'model', value: budget.model, color: 'var(--viz-1)' },
                { label: 'other apps (inferred)', value: budget.others, color: 'var(--viz-2)' },
                { label: 'headroom', value: budget.free },
              ]}
              total={budget.ceiling}
              format={bytes}
            />
            <div className="small muted">
              Ceiling {bytes(budget.ceiling)} (
              {m?.wiredLimitBytes ? 'iogpu.wired_limit_mb' : 'Metal max recommended working set'})
              {total ? ` of ${bytes(total)} installed` : ''}. “Other apps” is inferred by
              subtraction — macOS exposes no per-process GPU memory accounting at any privilege
              level.
            </div>
          </>
        ) : (
          <div className="small muted">Waiting for the first sample…</div>
        )}
      </div>

      {/* -- who is actually holding it ------------------------------------- */}
      {top && top.processes.length > 0 && (
        <div className="card col">
          <div className="row spread">
            <strong>Top memory consumers</strong>
            <span className="small muted">psutil · every 15s</span>
          </div>
          <div className="col small" style={{ gap: 4 }}>
            {top.processes.slice(0, 7).map((p) => (
              <RowBar
                key={p.pid}
                label={p.pid === m?.process?.pid ? `${p.name} (MLX server)` : p.name}
                value={p.rssBytes}
                max={top.processes[0]?.rssBytes ?? 1}
                text={bytes(p.rssBytes)}
                highlight={p.pid === m?.process?.pid}
              />
            ))}
          </div>
          {top.disk && (
            <div className="small muted">
              Models volume: {bytes(top.disk.freeBytes)} free of {bytes(top.disk.totalBytes)} —{' '}
              {top.disk.path}
            </div>
          )}
        </div>
      )}

      {/* Server, environment and storage: the state of the machine, which
          belongs beside the measurements rather than with the settings. */}
      <SystemStatus />

      {/* GPU memory detail, the ceiling editor, the model's own numbers and
          the privileged per-process GPU sampler. */}
      <MetricsPage />
    </div>
  )
}

/** KV cost curve: where the headroom line crosses it is the real context limit. */
function ContextCurve({
  profile,
  headroom,
  affordable,
}: {
  profile: ModelProfile
  headroom?: number
  affordable?: number
}) {
  const perToken = profile.kvBytesPerToken!
  const window = profile.contextWindow ?? 131_072
  const steps = 32
  const xs = Array.from({ length: steps + 1 }, (_, i) => Math.round((window * i) / steps))
  const cost = xs.map((n) => n * perToken)

  return (
    <>
      <LineChart
        xs={xs}
        series={[{ name: 'KV cache cost', color: 'var(--viz-1)', points: cost }]}
        area
        yFormat={bytes}
        xFormat={(x) => `${compact(x)} tok`}
        threshold={headroom !== undefined ? { value: headroom, label: `headroom ${bytes(headroom)}` } : undefined}
        marker={
          affordable !== undefined && affordable < window
            ? { x: affordable, label: `≈ ${compact(affordable)} tokens fit` }
            : undefined
        }
      />
      <div className="small muted">
        {affordable !== undefined && profile.contextWindow
          ? affordable >= profile.contextWindow
            ? `The full ${compact(profile.contextWindow)}-token window fits in today's headroom.`
            : `Today's headroom pays for ~${compact(affordable)} of this model's ${compact(profile.contextWindow)}-token window.`
          : 'Headroom unknown until the first sample.'}
      </div>
    </>
  )
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function Stat(props: { label: string; value?: string; note?: string; tone?: Verdict['tone'] }) {
  return (
    <div className="col" style={{ gap: 0, minWidth: 110 }}>
      <span
        style={{
          fontSize: '1.3em',
          fontWeight: 700,
          color: props.tone ? TONE_COLOR[props.tone] : undefined,
        }}
      >
        {props.value ?? '—'}
      </span>
      <span className="small muted" style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: '0.72em' }}>
        {props.label}
      </span>
      {props.note && <span className="small muted">{props.note}</span>}
    </div>
  )
}
