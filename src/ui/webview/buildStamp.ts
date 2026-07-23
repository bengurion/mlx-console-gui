/**
 * Which build each side of the dashboard came from.
 *
 * The page is read from disk on every request; the host is whatever was loaded
 * into memory when the process started. Rebuild without restarting — which is
 * what installing a new VSIX or `npm run compile` does — and a new UI ends up
 * talking to an old host. That does not raise anything: the old host simply
 * ignores request fields it has never heard of, so a newly added filter
 * silently filters nothing and the page looks like it is broken.
 *
 * esbuild stamps one id into every bundle of a build, so comparing them
 * detects exactly that case.
 */
declare const __BUILD_ID__: string | undefined

/** This process's build; `dev` when running from source, as tests do. */
export const BUILD: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'

/**
 * The mismatch to report, if there is one.
 *
 * A client that sends no build is an older page that predates the stamp; there
 * is nothing to compare, and a warning nobody can act on is worse than none.
 */
export function staleNotice(
  clientBuild: string | undefined,
  hostBuild: string = BUILD,
): { host: string; client: string } | undefined {
  if (!clientBuild || clientBuild === hostBuild) return undefined
  return { host: hostBuild, client: clientBuild }
}
