#!/usr/bin/env node
/**
 * Rewrites the version strings in README.md to match package.json.
 *
 * The download link names a specific .vsix, so the README would otherwise drift
 * from the manifest on every bump — and a stale link 404s silently. This runs
 * as part of `npm run vsce:package`, so the packaged README always matches the
 * artifact beside it.
 *
 * Only two shapes are touched, both anchored to the extension name so unrelated
 * version numbers in prose are left alone:
 *   mlx-console-vscode-<semver>.vsix
 *   /releases/tag/v<semver>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const readmePath = join(root, 'README.md')

const { name, version } = pkg
const before = readFileSync(readmePath, 'utf8')

const after = before
  .replaceAll(new RegExp(`${name}-\\d+\\.\\d+\\.\\d+\\.vsix`, 'g'), `${name}-${version}.vsix`)
  .replaceAll(/\/releases\/tag\/v\d+\.\d+\.\d+/g, `/releases/tag/v${version}`)

if (after === before) {
  console.log(`[readme] already at ${version}`)
} else {
  writeFileSync(readmePath, after)
  console.log(`[readme] version references updated to ${version}`)
}
