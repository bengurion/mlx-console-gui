import type { SettingSpec } from '../shared/protocol'
import { parseHumanBytes } from './modelConfig.ts'

/** Shape of one entry under `contributes.configuration.properties`. */
export interface ConfigProperty {
  type?: string | string[]
  default?: unknown
  description?: string
  markdownDescription?: string
  enum?: string[]
  items?: unknown
}

/**
 * Keys whose values are credentials and must render masked.
 *
 * Matched against the LAST dotted segment only, and only for string settings.
 * A substring match would catch `maxOutputTokens`, `sampling.maxTokens` and
 * `numDraftTokens` — numeric settings that would then render as password dots.
 */
const SECRET_SEGMENT = /^(token|api_?key|secret|password|pat)$/i

function isSecret(short: string, type: SettingSpec['type']): boolean {
  if (type !== 'string') return false
  const last = short.split('.').pop() ?? short
  return SECRET_SEGMENT.test(last)
}

/** Human label from a dotted key: `server.promptCacheBytes` -> `Prompt cache bytes`. */
export function labelFor(short: string): string {
  const last = short.split('.').pop() ?? short
  // Sentence case, matching VSCode's own settings UI: only the first word is
  // capitalised, so `promptCacheBytes` reads "Prompt cache bytes".
  const spaced = last
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** Group heading: the first dotted segment, or `general` for top-level keys. */
export function groupFor(short: string): string {
  const parts = short.split('.')
  return parts.length > 1 ? parts[0] : 'general'
}

function normalizeType(t: ConfigProperty['type']): SettingSpec['type'] {
  const raw = Array.isArray(t) ? t.find((x) => x !== 'null') : t
  switch (raw) {
    case 'number':
    case 'integer':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'array':
      return 'array'
    case 'object':
      return 'object'
    default:
      return 'string'
  }
}

/**
 * Turn the package.json configuration contribution into a UI-ready list.
 *
 * Deriving the catalog from the manifest means the panel cannot drift from the
 * declared settings: adding a property to package.json makes it appear here
 * with no further wiring.
 *
 * `read` supplies the effective value, so defaults and user overrides both
 * come from VSCode rather than being re-derived.
 */
export function buildSettingsCatalog(
  properties: Record<string, ConfigProperty> | undefined,
  read: (shortKey: string) => unknown,
  prefix = 'mlxConsole.',
): SettingSpec[] {
  if (!properties) return []

  return Object.entries(properties).map(([key, prop]) => {
    const short = key.startsWith(prefix) ? key.slice(prefix.length) : key
    // markdownDescription is the richer field when both are present; the
    // webview renders plain text, so strip the most common markdown noise.
    const description = (prop.markdownDescription ?? prop.description)
      ?.replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')

    return {
      key,
      short,
      group: groupFor(short),
      label: labelFor(short),
      description,
      type: normalizeType(prop.type),
      default: prop.default,
      value: read(short),
      enum: prop.enum,
      secret: isSecret(short, normalizeType(prop.type)) || undefined,
      // Raw byte counts are unreadable in a text box; the UI renders these as
      // MB/GB and converts back on save.
      unit: /bytes$/i.test(short) && normalizeType(prop.type) === 'number' ? 'bytes' : undefined,
    }
  })
}

/**
 * Coerce a value coming from the webview into the declared type.
 * Returns `{ ok: false }` with a reason when the input cannot be used, so the
 * UI can show an error instead of writing something nonsensical.
 */
export function coerceSettingValue(
  spec: Pick<SettingSpec, 'type' | 'unit'>,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  // Byte settings accept "8 GB" / "512mb"; a bare number is read as MB.
  if (spec.unit === 'bytes' && typeof raw === 'string' && raw.trim() !== '') {
    const bytes = parseHumanBytes(raw)
    if (bytes === undefined) return { ok: false, error: 'Expected a size such as "8 GB" or 512.' }
    return { ok: true, value: bytes }
  }
  switch (spec.type) {
    case 'boolean':
      return { ok: true, value: Boolean(raw) }
    case 'number': {
      if (raw === '' || raw === null || raw === undefined) return { ok: true, value: undefined }
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
      if (!Number.isFinite(n)) return { ok: false, error: 'Expected a number.' }
      return { ok: true, value: n }
    }
    case 'array':
    case 'object': {
      if (typeof raw !== 'string') return { ok: true, value: raw }
      const text = raw.trim()
      if (!text) return { ok: true, value: spec.type === 'array' ? [] : {} }
      try {
        const parsed: unknown = JSON.parse(text)
        if (spec.type === 'array' && !Array.isArray(parsed)) {
          return { ok: false, error: 'Expected a JSON array.' }
        }
        if (spec.type === 'object' && (typeof parsed !== 'object' || Array.isArray(parsed))) {
          return { ok: false, error: 'Expected a JSON object.' }
        }
        return { ok: true, value: parsed }
      } catch {
        return { ok: false, error: 'Invalid JSON.' }
      }
    }
    default:
      return { ok: true, value: raw === undefined || raw === null ? '' : String(raw) }
  }
}
