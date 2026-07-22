/**
 * Settings for the headless CLI.
 *
 * When VSCode is not running, nothing owns `settings.json` — and writing to it
 * anyway is a bad trade: it is JSONC (comments, trailing commas), and VSCode
 * rewrites the whole file on save, so a concurrent edit from here would be
 * silently discarded or would discard theirs.
 *
 * So the CLI owns `~/.mlx-console/config.json` and seeds it once from your
 * VSCode settings, giving each side a file it fully controls. The cost is that
 * the two can drift, so every value records where it came from and the
 * dashboard says so.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

export const CONFIG_DIR = path.join(os.homedir(), '.mlx-console')
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

/**
 * Strip comments from JSONC.
 *
 * VSCode's settings.json is full of them. String-aware, so a `//` inside a
 * path value (`https://…`, `C://models`) is not mistaken for a comment.
 */
export function stripJsonComments(text: string): string {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]

    if (inLine) {
      if (c === '\n') { inLine = false; out += c }
      continue
    }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; i++ }
      continue
    }
    if (inString) {
      out += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; out += c; continue }
    if (c === '/' && next === '/') { inLine = true; i++; continue }
    if (c === '/' && next === '*') { inBlock = true; i++; continue }
    out += c
  }
  // Trailing commas are legal in JSONC and fatal to JSON.parse.
  return out.replace(/,(\s*[}\]])/g, '$1')
}

/** Parse JSONC, returning undefined rather than throwing on junk. */
export function parseJsonc(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(stripJsonComments(text))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * Pull `mlxConsole.*` out of a VSCode settings object, keyed by short name.
 *
 * VSCode allows both the flat form (`"mlxConsole.server.port": 8080`) and the
 * nested object form, and writes whichever already exists — so both are read.
 */
export function extractMlxSettings(
  settings: Record<string, unknown> | undefined,
  prefix = 'mlxConsole',
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!settings) return out

  for (const [key, value] of Object.entries(settings)) {
    if (key === prefix && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = v
    } else if (key.startsWith(prefix + '.')) {
      out[key.slice(prefix.length + 1)] = value
    }
  }
  return out
}

export type SettingSource = 'cli' | 'vscode' | 'default'

/**
 * Read/write access to the CLI's own settings, with the manifest's declared
 * defaults underneath so an unset value behaves exactly as it does in VSCode.
 */
export class SettingsStore {
  private values: Record<string, unknown> = {}
  private seeded: Record<string, unknown> = {}

  private readonly defaults: Record<string, unknown>
  private readonly file: string

  constructor(defaults: Record<string, unknown> = {}, file = CONFIG_FILE) {
    this.defaults = defaults
    this.file = file
  }

  /** Load the CLI config, creating it from VSCode settings the first time. */
  load(seedFrom?: Record<string, unknown>): this {
    const existing = readJson(this.file)
    if (existing) {
      this.values = existing
      return this
    }
    this.seeded = seedFrom ?? {}
    this.values = { ...this.seeded }
    this.save()
    return this
  }

  get<T>(short: string, fallback?: T): T {
    const v = this.values[short] ?? this.defaults[short] ?? fallback
    return v as T
  }

  /** Where a value came from, so the dashboard can be honest about drift. */
  sourceOf(short: string): SettingSource {
    if (!(short in this.values)) return 'default'
    return short in this.seeded ? 'vscode' : 'cli'
  }

  set(short: string, value: unknown): void {
    if (value === undefined) delete this.values[short]
    else this.values[short] = value
    this.save()
  }

  all(): Record<string, unknown> {
    return { ...this.defaults, ...this.values }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    // 0600: this file can hold a Hugging Face token.
    fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2) + '\n', { mode: 0o600 })
  }
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return parseJsonc(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}
