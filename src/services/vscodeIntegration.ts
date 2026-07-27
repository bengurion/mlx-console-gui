/**
 * Writing the console into an editor's settings.json.
 *
 * Claude Code is configured entirely through `claudeCode.environmentVariables`
 * in VS Code's user settings — a file this project's own settings machinery
 * deliberately never touches at runtime (see settingsStore.ts). A one-shot,
 * user-triggered write is a different situation: the user asked for exactly
 * this edit, and doing it here reaches every installed editor (Cursor and
 * VSCodium keep their own user dirs), which the extension's configuration API
 * cannot.
 *
 * Edits go through jsonc-parser — VS Code's own JSONC implementation — so the
 * user's comments and formatting survive. A timestamped backup is written
 * beside the file before any change, parse failures refuse rather than
 * overwrite, and an already-correct file is left untouched.
 *
 * The base URL must be an origin with no `/v1`: Anthropic clients append
 * `/v1/messages` themselves, and the clean endpoint's advertised URL ends in
 * `/v1` — writing that verbatim would produce `/v1/v1/messages` and a 404.
 */
import * as path from 'node:path'
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
import { EDITOR_DIRS, userDirs } from '../headless/hostPaths.ts'
import { CLIENT_ONLY_KEYS } from './ignoredSettings.ts'
import type { EditorStatus, EnvEntry } from '../shared/protocol.ts'

export const ENV_SETTING = 'claudeCode.environmentVariables'

/** The entries this module owns; everything else in the block is the user's. */
export const MANAGED_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
]

/** The settings prefix retired in the rename to MLX Console; always stale. */
const LEGACY_PREFIX = 'mlxServe.'

export interface IntegrationIo {
  exists(p: string): boolean
  read(p: string): string
  write(p: string, text: string): void
}

const EDITOR_LABELS: Record<string, string> = {
  Code: 'VS Code',
  Cursor: 'Cursor',
  'Code - Insiders': 'VS Code Insiders',
  VSCodium: 'VSCodium',
}

/** The env block for one console: base URL (origin only) and exact model id. */
export function desiredEnv(a: { anthropicBaseUrl: string; model: string }): EnvEntry[] {
  const origin = a.anthropicBaseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '')
  return [
    { name: 'ANTHROPIC_BASE_URL', value: origin },
    { name: 'ANTHROPIC_API_KEY', value: 'not-needed' },
    { name: 'ANTHROPIC_MODEL', value: a.model },
    { name: 'ANTHROPIC_SMALL_FAST_MODEL', value: a.model },
    { name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: '1' },
  ]
}

/**
 * The runtime `mlxConsole.*` keys — everything the manifest declares except
 * the client-only pair the extension reads in every mode. These are what a
 * daemon-side cleanup may remove; the embedded extension must never offer
 * this, because for it they are live configuration.
 */
export function runtimeSettingKeys(pkg: unknown): string[] {
  const props =
    (pkg as { contributes?: { configuration?: { properties?: Record<string, unknown> } } })
      ?.contributes?.configuration?.properties ?? {}
  return Object.keys(props)
    .filter((k) => k.startsWith('mlxConsole.'))
    .filter((k) => !CLIENT_ONLY_KEYS.has(k.slice('mlxConsole.'.length)))
}

function asEnvEntries(value: unknown): EnvEntry[] {
  if (!Array.isArray(value)) return []
  return value
    .map((e) => e as { name?: unknown; value?: unknown })
    .filter((e) => typeof e?.name === 'string')
    .map((e) => ({ name: e.name as string, value: typeof e.value === 'string' ? e.value : String(e.value ?? '') }))
}

/**
 * The block with the managed entries taken back out.
 *
 * Wiring is exclusive — `ANTHROPIC_BASE_URL` redirects every request Claude
 * Code makes, so while it is set Anthropic's own models are unreachable.
 * That makes removal as important as installation: this returns the user's
 * other entries untouched, and the caller drops the setting entirely when
 * nothing is left.
 */
export function unwireEnv(existing: unknown): EnvEntry[] {
  const managed = new Set(MANAGED_ENV_KEYS)
  return asEnvEntries(existing).filter((e) => !managed.has(e.name))
}

/**
 * Merge the managed entries into an existing block.
 *
 * Managed names are updated in place (keeping the user's ordering), unknown
 * entries pass through untouched, and managed names not yet present are
 * appended in their canonical order.
 */
export function mergeEnv(existing: unknown, desired: EnvEntry[]): EnvEntry[] {
  const byName = new Map(desired.map((d) => [d.name, d.value]))
  const seen = new Set<string>()
  const merged = asEnvEntries(existing).map((e) => {
    const value = byName.get(e.name)
    if (value === undefined) return e
    seen.add(e.name)
    return { name: e.name, value }
  })
  for (const d of desired) if (!seen.has(d.name)) merged.push(d)
  return merged
}

/** Top-level keys `cleanup` would remove from a parsed settings object. */
export function staleKeysOf(parsed: Record<string, unknown>, cleanupKeys: string[] = []): string[] {
  const cleanup = new Set(cleanupKeys)
  return Object.keys(parsed).filter((k) => k.startsWith(LEGACY_PREFIX) || cleanup.has(k))
}

const FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 4 } }

/**
 * Compute the edited settings text, or refuse.
 *
 * Pure — no filesystem. An empty/missing file is a valid empty object; a file
 * that does not parse is never touched.
 */
export function planEdits(
  text: string,
  a: { env?: EnvEntry[]; removeKeys?: string[]; unwire?: boolean },
): { ok: true; text: string; changed: boolean } | { ok: false; error: string } {
  let out = text.trim() ? text : '{}\n'
  const errors: ParseError[] = []
  const parsed: unknown = parse(out, errors, { allowTrailingComma: true })
  if (errors.length || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'settings.json is not valid JSONC; fix or remove it first.' }
  }
  const obj = parsed as Record<string, unknown>

  for (const key of a.removeKeys ?? []) {
    if (!(key in obj)) continue
    out = applyEdits(out, modify(out, [key], undefined, FORMAT))
  }

  if (a.unwire && ENV_SETTING in obj) {
    const rest = unwireEnv(obj[ENV_SETTING])
    if (rest.length !== asEnvEntries(obj[ENV_SETTING]).length) {
      // Nothing of the user's left in the block: drop the key rather than
      // leaving an empty array that looks like configuration.
      out = applyEdits(out, modify(out, [ENV_SETTING], rest.length ? rest : undefined, FORMAT))
    }
  }

  if (a.env) {
    const merged = mergeEnv(obj[ENV_SETTING], a.env)
    if (JSON.stringify(merged) !== JSON.stringify(asEnvEntries(obj[ENV_SETTING]))) {
      out = applyEdits(out, modify(out, [ENV_SETTING], merged, FORMAT))
    }
  }

  return { ok: true, text: out, changed: out !== text }
}

/**
 * Apply the edit to one editor's settings.json, backup first.
 *
 * Degrades rather than throws: every failure comes back as `{ok: false}`
 * with a sentence, so a multi-editor loop reports per editor.
 */
export function applyToEditor(a: {
  settingsPath: string
  env?: EnvEntry[]
  removeKeys?: string[]
  unwire?: boolean
  io: IntegrationIo
  now?: Date
}): { ok: boolean; changed: boolean; backupPath?: string; error?: string } {
  try {
    const existed = a.io.exists(a.settingsPath)
    const original = existed ? a.io.read(a.settingsPath) : ''
    const plan = planEdits(original, { env: a.env, removeKeys: a.removeKeys, unwire: a.unwire })
    if (!plan.ok) return { ok: false, changed: false, error: plan.error }
    if (!plan.changed) return { ok: true, changed: false }

    let backupPath: string | undefined
    if (existed) {
      backupPath = `${a.settingsPath}.mlx-backup-${stamp(a.now ?? new Date())}`
      a.io.write(backupPath, original)
    }
    a.io.write(a.settingsPath, plan.text)
    return { ok: true, changed: true, backupPath }
  } catch (err) {
    return { ok: false, changed: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** What each known editor currently has, for the UI's checkboxes and badges. */
export function detectEditors(a: {
  desired: EnvEntry[]
  cleanupKeys?: string[]
  home?: string
  io: Pick<IntegrationIo, 'exists' | 'read'>
}): EditorStatus[] {
  const dirs = userDirs(a.home)
  return EDITOR_DIRS.map((id, i) => {
    const userDir = dirs[i]
    const settingsPath = path.join(userDir, 'settings.json')
    const status: EditorStatus = {
      id,
      label: EDITOR_LABELS[id] ?? id,
      settingsPath,
      installed: a.io.exists(userDir),
      wired: false,
      hasWiring: false,
      staleKeys: [],
    }
    if (!status.installed || !a.io.exists(settingsPath)) return status

    const errors: ParseError[] = []
    const parsed: unknown = parse(a.io.read(settingsPath), errors, { allowTrailingComma: true })
    if (errors.length || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      status.parseError = 'settings.json is not valid JSONC'
      return status
    }
    const obj = parsed as Record<string, unknown>
    const current = new Map(asEnvEntries(obj[ENV_SETTING]).map((e) => [e.name, e.value]))
    status.wired = a.desired.every((d) => current.get(d.name) === d.value)
    status.hasWiring = MANAGED_ENV_KEYS.some((k) => current.has(k))
    status.staleKeys = staleKeysOf(obj, a.cleanupKeys)
    return status
  })
}

function stamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}
