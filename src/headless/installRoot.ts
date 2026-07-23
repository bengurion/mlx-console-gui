/**
 * The one file that lives outside the install root.
 *
 * The desktop app installs everything — venv, models, config, logs — under a
 * folder the user chose, and this pointer is how every other entry point (the
 * CLI, the VSIX thin client, the app on its next launch) finds that folder.
 * It sits in `~/.mlx-console/` rather than Electron's userData so nothing but
 * the app needs to know Electron exists.
 *
 * Written last during onboarding, deliberately: its presence is the statement
 * that an install completed, so a crash mid-install re-runs onboarding rather
 * than booting into a half-built root.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export function appPointerFile(home = os.homedir()): string {
  return path.join(home, '.mlx-console', 'app.json')
}

/** The install root, when one exists and still points at a real directory. */
export function readInstallRoot(home = os.homedir()): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(appPointerFile(home), 'utf8')) as {
      installRoot?: unknown
    }
    const root = typeof parsed.installRoot === 'string' ? parsed.installRoot : undefined
    return root && fs.statSync(root).isDirectory() ? root : undefined
  } catch {
    return undefined
  }
}

export function writeInstallRoot(root: string, home = os.homedir()): void {
  const file = appPointerFile(home)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ installRoot: root }, null, 2) + '\n', { mode: 0o600 })
}
