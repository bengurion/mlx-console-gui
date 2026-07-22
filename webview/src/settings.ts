import { useEffect, useState } from 'react'
import { rpc } from './api'
import type { SettingSpec } from '../../src/shared/protocol'

/**
 * One copy of the settings catalog, shared by everything that edits it.
 *
 * Configuration is edited from wherever it is relevant — the storage paths on
 * the Dashboard, LAN exposure next to the endpoint, everything at once in the
 * Settings view — and all of those have to agree. A module-level cache with
 * subscribers means an edit in one place updates the others immediately,
 * rather than each screen holding its own stale copy.
 */
let cache: SettingSpec[] = []
let inFlight: Promise<SettingSpec[]> | undefined
const listeners = new Set<(s: SettingSpec[]) => void>()

function publish(next: SettingSpec[]) {
  cache = next
  for (const l of listeners) l(next)
}

export function loadSettings(force = false): Promise<SettingSpec[]> {
  if (!force && cache.length) return Promise.resolve(cache)
  // Collapse concurrent first loads — several inline editors mount at once.
  inFlight ??= rpc<SettingSpec[]>('getSettings')
    .then((s) => {
      publish(s)
      return s
    })
    .finally(() => {
      inFlight = undefined
    })
  return inFlight
}

/**
 * Write one setting.
 *
 * The host returns the whole catalog after a successful write, so the new
 * value reaches every subscriber without a refetch.
 */
export async function saveSetting(
  key: string,
  value: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const res = (await rpc('updateSetting', { key, value }).catch((e: unknown) => ({
    ok: false,
    error: String(e),
  }))) as { ok: boolean; error?: string; settings?: SettingSpec[] }
  if (res.ok && res.settings) publish(res.settings)
  return res
}

export function useSettings(): SettingSpec[] {
  const [specs, setSpecs] = useState<SettingSpec[]>(cache)
  useEffect(() => {
    listeners.add(setSpecs)
    void loadSettings()
    return () => void listeners.delete(setSpecs)
  }, [])
  return specs
}

/** One setting by its short key, e.g. `server.port`. */
export function useSetting(short: string): SettingSpec | undefined {
  return useSettings().find((s) => s.short === short)
}
