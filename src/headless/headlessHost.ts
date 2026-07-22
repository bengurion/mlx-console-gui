/**
 * The daemon's answers to what the core asks the host.
 *
 * The mirror of ui/vscodeHost.ts. Two decisions are worth stating because they
 * are not obvious:
 *
 *  - **Storage is shared with the extension.** The daemon uses the editor's
 *    globalStorage when it exists, so the venv the extension built and the
 *    registry file it writes are the same ones — otherwise the CLI would
 *    install a second mlx-lm and lose track of the running server.
 *  - **Confirmations are answered by the request itself.** Nobody is watching a
 *    daemon. Every destructive action here arrives from the dashboard, where
 *    the button already said what it does, so a prompt with no one to read it
 *    would only mean the action silently never happens.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { log } from '../core/logging'
import type { SettingsSource } from '../core/settings'
import type { EnvHost } from '../backend/environmentManager'
import type { HubHost } from '../ui/webview/webviewHub'
import { STORAGE_IDS, userDirs } from './hostPaths'
import type { SettingsStore } from './settingsStore'

/** The CLI's config file, presented as a settings source. */
export class StoreSettings implements SettingsSource {
  private readonly store: SettingsStore

  constructor(store: SettingsStore) {
    this.store = store
  }

  get<T>(key: string, fallback: T): T {
    const v = this.store.get<T>(key, fallback)
    return v === undefined ? fallback : v
  }

  /** Written to the config file at some point, rather than left at default. */
  isExplicit(key: string): boolean {
    return this.store.sourceOf(key) !== 'default'
  }

  async update(key: string, value: unknown): Promise<void> {
    this.store.set(key, value)
  }
}

/**
 * Where the daemon keeps state: the editor's globalStorage if the extension
 * has ever run, otherwise its own directory.
 */
export function storageDir(home = os.homedir()): string {
  const shared = userDirs(home)
    .flatMap((d) => STORAGE_IDS.map((id) => path.join(d, 'globalStorage', id)))
    .find((d) => fs.existsSync(path.join(d, 'venv')))
  return shared ?? path.join(home, '.mlx-console', 'storage')
}

export function headlessEnvHost(dir = storageDir()): EnvHost {
  return {
    storageDir: dir,
    // No modals; setup narrates to the log, which is the terminal or the
    // daemon's file.
    progress: async (title, task) => {
      log.info(title)
      return task((message) => log.info(`  ${message}`))
    },
    reportError: async (message) => {
      log.error(message)
      return undefined
    },
    reportInfo: (message) => log.info(message),
  }
}

export function headlessHubHost(): HubHost {
  return {
    // See the note above: the dashboard already asked.
    confirm: async ({ message }) => {
      log.info(`Proceeding: ${message}`)
      return true
    },
    reportError: (message) => log.error(message),
    reportInfo: (message) => log.info(message),
    progress: (title, task) => {
      log.info(title)
      return task()
    },
    // Refused rather than silently ignored: raising the wired limit is a
    // system-wide change, and there is no terminal here for someone to type a
    // password into where they can see the command.
    runElevated: (command) => {
      log.warn(`Refused to run without a visible terminal: ${command}`)
      return false
    },
    openExternal: (url) => log.info(`Open: ${url}`),
    copy: async () => {},
    openSettings: () => {},
  }
}
