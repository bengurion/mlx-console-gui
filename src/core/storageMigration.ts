/**
 * Carrying storage across a rename.
 *
 * VSCode derives an extension's storage directory from `publisher.name`, so
 * renaming the extension silently points it at an empty directory. What was
 * left behind is not small — a virtualenv with mlx-lm in it is a few hundred
 * megabytes and several minutes of installing — and the file recording which
 * server is running lives there too, so an un-migrated rename also loses track
 * of a live process.
 *
 * The move is done once, only into an empty destination, and never deletes
 * anything it did not successfully move.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** Storage directory names this extension has used, oldest first. */
export const LEGACY_STORAGE_IDS = ['mlx-console.mlx-console-vscode']

export interface MigrationPlan {
  from: string
  to: string
}

/**
 * Decide whether to migrate.
 *
 * Only when the destination has nothing worth keeping and a legacy directory
 * has a venv — the one artefact expensive enough to justify touching the
 * filesystem at startup. A destination that already has its own venv is left
 * alone: two installs is a mess, but overwriting the newer one is worse.
 */
export function planMigration(args: {
  storageDir: string
  legacyDirs: string[]
  hasVenv: (dir: string) => boolean
}): MigrationPlan | undefined {
  const { storageDir, legacyDirs, hasVenv } = args
  if (hasVenv(storageDir)) return undefined
  const from = legacyDirs.find((d) => d !== storageDir && hasVenv(d))
  return from ? { from, to: storageDir } : undefined
}

export interface MigrationResult {
  moved: string[]
  /** Set when the move failed and the old location should be used in place. */
  fallbackVenv?: string
  error?: string
}

/**
 * Move a legacy storage directory's contents into the new one.
 *
 * `rename` is instant within a volume, which this always is — both paths sit
 * under the same Application Support tree. If it fails anyway, nothing is
 * destroyed and the caller is handed the old venv path to use where it lies.
 */
export function migrateStorage(plan: MigrationPlan, io = fs): MigrationResult {
  const moved: string[] = []
  try {
    io.mkdirSync(plan.to, { recursive: true })
    for (const entry of io.readdirSync(plan.from)) {
      const target = path.join(plan.to, entry)
      // Never clobber: anything already present in the new location wins.
      if (io.existsSync(target)) continue
      io.renameSync(path.join(plan.from, entry), target)
      moved.push(entry)
    }
    return { moved }
  } catch (err) {
    return {
      moved,
      fallbackVenv: path.join(plan.from, 'venv'),
      error: String(err),
    }
  }
}
