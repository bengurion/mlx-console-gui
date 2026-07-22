import { useEffect, useState } from 'react'
import { rpc, openSettings } from '../api'
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
function Field({
  spec,
  onSaved,
}: {
  spec: SettingSpec
  onSaved: (settings: SettingSpec[]) => void
}) {
  const [draft, setDraft] = useState(() => toText(spec.value, spec))
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)

  // Re-sync when the host pushes new values (e.g. another edit, or a reset).
  useEffect(() => setDraft(toText(spec.value, spec)), [spec.value, spec.type, spec.unit])

  async function commit(value: unknown) {
    setError(undefined)
    const res = (await rpc('updateSetting', { key: spec.key, value }).catch((e: unknown) => ({
      ok: false,
      error: String(e),
    }))) as { ok: boolean; error?: string; settings?: SettingSpec[] }

    if (!res.ok) {
      setError(res.error ?? 'Could not save.')
      return
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 1200)
    if (res.settings) onSaved(res.settings)
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
  const [settings, setSettings] = useState<SettingSpec[]>([])
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    void rpc<SettingSpec[]>('getSettings').then(setSettings).catch(() => undefined)
  }, [])

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

  return (
    <div className="card col">
      <div className="row spread">
        <strong>Settings</strong>
        <a onClick={() => setOpen(!open)}>{open ? 'Hide' : `Edit (${settings.length})`}</a>
      </div>
      <div className="small muted">
        {settings.length} settings{modified > 0 && `, ${modified} modified`}. Changes save to your
        user settings immediately.
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
                  <Field key={s.key} spec={s} onSaved={setSettings} />
                ))}
            </div>
          ))}

          {visible.length === 0 && <div className="small muted">No settings match “{filter}”.</div>}

          <div className="row wrap small" style={{ marginTop: 6 }}>
            <a onClick={() => openSettings('mlxConsole')}>Open in VS Code settings editor</a>
          </div>
        </>
      )}
    </div>
  )
}
