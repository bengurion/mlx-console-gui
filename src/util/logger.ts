/**
 * The extension's log sink: VSCode's output channel.
 *
 * `log` itself lives in core/logging so code shared with the CLI can use it
 * without importing the editor. This module only installs the destination.
 */
import * as vscode from 'vscode'
import { log, setLogSink } from '../core/logging'

let channel: vscode.OutputChannel | undefined

export function initLogger(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('MLX Console GUI')
    const ch = channel
    setLogSink({
      write: (_level, message) => ch.appendLine(message),
      show: () => ch.show(),
    })
  }
  return channel
}

export { log }
