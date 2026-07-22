/**
 * Request handling for the optional local web UI.
 *
 * Pure logic only — routing, authorisation and rendering — so the security
 * decisions are unit-testable without standing up a server.
 *
 * Threat model. This endpoint can change settings and start/stop processes, so
 * "it only listens on localhost" is not sufficient protection:
 *
 *  - **Any web page you visit can send requests to 127.0.0.1.** The browser
 *    will happily issue them; only the *response* is hidden by CORS. A
 *    fire-and-forget POST that flips a setting or stops your server succeeds
 *    regardless. Hence a per-session token on every request.
 *  - **DNS rebinding** lets a remote origin masquerade as localhost, so the
 *    Host header is checked rather than trusted.
 *  - **Other local users/processes** can reach a loopback port too. The token
 *    is the boundary, not the interface address.
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
 * Decide whether a request may proceed.
 *
 * Order matters: reject a spoofed Host before looking at the token, so a
 * rebinding probe learns nothing about token validity.
 */
export function authorize(args: {
  host?: string
  token: string
  givenToken?: string
  method?: string
  contentType?: string
}): AuthResult {
  const { host, token, givenToken, method, contentType } = args

  if (!host || !ALLOWED_HOSTS.test(host)) {
    return { ok: false, status: 403, reason: 'This endpoint only answers to localhost.' }
  }
  if (!tokensMatch(token, givenToken)) {
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
