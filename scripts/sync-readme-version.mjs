#!/usr/bin/env node
/**
 * Regenerates the parts of README.md that are derived from package.json:
 *   1. version references in the download/install commands
 *   2. the settings reference table
 *
 * Both drift silently otherwise — a stale download link 404s, and a
 * hand-maintained settings table quietly stops matching the manifest the first
 * time a setting is added. This runs as part of `npm run vsce:package`, so the
 * packaged README always matches the extension beside it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const readmePath = join(root, 'README.md')
const before = readFileSync(readmePath, 'utf8')

const { name, version } = pkg

// ---- 1. version references -------------------------------------------------

let out = before
  .replaceAll(new RegExp(`${name}-\\d+\\.\\d+\\.\\d+\\.vsix`, 'g'), `${name}-${version}.vsix`)
  .replaceAll(/\/releases\/tag\/v\d+\.\d+\.\d+/g, `/releases/tag/v${version}`)

// ---- 2. settings table -----------------------------------------------------

const START = '<!-- settings:start -->'
const END = '<!-- settings:end -->'

/** Group heading from the first dotted segment, matching the settings panel. */
const GROUPS = {
  general: 'General',
  server: 'Server',
  sampling: 'Sampling',
  huggingFace: 'Hugging Face',
}
const ORDER = ['general', 'server', 'sampling', 'huggingFace']

/** Markdown table cells cannot contain a raw pipe or newline. */
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim()

/**
 * Condense a setting description for the table.
 *
 * One sentence is too blunt — several descriptions put the actionable half in
 * the second ("Lower is more deterministic"). Take sentences until the note is
 * long enough to be useful, then stop.
 */
const NOTE_TARGET = 150

function summarise(prop) {
  const text = (prop.markdownDescription ?? prop.description ?? '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')

  const sentences = text.match(/[^.]+\.(\s|$)/g) ?? [text]
  let note = ''
  for (const s of sentences) {
    if (note && note.length + s.length > NOTE_TARGET) break
    note += s
  }
  return cell(note || text)
}

function formatDefault(value, type) {
  if (value === undefined || value === null) return '—'
  if (value === '') return '_(empty)_'
  if (Array.isArray(value)) return value.length ? `\`${JSON.stringify(value)}\`` : '`[]`'
  if (type === 'object') return `\`${JSON.stringify(value)}\``
  return `\`${value}\``
}

function settingsTable(properties) {
  const rows = Object.entries(properties).map(([key, prop]) => {
    const short = key.replace(/^mlxConsole\./, '')
    const group = short.includes('.') ? short.split('.')[0] : 'general'
    const type = Array.isArray(prop.type) ? prop.type[0] : (prop.type ?? 'string')
    return { group, short, type, prop }
  })

  const groups = [...new Set(rows.map((r) => r.group))].sort(
    (a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99),
  )

  const parts = []
  for (const g of groups) {
    parts.push(`#### ${GROUPS[g] ?? g}\n`)
    parts.push('| Setting | Type | Default | Notes |')
    parts.push('| --- | --- | --- | --- |')
    for (const r of rows.filter((x) => x.group === g)) {
      parts.push(
        `| \`${r.short}\` | ${r.type} | ${formatDefault(r.prop.default, r.type)} | ${summarise(r.prop)} |`,
      )
    }
    parts.push('')
  }
  return parts.join('\n')
}

const props = pkg.contributes?.configuration?.properties ?? {}
const startIdx = out.indexOf(START)
const endIdx = out.indexOf(END)

if (startIdx !== -1 && endIdx !== -1) {
  const table = `${START}\n\n${settingsTable(props)}\n${END}`
  out = out.slice(0, startIdx) + table + out.slice(endIdx + END.length)
} else {
  console.warn('[readme] settings markers not found — table not regenerated')
}

if (out === before) {
  console.log(`[readme] already in sync (v${version}, ${Object.keys(props).length} settings)`)
} else {
  writeFileSync(readmePath, out)
  console.log(`[readme] synced to v${version}, ${Object.keys(props).length} settings`)
}
