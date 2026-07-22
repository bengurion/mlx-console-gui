import * as vscode from 'vscode'
import type { EnvStatus } from '../backend/environmentManager'

import type { ModelState } from '../backend/serverManager'

export type ServerState = 'stopped' | 'starting' | 'ready' | 'error'

function shortModel(model: string): string {
  const parts = model.split('/')
  return parts[parts.length - 1]
}

/** Left status-bar item reflecting environment + server state. */
export class StatusBar {
  private readonly item: vscode.StatusBarItem
  private env: EnvStatus | undefined
  private server: ServerState = 'stopped'
  private model: string | undefined
  private modelState: ModelState = 'none'
  private loadedModel: string | undefined
  private lastLoadSeconds: number | undefined

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
    this.item.command = 'mlxConsole.showMenu'
    this.render()
    this.item.show()
  }

  setEnv(env: EnvStatus) {
    this.env = env
    this.render()
  }

  setServer(state: ServerState, model?: string) {
    this.server = state
    if (model !== undefined) this.model = model
    this.render()
  }

  /** Weight residency, which is separate from whether the server is up. */
  setModel(modelState: ModelState, loadedModel?: string, lastLoadSeconds?: number) {
    this.modelState = modelState
    this.loadedModel = loadedModel
    this.lastLoadSeconds = lastLoadSeconds
    this.render()
  }

  private render() {
    let icon = '$(chip)'
    let text = 'MLX'
    let tooltip = 'MLX Console — click for actions'

    if (this.env && !this.env.ready) {
      icon = '$(warning)'
      text = 'MLX: setup'
      tooltip = this.env.message
    } else {
      switch (this.server) {
        case 'starting':
          icon = '$(sync~spin)'
          text = 'MLX: starting'
          tooltip = 'Starting mlx_lm.server…'
          break
        case 'ready':
          if (this.modelState === 'loading') {
            icon = '$(sync~spin)'
            text = `MLX: loading ${this.model ? shortModel(this.model) : 'model'}…`
            tooltip =
              `Reading ${this.model ?? 'model'} into memory. mlx_lm.server loads weights during ` +
              'the first request, so this response starts only once loading finishes.'
          } else if (this.modelState === 'loaded' && this.loadedModel) {
            icon = '$(check)'
            text = `MLX: ${shortModel(this.loadedModel)}`
            tooltip =
              `${this.loadedModel} is resident in memory` +
              (this.lastLoadSeconds !== undefined ? ` (loaded in ${this.lastLoadSeconds}s)` : '') +
              '.\nIt stays loaded until you pick a different model or stop the server — ' +
              'there is no idle timeout.'
          } else {
            icon = '$(check)'
            text = this.model ? `MLX: ${shortModel(this.model)}` : 'MLX: ready'
            tooltip = this.model
              ? `${this.model} selected — weights load on the first request.`
              : 'Server ready — no model loaded yet.'
          }
          break
        case 'error':
          icon = '$(error)'
          text = 'MLX: error'
          tooltip = 'Server error — click to view logs'
          break
        default:
          icon = '$(chip)'
          text = 'MLX'
      }
    }

    this.item.text = `${icon} ${text}`
    this.item.tooltip = tooltip
  }

  dispose() {
    this.item.dispose()
  }
}
