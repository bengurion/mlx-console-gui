/**
 * Finding what VSCode left behind, without VSCode.
 *
 * The CLI needs two things the extension gets for free: the user's settings
 * (to seed its own config) and the managed virtualenv mlx-lm was installed
 * into. Both live under the editor's user-data directory, and there are
 * several editors that qualify — Cursor and VSCodium are forks with their own
 * directories but the same extension inside.
 */
import * as path from 'node:path'
import * as os from 'node:os'

export const EXTENSION_ID = 'mlx-console.mlx-console-gui'

/**
 * Directory names used before the rename.
 *
 * The daemon looks in these too: a user who has not reinstalled the extension
 * still has their venv and registry file under the old id, and finding them
 * matters more than tidiness.
 */
export const LEGACY_EXTENSION_IDS = ['mlx-console.mlx-console-vscode']

/** Every storage id to search, current first. */
export const STORAGE_IDS = [EXTENSION_ID, ...LEGACY_EXTENSION_IDS]

/** User-data directory names, most-preferred first. */
export const EDITOR_DIRS = ['Code', 'Cursor', 'Code - Insiders', 'VSCodium']

/** `~/Library/Application Support/<editor>/User` for each known editor. */
export function userDirs(home = os.homedir()): string[] {
  const base = path.join(home, 'Library', 'Application Support')
  return EDITOR_DIRS.map((d) => path.join(base, d, 'User'))
}

export function settingsCandidates(home = os.homedir()): string[] {
  return userDirs(home).map((d) => path.join(d, 'settings.json'))
}

/** The extension's globalStorage, which is where the managed venv lives. */
export function venvCandidates(home = os.homedir()): string[] {
  return userDirs(home).flatMap((d) =>
    STORAGE_IDS.map((id) => path.join(d, 'globalStorage', id, 'venv')),
  )
}

/**
 * Pick the venv to use: an explicit setting wins, otherwise the first managed
 * one that actually has the binary in it.
 *
 * `exists` is injected so the resolution order is testable without a filesystem.
 */
export function resolveVenv(args: {
  configured?: string
  candidates: string[]
  exists: (p: string) => boolean
}): string | undefined {
  const configured = args.configured?.trim()
  if (configured) return configured
  return args.candidates.find((dir) => args.exists(path.join(dir, 'bin', 'mlx_lm.server')))
}

/** Path to a binary inside a venv. */
export function venvBin(venv: string, name: string): string {
  return path.join(venv, 'bin', name)
}

/** First existing path from a list, or undefined. */
export function firstExisting(paths: string[], exists: (p: string) => boolean): string | undefined {
  return paths.find(exists)
}
