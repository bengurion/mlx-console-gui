import * as vscode from 'vscode'
import { log } from '../core/logging'
import type { ServerManager } from '../backend/serverManager'

/**
 * Registers the `mlx_modelInfo` language model tool so agent-mode models can
 * query the current MLX server + model state. Consuming other tools / MCP
 * servers needs no registration — that flows through the provider's tool loop.
 */
export function registerTools(context: vscode.ExtensionContext, server: ServerManager): void {
  if (typeof vscode.lm?.registerTool !== 'function') {
    log.warn('vscode.lm.registerTool unavailable; skipping MLX tool registration')
    return
  }

  const tool: vscode.LanguageModelTool<unknown> = {
    async invoke(_options, _token) {
      const status = server.status
      let models: string[] = []
      try {
        if (server.state === 'ready') models = await server.client.listModels()
      } catch (err) {
        log.warn('mlx_modelInfo listModels failed', err)
      }
      const text = [
        `Server state: ${status.state}`,
        `Active model: ${status.activeModel ?? 'none'}`,
        `Base URL: ${status.baseUrl}`,
        `Available models: ${models.length ? models.join(', ') : 'none'}`,
      ].join('\n')
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)])
    },
  }

  try {
    context.subscriptions.push(vscode.lm.registerTool('mlx_modelInfo', tool))
    log.info('Registered mlx_modelInfo language model tool')
  } catch (err) {
    log.error('Failed to register mlx_modelInfo tool', err)
  }
}
