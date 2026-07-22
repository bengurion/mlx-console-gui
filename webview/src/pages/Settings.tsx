import { useEffect, useRef, useState } from 'react'
import { onPush } from '../api'
import { saveSetting, useSettings } from '../settings'
import type { SettingSpec } from '../../../src/shared/protocol'

/** Friendly headings for the group derived from each key's first segment. */
const GROUP_LABELS: Record<string, string> = {
  general: 'General',
  server: 'Server',
  sampling: 'Sampling',
  huggingFace: 'Hugging Face',
}

const GROUP_ORDER = ['general', 'server', 'sampling', 'huggingFace']

/** Bytes as MB/GB, matching how sizes are shown everywhere else in the UI. */
function human(n: number): string {
  if (!n) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${Number(v.toFixed(v < 10 && i > 1 ? 1 : 0))} ${units[i]}`
}

function toText(value: unknown, spec: Pick<SettingSpec, 'type' | 'unit'>): string {
  if (value === undefined || value === null) return ''
  if (spec.unit === 'bytes' && typeof value === 'number') return human(value)
  if (spec.type === 'array' || spec.type === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}

/**
 * One control, chosen by declared type. Edits commit on blur (or immediately
 * for checkboxes) so a half-typed number is never written.
 */
export function Field({
  spec,
  onSaved,
}: {
  spec: SettingSpec
  onSaved?: () => void
}) {
  const [draft, setDraft] = useState(() => toText(spec.value, spec))
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)

  // Re-sync when the host pushes new values (e.g. another edit, or a reset).
  useEffect(() => setDraft(toText(spec.value, spec)), [spec.value, spec.type, spec.unit])

  async function commit(value: unknown) {
    setError(undefined)
    // Through the shared store, so every other editor of this setting updates.
    const res = await saveSetting(spec.key, value)

    if (!res.ok) {
      setError(res.error ?? 'Could not save.')
      return
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 1200)
    onSaved?.()
  }

  const isDefault = JSON.stringify(spec.value) === JSON.stringify(spec.default)

  return (
    <div style={{ marginBottom: 10 }}>
      <div className="row spread">
        <label className="small">
          <strong>{spec.label}</strong>
          {!isDefault && <span className="badge" style={{ marginLeft: 6 }}>modified</span>}
          {saved && <span className="small muted" style={{ marginLeft: 6 }}>saved</span>}
        </label>
        {!isDefault && (
          <a className="small" onClick={() => void commit(spec.default)}>
            Reset
          </a>
        )}
      </div>

      {spec.type === 'boolean' ? (
        <label className="small row" style={{ gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={Boolean(spec.value)}
            onChange={(e) => void commit(e.target.checked)}
          />
          <span className="muted">{spec.description}</span>
        </label>
      ) : (
        <>
          {spec.enum ? (
            <select
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                void commit(e.target.value)
              }}
              style={{ width: '100%' }}
            >
              {spec.enum.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          ) : spec.type === 'array' || spec.type === 'object' ? (
            <textarea
              value={draft}
              rows={3}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => void commit(draft)}
              style={{ width: '100%', fontFamily: 'var(--vscode-editor-font-family)' }}
            />
          ) : (
            <input
              // Byte settings stay text inputs so "8 GB" can be typed.
              type={
                spec.secret
                  ? 'password'
                  : spec.type === 'number' && spec.unit !== 'bytes'
                    ? 'number'
                    : 'text'
              }
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => void commit(draft)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commit(draft)
              }}
              placeholder={
                spec.unit === 'bytes'
                  ? 'e.g. 8 GB (0 = unbounded)'
                  : toText(spec.default, spec) || undefined
              }
              style={{ width: '100%' }}
            />
          )}
          {spec.description && <div className="small muted">{spec.description}</div>}
        </>
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
 * Every contributed setting, editable in place.
 *
 * The catalog is derived host-side from the package.json contribution, so a new
 * setting shows up here automatically — there is no second list to maintain.
 */
export function SettingsPage() {
  const settings = useSettings()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const [filter, setFilter] = useState('')

  const needle = filter.trim().toLowerCase()
  const visible = needle
    ? settings.filter(
        (s) =>
          s.short.toLowerCase().includes(needle) ||
          s.label.toLowerCase().includes(needle) ||
          (s.description ?? '').toLowerCase().includes(needle),
      )
    : settings

  const groups = [...new Set(visible.map((s) => s.group))].sort(
    (a, b) => (GROUP_ORDER.indexOf(a) + 1 || 99) - (GROUP_ORDER.indexOf(b) + 1 || 99),
  )
  const modified = settings.filter(
    (s) => JSON.stringify(s.value) !== JSON.stringify(s.default),
  ).length

  /**
   * A "Change" link elsewhere in the UI reveals the setting here.
   *
   * The host broadcasts which one after bringing this view forward, so the
   * same path works whether the view is a VSCode panel or a browser tab.
   */
  useEffect(
    () =>
      onPush<{ short: string }>('revealSetting', ({ short }) => {
        setOpen(true)
        setFilter(short)
        requestAnimationFrame(() =>
          ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        )
      }),
    [],
  )

  return (
    <div className="card col" ref={ref}>
      <div className="row spread">
        <strong>Settings</strong>
        <a onClick={() => setOpen(!open)}>{open ? 'Hide' : `Edit (${settings.length})`}</a>
      </div>
      <div className="small muted">
        {settings.length} settings{modified > 0 && `, ${modified} modified`}. Saved as you edit —
        there is nothing to apply.
      </div>

      {open && (
        <>
          <input
            placeholder="Filter settings…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ width: '100%', marginTop: 6 }}
          />

          {groups.map((g) => (
            <div key={g} style={{ marginTop: 10 }}>
              <div className="small" style={{ opacity: 0.8, marginBottom: 4 }}>
                <strong>{GROUP_LABELS[g] ?? g}</strong>
              </div>
              {visible
                .filter((s) => s.group === g)
                .map((s) => (
                  <Field key={s.key} spec={s} />
                ))}
            </div>
          ))}

          {visible.length === 0 && <div className="small muted">No settings match “{filter}”.</div>}
        </>
      )}
    </div>
  )
}
