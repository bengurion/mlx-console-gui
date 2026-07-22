/**
 * Where settings come from, abstracted over the host.
 *
 * VSCode has `workspace.getConfiguration`; the daemon has a JSON file. The
 * only two things the rest of the code needs are "what is the effective value"
 * and "did the user set this deliberately" — the second matters because
 * several settings fall back to the model's own metadata when untouched, and
 * an explicit value must win over that. A plain `get` cannot express the
 * difference between "unset" and "set to the default".
 */

export interface SettingsSource {
  /** Effective value, with the manifest default underneath. */
  get<T>(key: string, fallback: T): T
  /** True when the user set this themselves rather than inheriting a default. */
  isExplicit(key: string): boolean
  update(key: string, value: unknown): Promise<void>
}

/** Everything unset — used before a host installs its own source. */
const EMPTY: SettingsSource = {
  get: <T>(_key: string, fallback: T) => fallback,
  isExplicit: () => false,
  update: async () => {},
}

let source: SettingsSource = EMPTY

export function setSettingsSource(next: SettingsSource): void {
  source = next
}

export function settings(): SettingsSource {
  return source
}
