/**
 * Hand-rolled SVG charts for the dashboard. No chart library: the shapes are
 * simple, the bundle stays small, and every mark follows the same specs —
 * 2px lines, recessive hairline grid, a hover crosshair with a tooltip,
 * legends whenever two series share a plot, and series colors that come from
 * the validated --viz-* palette rather than the editor theme.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'

/** Measured element width, so charts get real pixel coordinates for text. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) setWidth(w)
    })
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}

export interface Series {
  name: string
  /** CSS color, normally var(--viz-N). */
  color: string
  points: (number | undefined)[]
}

export interface LineChartProps {
  /** X value per sample index, shared by all series. */
  xs: number[]
  series: Series[]
  height?: number
  /** Fill the first series to the baseline. */
  area?: boolean
  yMax?: number
  /** Minimum y range, so an all-zero series still gets readable ticks. */
  yFloor?: number
  yFormat: (v: number) => string
  xFormat: (x: number) => string
  /** Dashed reference line with a right-aligned label (e.g. the ceiling). */
  threshold?: { value: number; label: string }
  /** Vertical dashed marker with a label (e.g. "≈ N tokens fit"). */
  marker?: { x: number; label: string }
  /** Shown while there are not enough samples to draw. */
  empty?: string
}

const M = { top: 10, right: 12, bottom: 20, left: 46 }

export function LineChart(props: LineChartProps) {
  const { xs, series, height = 140, yFormat, xFormat } = props
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number>()

  const plotW = Math.max(0, width - M.left - M.right)
  const plotH = height - M.top - M.bottom
  const n = xs.length

  if (n < 2) {
    return (
      <div ref={ref} style={{ width: '100%' }}>
        <div className="small muted" style={{ padding: '24px 0', textAlign: 'center' }}>
          {props.empty ?? 'Collecting samples…'}
        </div>
      </div>
    )
  }

  const xMin = xs[0]
  const xMax = xs[n - 1]
  const dataMax = Math.max(
    1e-9,
    props.yFloor ?? 0,
    props.yMax ?? 0,
    props.threshold?.value ?? 0,
    ...series.flatMap((s) => s.points.filter((v): v is number => v !== undefined)),
  )
  const yMax = props.yMax ?? dataMax * 1.08

  const X = (x: number) => M.left + ((x - xMin) / Math.max(1e-9, xMax - xMin)) * plotW
  const Y = (v: number) => M.top + plotH - (Math.min(v, yMax) / yMax) * plotH

  const linePath = (pts: (number | undefined)[]) => {
    let d = ''
    let pen = false
    for (let i = 0; i < n; i++) {
      const v = pts[i]
      if (v === undefined) {
        pen = false
        continue
      }
      d += `${pen ? 'L' : 'M'}${X(xs[i]).toFixed(1)},${Y(v).toFixed(1)}`
      pen = true
    }
    return d
  }
  const areaPath = (pts: (number | undefined)[]) => {
    const vals = pts.map((v) => v ?? 0)
    let d = `M${X(xs[0]).toFixed(1)},${Y(0).toFixed(1)}`
    for (let i = 0; i < n; i++) d += `L${X(xs[i]).toFixed(1)},${Y(vals[i]).toFixed(1)}`
    d += `L${X(xs[n - 1]).toFixed(1)},${Y(0).toFixed(1)}Z`
    return d
  }

  const ticks = [0.5, 1].map((f) => yMax * f)
  const gridColor = 'var(--vscode-panel-border, rgba(128,128,128,0.2))'
  const ink = 'var(--vscode-descriptionForeground)'

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    const frac = (px - M.left) / Math.max(1, plotW)
    const idx = Math.round(frac * (n - 1))
    setHover(idx >= 0 && idx < n ? idx : undefined)
  }

  const hoverX = hover !== undefined ? X(xs[hover]) : undefined

  return (
    <div ref={ref} style={{ width: '100%', position: 'relative' }}>
      <svg width={width || 300} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(undefined)}>
        {/* recessive grid + y labels */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={M.left + plotW} y1={Y(t)} y2={Y(t)} stroke={gridColor} strokeWidth={1} />
            <text x={M.left - 6} y={Y(t) + 3} textAnchor="end" fontSize={10} fill={ink} style={{ fontVariantNumeric: 'tabular-nums' }}>
              {yFormat(t)}
            </text>
          </g>
        ))}
        <line x1={M.left} x2={M.left + plotW} y1={Y(0)} y2={Y(0)} stroke={gridColor} strokeWidth={1} />
        <text x={M.left} y={height - 6} fontSize={10} fill={ink}>{xFormat(xMin)}</text>
        <text x={M.left + plotW} y={height - 6} textAnchor="end" fontSize={10} fill={ink}>{xFormat(xMax)}</text>

        {props.threshold && props.threshold.value <= yMax && (
          <g>
            <line
              x1={M.left} x2={M.left + plotW}
              y1={Y(props.threshold.value)} y2={Y(props.threshold.value)}
              stroke={ink} strokeWidth={1} strokeDasharray="4 3"
            />
            <text
              x={M.left + plotW}
              // Below the line when it hugs the top edge, so the label never clips.
              y={Y(props.threshold.value) < M.top + 14 ? Y(props.threshold.value) + 12 : Y(props.threshold.value) - 4}
              textAnchor="end" fontSize={10} fill={ink}
            >
              {props.threshold.label}
            </text>
          </g>
        )}

        {props.area && series[0] && (
          <path d={areaPath(series[0].points)} fill={series[0].color} opacity={0.14} />
        )}
        {series.map((s) => (
          <path key={s.name} d={linePath(s.points)} fill="none" stroke={s.color} strokeWidth={2}
            strokeLinejoin="round" strokeLinecap="round" />
        ))}

        {props.marker && props.marker.x >= xMin && props.marker.x <= xMax && (
          <g>
            <line x1={X(props.marker.x)} x2={X(props.marker.x)} y1={M.top} y2={M.top + plotH}
              stroke={ink} strokeWidth={1} strokeDasharray="4 3" />
            <text
              x={Math.min(X(props.marker.x) + 4, M.left + plotW - 4)} y={M.top + 10} fontSize={10} fill={ink}
              textAnchor={X(props.marker.x) > M.left + plotW - 90 ? 'end' : 'start'}
            >
              {props.marker.label}
            </text>
          </g>
        )}

        {/* crosshair + ringed hover dots */}
        {hover !== undefined && hoverX !== undefined && (
          <g pointerEvents="none">
            <line x1={hoverX} x2={hoverX} y1={M.top} y2={M.top + plotH} stroke={ink} strokeWidth={1} opacity={0.5} />
            {series.map((s) => {
              const v = s.points[hover]
              if (v === undefined) return null
              return (
                <circle key={s.name} cx={hoverX} cy={Y(v)} r={4} fill={s.color}
                  stroke="var(--vscode-editorWidget-background, #fff)" strokeWidth={2} />
              )
            })}
          </g>
        )}
      </svg>

      {hover !== undefined && hoverX !== undefined && (
        <div
          style={{
            position: 'absolute',
            left: Math.min(Math.max(hoverX + 8, 0), Math.max(0, width - 150)),
            top: 0,
            pointerEvents: 'none',
            background: 'var(--vscode-editorWidget-background, #f5f5f5)',
            border: `1px solid ${gridColor}`,
            borderRadius: 6,
            padding: '4px 8px',
            fontSize: 11,
            zIndex: 5,
            whiteSpace: 'nowrap',
          }}
        >
          <div className="muted">{xFormat(xs[hover])}</div>
          {series.map((s) => {
            const v = s.points[hover]
            return (
              <div key={s.name}>
                <span style={{ color: s.color }}>●</span> {s.name}:{' '}
                <strong>{v === undefined ? '—' : yFormat(v)}</strong>
              </div>
            )
          })}
        </div>
      )}

      {series.length > 1 && (
        <div className="row wrap small muted" style={{ gap: 12, marginTop: 2 }}>
          {series.map((s) => (
            <span key={s.name}>
              <span style={{ color: s.color }}>●</span> {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The unified-memory pool as one bar: 2px surface gaps between segments,
 * rounded data ends, labels in the legend row rather than on the paint.
 */
export function PoolBar({
  parts,
  total,
  format,
}: {
  parts: { label: string; value: number; color?: string }[]
  total: number
  format: (v: number) => string
}) {
  return (
    <div className="col" style={{ gap: 6 }}>
      <div style={{ display: 'flex', gap: 2, height: 14 }}>
        {parts.map((p) => {
          const share = Math.max(0, Math.min(1, p.value / total))
          if (share === 0) return null
          return (
            <div
              key={p.label}
              title={`${p.label}: ${format(p.value)}`}
              style={{
                width: `${share * 100}%`,
                background: p.color ?? 'var(--vscode-panel-border, rgba(128,128,128,0.25))',
                borderRadius: 4,
                minWidth: 3,
              }}
            />
          )
        })}
      </div>
      <div className="row wrap small muted" style={{ gap: 14 }}>
        {parts.map((p) => (
          <span key={p.label}>
            <span style={{ color: p.color ?? 'var(--vscode-descriptionForeground)' }}>●</span>{' '}
            {p.label} <strong style={{ color: 'var(--vscode-foreground)' }}>{format(p.value)}</strong>
          </span>
        ))}
      </div>
    </div>
  )
}

/** Per-core columns: position encodes load; hue stays constant (magnitude is height's job). */
export function CoreGrid({ perCore }: { perCore: number[] }) {
  return (
    <div className="row" style={{ gap: 2, height: 26, alignItems: 'stretch' }}>
      {perCore.map((pct, i) => (
        <div
          key={i}
          title={`Core ${i}: ${pct.toFixed(0)}%`}
          style={{
            flex: 1,
            minWidth: 3,
            display: 'flex',
            alignItems: 'flex-end',
            background: 'var(--vscode-textCodeBlock-background, rgba(128,128,128,0.12))',
            borderRadius: 3,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: '100%',
              height: `${Math.max(4, Math.min(100, pct))}%`,
              background: 'var(--viz-1)',
              borderRadius: 3,
              transition: 'height 300ms linear',
            }}
          />
        </div>
      ))}
    </div>
  )
}

/** One horizontal magnitude bar with the value beside it (top-consumers rows). */
export function RowBar({
  label,
  value,
  max,
  text,
  highlight,
  right,
}: {
  label: ReactNode
  value: number
  max: number
  text: string
  highlight?: boolean
  right?: ReactNode
}) {
  return (
    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
      <span className={highlight ? undefined : 'muted'} style={{ flex: '0 0 34%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      <div style={{ flex: 1, height: 8, background: 'var(--vscode-textCodeBlock-background, rgba(128,128,128,0.12))', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${Math.max(1, Math.min(100, (value / Math.max(1e-9, max)) * 100))}%`, height: '100%', background: highlight ? 'var(--viz-1)' : 'var(--viz-2)', borderRadius: 4 }} />
      </div>
      <span style={{ flex: '0 0 76px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{text}</span>
      {right}
    </div>
  )
}
