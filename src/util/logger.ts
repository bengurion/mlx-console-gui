import * as vscode from 'vscode'

let channel: vscode.OutputChannel | undefined

export function initLogger(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('MLX Console')
  }
  return channel
}

function fmt(v: unknown): string {
  if (v instanceof Error) return v.stack ?? v.message
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function write(level: string, msg: string, rest: unknown[]) {
  const ch = channel ?? initLogger()
  const stamp = new Date().toISOString()
  const extra = rest.length ? ' ' + rest.map(fmt).join(' ') : ''
  ch.appendLine(`[${stamp}] [${level}] ${msg}${extra}`)
}

export const log = {
  info(msg: string, ...rest: unknown[]) {
    write('INFO', msg, rest)
  },
  warn(msg: string, ...rest: unknown[]) {
    write('WARN', msg, rest)
  },
  error(msg: string, ...rest: unknown[]) {
    write('ERROR', msg, rest)
  },
  show() {
    ;(channel ?? initLogger()).show()
  },
}
