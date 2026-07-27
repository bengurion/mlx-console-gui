/**
 * Settings that look live but are not.
 *
 * In remote mode the desktop app owns the runtime, and the source of truth
 * for every runtime setting is the install root's `config.json` — the
 * extension's own `mlxConsole.*` keys are read only in embedded mode. Nothing
 * used to say so: a `server.decodeConcurrency` sitting in VS Code's
 * settings.json looked exactly like configuration, was silently ignored, and
 * quietly drifted from what the app actually ran. This module decides which
 * explicitly-set keys deserve that warning, so the judgement is testable
 * without a VS Code host.
 *
 * The two client-only keys are the extension's own business in every mode
 * and are never flagged.
 */

/** Keys the extension itself reads even in remote mode. */
export const CLIENT_ONLY_KEYS = new Set(['mode', 'daemonUrl'])

/** An `mlxConsole.*` key (prefix stripped) the user has explicitly set. */
export interface SetKey {
  key: string
  /** Set in user (global) settings. */
  global: boolean
  /** Set in workspace or workspace-folder settings. */
  workspace: boolean
}

/** The keys remote mode ignores: explicitly set, and not client-only. */
export function ignoredKeys(set: SetKey[]): SetKey[] {
  return set.filter((s) => (s.global || s.workspace) && !CLIENT_ONLY_KEYS.has(s.key))
}

/**
 * A stable identity for one particular set of offenders.
 *
 * The warning is shown once per fingerprint: dismissing it silences that
 * exact set, but adding another ignored key later is a new situation and
 * warns again.
 */
export function fingerprint(keys: SetKey[]): string {
  return keys
    .map((k) => k.key)
    .sort()
    .join(',')
}

/** "server.decodeConcurrency and 2 more" — short enough for a toast. */
export function describeKeys(keys: SetKey[]): string {
  const names = keys.map((k) => k.key).sort()
  if (names.length <= 2) return names.join(' and ')
  return `${names[0]} and ${names.length - 1} more`
}
