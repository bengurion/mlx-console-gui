/**
 * Request handling for the local web UI.
 *
 * Pure logic only — routing, authorisation and rendering — so the security
 * decisions are unit-testable without standing up a server.
 *
 * Threat model. This endpoint can change settings and start/stop processes, so
 * "it only listens on localhost" is not sufficient protection. Four checks,
 * three of which always apply:
 *
 *  1. **Host must be loopback.** DNS rebinding lets a remote origin masquerade
 *     as localhost; the Host header it sends gives it away.
 *  2. **The request must not come from another site.** Any page you visit can
 *     send requests to 127.0.0.1 — CORS hides the *response*, but a
 *     fire-and-forget POST that stops your server succeeds anyway. Browsers
 *     label such requests: `Sec-Fetch-Site: cross-site`, or an `Origin` that is
 *     not loopback. Both are refused, which is what makes running without a
 *     token defensible.
 *  3. **Writes must be JSON.** A cross-origin form can only send urlencoded,
 *     multipart or plain text, so requiring JSON blocks the simplest CSRF
 *     shape outright — including from a browser too old to send the headers
 *     above.
 *  4. **A token, if you want one.** Optional, because on a single-user machine
 *     checks 1–3 already stop the drive-by attack. Turn it on
 *     (`webUi.requireToken`) if other people have accounts on this Mac: a
 *     loopback port is reachable by every local user, and only the token keeps
 *     them out.
 */

export interface AuthResult {
  ok: boolean
  status: number
  reason?: string
}

/** Hosts we will answer to. Anything else is a rebinding attempt. */
const ALLOWED_HOSTS = /^(127\.0\.0\.1|\[?::1\]?|localhost)(:\d+)?$/i

/**
 * Constant-time-ish string compare.
 *
 * Not a substitute for `crypto.timingSafeEqual`, but avoids the early return of
 * `===` leaking length/prefix information through response timing.
 */
export function tokensMatch(expected: string, given: string | undefined): boolean {
  if (!given || expected.length !== given.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i)
  return diff === 0
}

/**
 * Fetch metadata values that mean "this request did not come from another
 * site". `none` is a user-initiated navigation — typing the URL, a bookmark.
 */
const SAME_SITE_VALUES = new Set(['same-origin', 'same-site', 'none'])

/** An Origin we accept: our own page, i.e. loopback. */
function originIsLocal(origin: string): boolean {
  if (origin === 'null') return false // sandboxed iframe, opaque origin
  try {
    return ALLOWED_HOSTS.test(new URL(origin).host)
  } catch {
    return false
  }
}

/**
 * Decide whether a request may proceed.
 *
 * Order matters: reject a spoofed Host and a cross-site caller before looking
 * at the token, so a probe learns nothing about token validity.
 */
export function authorize(args: {
  host?: string
  token: string
  givenToken?: string
  method?: string
  contentType?: string
  /** Browser fetch metadata; absent for curl and other non-browser clients. */
  secFetchSite?: string
  origin?: string
  /** When false, checks 1–3 stand alone. See the module comment. */
  requireToken?: boolean
}): AuthResult {
  const { host, token, givenToken, method, contentType, secFetchSite, origin } = args
  const requireToken = args.requireToken ?? true

  if (!host || !ALLOWED_HOSTS.test(host)) {
    return { ok: false, status: 403, reason: 'This endpoint only answers to localhost.' }
  }
  // A browser tells us when it is another site making the request. Trustworthy
  // because the page cannot set either header itself.
  if (secFetchSite !== undefined && !SAME_SITE_VALUES.has(secFetchSite.toLowerCase())) {
    return { ok: false, status: 403, reason: 'Cross-site requests are refused.' }
  }
  if (origin !== undefined && !originIsLocal(origin)) {
    return { ok: false, status: 403, reason: 'Cross-origin requests are refused.' }
  }
  if (requireToken && !tokensMatch(token, givenToken)) {
    return { ok: false, status: 401, reason: 'Missing or invalid token.' }
  }
  // A cross-origin <form> can only send urlencoded/plain bodies, never JSON, so
  // requiring JSON on writes blocks the simplest CSRF shape outright.
  if (method === 'POST' && !(contentType ?? '').toLowerCase().startsWith('application/json')) {
    return { ok: false, status: 415, reason: 'Writes must be application/json.' }
  }
  return { ok: true, status: 200 }
}

export type Route =
  | { kind: 'page' }
  | { kind: 'state' }
  | { kind: 'setting' }
  | { kind: 'server' }
  | { kind: 'unknown' }

export function routeOf(pathname: string): Route {
  switch (pathname.replace(/\/+$/, '') || '/') {
    case '/':
      return { kind: 'page' }
    case '/api/state':
      return { kind: 'state' }
    case '/api/setting':
      return { kind: 'setting' }
    case '/api/server':
      return { kind: 'server' }
    default:
      return { kind: 'unknown' }
  }
}

/** Server actions the page may trigger. Anything else is rejected. */
export const SERVER_ACTIONS = ['start', 'stop', 'restart', 'clear'] as const
export type ServerAction = (typeof SERVER_ACTIONS)[number]

export function parseServerAction(value: unknown): ServerAction | undefined {
  return typeof value === 'string' && (SERVER_ACTIONS as readonly string[]).includes(value)
    ? (value as ServerAction)
    : undefined
}

/**
 * Replace credential values before they leave the extension.
 *
 * The page still lets you *set* them; it just never echoes one back, so an
 * exported page or a shoulder-surfed screen cannot leak a token.
 */
export function redactSettings<T extends { secret?: boolean; value: unknown }>(settings: T[]): T[] {
  return settings.map((s) =>
    s.secret && typeof s.value === 'string' && s.value.length > 0
      ? { ...s, value: '••••••••' }
      : s,
  )
}

/** True when a submitted secret is the redaction placeholder, i.e. unchanged. */
export function isRedactedPlaceholder(value: unknown): boolean {
  return typeof value === 'string' && /^•+$/.test(value)
}
