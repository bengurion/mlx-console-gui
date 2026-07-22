/**
 * launchd integration for the headless daemon.
 *
 * `install` writes a LaunchAgent so the dashboard comes back on login. The
 * plist is generated rather than templated by hand so the paths are always
 * absolute and correctly escaped — launchd fails silently on a bad one.
 */
import * as path from 'node:path'
import * as os from 'node:os'

export const LABEL = 'com.mlx-console.daemon'

export function plistPath(home = os.homedir()): string {
  return path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`)
}

export function logPaths(home = os.homedir()): { out: string; err: string } {
  const dir = path.join(home, '.mlx-console')
  return { out: path.join(dir, 'daemon.log'), err: path.join(dir, 'daemon.err.log') }
}

/** XML-escape a value going into the plist. */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface PlistOptions {
  /** Absolute path to the node binary. */
  node: string
  /** Absolute path to the bundled CLI. */
  script: string
  port?: number
  home?: string
}

/**
 * A LaunchAgent that runs `serve` at login and restarts it if it dies.
 *
 * `KeepAlive` is conditioned on a successful exit so a deliberate `stop` does
 * not get undone by launchd immediately relaunching it.
 */
export function buildPlist(opts: PlistOptions): string {
  const home = opts.home ?? os.homedir()
  const logs = logPaths(home)
  const args = [opts.node, opts.script, 'serve']
  if (opts.port !== undefined) args.push('--port', String(opts.port))

  const argXml = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logs.out)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logs.err)}</string>
</dict>
</plist>
`
}

/** The commands used to (re)load and unload the agent, in order. */
export function loadCommands(plist: string, uid = process.getuid?.() ?? 501): string[][] {
  return [
    ['launchctl', 'bootout', `gui/${uid}/${LABEL}`],
    ['launchctl', 'bootstrap', `gui/${uid}`, plist],
    ['launchctl', 'enable', `gui/${uid}/${LABEL}`],
  ]
}

export function unloadCommands(uid = process.getuid?.() ?? 501): string[][] {
  return [['launchctl', 'bootout', `gui/${uid}/${LABEL}`]]
}
