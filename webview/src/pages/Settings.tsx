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

/** What the control should display for a staged (not yet saved) value. */
function stagedText(staged: unknown, spec: Pick<SettingSpec, 'type' | 'unit'>): string {
  return typeof staged === 'string' ? staged : toText(staged, spec)
}

/**
 * One control, chosen by declared type. Edits are *staged*: they change
 * nothing until the page's Save button applies them, so a half-finished
 * editing session never leaves the config in a state nobody chose.
 */
export function Field({
  spec,
  staged,
  error,
  onStage,
}: {
  spec: SettingSpec
  /** The staged value for this key, or undefined when unedited. */
  staged: unknown
  /** Save-time error for this key, if the last save rejected it. */
  error?: string
  onStage: (key: string, value: unknown) => void
}) {
  const [draft, setDraft] = useState(() =>
    staged !== undefined ? stagedText(staged, spec) : toText(spec.value, spec),
  )

  // Re-sync when the host pushes new values, or when a discard clears staging.
  useEffect(() => {
    setDraft(staged !== undefined ? stagedText(staged, spec) : toText(spec.value, spec))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staged, spec.value, spec.type, spec.unit])

  const stage = (value: unknown) => onStage(spec.key, value)
  const isDefault = JSON.stringify(spec.value) === JSON.stringify(spec.default)
  const dirty = staged !== undefined

  return (
    <div style={{ marginBottom: 12 }}>
      <div className="row spread">
        <label className="small">
          <strong>{spec.label}</strong>
          {!isDefault && <span className="badge" style={{ marginLeft: 6 }}>modified</span>}
          {dirty && (
            <span
              className="small"
              style={{ marginLeft: 6, color: 'var(--vscode-editorWarning-foreground, #d29922)' }}
            >
              unsaved
            </span>
          )}
        </label>
        {!isDefault && (
          <a className="small" onClick={() => stage(spec.default)}>
            Reset
          </a>
        )}
      </div>

      {spec.type === 'boolean' ? (
        <label className="small row" style={{ gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={dirty ? Boolean(staged) : Boolean(spec.value)}
            onChange={(e) => stage(e.target.checked)}
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
                stage(e.target.value)
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
              onChange={(e) => {
                setDraft(e.target.value)
                stage(e.target.value)
              }}
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
              onChange={(e) => {
                setDraft(e.target.value)
                stage(e.target.value)
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
 * Edits stage locally and apply together on Save: several of these settings
 * belong to one decision (a port and its exposure, a draft model and its token
 * count), and applying keystroke by keystroke made half-decisions live.
 */
export function SettingsPage() {
  const settings = useSettings()
  // Open by default: this IS the settings page — a list you must first ask to
  // see is a page that looks broken.
  const [open, setOpen] = useState(true)
  const ref = useRef<HTMLDivElement>(null)
  const [filter, setFilter] = useState('')
  const [pending, setPending] = useState<Record<string, unknown>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)

  function stage(key: string, value: unknown) {
    setPending((p) => {
      const spec = settings.find((s) => s.key === key)
      // Typing back the current value un-stages: nothing would change.
      const unchanged =
        spec &&
        (typeof value === 'string'
          ? value === toText(spec.value, spec)
          : JSON.stringify(value) === JSON.stringify(spec.value))
      const next = { ...p }
      if (unchanged) delete next[key]
      else next[key] = value
      return next
    })
  }

  async function saveAll() {
    setSaving(true)
    const failed: Record<string, string> = {}
    for (const [key, value] of Object.entries(pending)) {
      // Through the shared store, so every other editor of a setting updates.
      const res = await saveSetting(key, value)
      if (!res.ok) failed[key] = res.error ?? 'Could not save.'
    }
    setErrors(failed)
    // Rejected values stay staged so the correction is one edit away.
    setPending((p) => Object.fromEntries(Object.entries(p).filter(([k]) => failed[k])))
    setSaving(false)
    if (Object.keys(failed).length === 0) {
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1500)
    }
  }

  function discard() {
    setPending({})
    setErrors({})
  }

  const dirtyCount = Object.keys(pending).length

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
    <div className="card col" ref={ref} style={{ fontSize: '1.08em', lineHeight: 1.55 }}>
      <div className="row spread">
        <strong>Settings</strong>
        <a onClick={() => setOpen(!open)}>{open ? 'Hide' : `Edit (${settings.length})`}</a>
      </div>
      <div className="small muted">
        {settings.length} settings{modified > 0 && `, ${modified} modified`}. Edits stage here and
        apply together when you save.
      </div>

      {/* The save bar: sticky, so 34 settings of scrolling never hides the way
          to apply or abandon what has been edited. */}
      {(dirtyCount > 0 || savedFlash) && (
        <div
          className="row spread"
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 5,
            padding: '8px 10px',
            borderRadius: 6,
            background: 'var(--page-elevated, var(--vscode-editorWidget-background))',
            border: '1px solid var(--vscode-panel-border)',
          }}
        >
          <span className="small">
            {savedFlash && dirtyCount === 0
              ? 'Saved.'
              : `${dirtyCount} unsaved change${dirtyCount === 1 ? '' : 's'}`}
          </span>
          {dirtyCount > 0 && (
            <span className="row" style={{ gap: 8 }}>
              <button disabled={saving} onClick={() => void saveAll()}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button className="secondary" disabled={saving} onClick={discard}>
                Discard
              </button>
            </span>
          )}
        </div>
      )}

      {open && (
        <>
          <input
            placeholder="Filter settings…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ width: '100%', marginTop: 6, maxWidth: 480 }}
          />

          {/* Two column divs with the groups stacked inside — not one grid
              cell per group, which left a hole under every short group. */}
          <div className="grid-2" style={{ marginTop: 4 }}>
            {[groups.filter((_, i) => i % 2 === 0), groups.filter((_, i) => i % 2 === 1)].map(
              (columnGroups, col) => (
                <div key={col}>
                  {columnGroups.map((g) => (
                    <div key={g} style={{ marginBottom: 18 }}>
                      <div className="small" style={{ opacity: 0.8, marginBottom: 4 }}>
                        <strong>{GROUP_LABELS[g] ?? g}</strong>
                      </div>
                      {visible
                        .filter((s) => s.group === g)
                        .map((s) => (
                          <Field
                            key={s.key}
                            spec={s}
                            staged={pending[s.key]}
                            error={errors[s.key]}
                            onStage={stage}
                          />
                        ))}
                    </div>
                  ))}
                </div>
              ),
            )}
          </div>

          {visible.length === 0 && <div className="small muted">No settings match “{filter}”.</div>}
        </>
      )}
    </div>
  )
}
