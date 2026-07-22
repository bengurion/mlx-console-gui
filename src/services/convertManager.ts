import * as vscode from 'vscode'
import { spawn } from 'node:child_process'
import * as os from 'node:os'
import * as path from 'node:path'
import { log } from '../core/logging'
import { Config } from '../config'
import { mlxProcessEnv } from '../util/env'
import {
  CONVERT_BITS,
  bytesForBits,
  chooseQuantBits,
  explainFit,
  formatBytes,
  parseParamsB,
  isGguf,
} from './modelFit'
import type { EnvironmentManager } from '../backend/environmentManager'
import type { ServerManager } from '../backend/serverManager'

/**
 * Converts a Hugging Face model into MLX format via `mlx_lm.convert`, choosing
 * the highest quantization that fits this machine's memory budget.
 */
export class ConvertManager {
  constructor(
    private readonly env: EnvironmentManager,
    private readonly server: ServerManager,
  ) {}

  private budgetBytes(): number {
    return Math.floor(os.totalmem() * 0.75)
  }

  /** Default output root for converted models. */
  private outputRoot(): string {
    const modelsDir = Config.modelsDir()
    return modelsDir
      ? path.join(modelsDir, 'mlx-converted')
      : path.join(os.homedir(), 'mlx-models')
  }

  /** Full interactive flow: pick source, pick bits, convert, offer to use it. */
  async convertInteractive(sourceRepo?: string): Promise<void> {
    if (!(await this.env.ensureReady(true))) return

    const repo =
      sourceRepo ??
      (await vscode.window.showInputBox({
        title: 'Convert model to MLX',
        prompt: 'Hugging Face repo id (full-precision source), e.g. Qwen/Qwen2.5-Coder-7B-Instruct',
        ignoreFocusOut: true,
        validateInput: (v) => (v.includes('/') ? undefined : 'Expected owner/name'),
      }))
    if (!repo) return

    if (isGguf(repo)) {
      void vscode.window.showErrorMessage(
        'MLX: GGUF repos cannot be converted — mlx_lm.convert only accepts Hugging Face format models.',
      )
      return
    }

    const budget = this.budgetBytes()
    const paramsB = parseParamsB(repo)
    const recommended = chooseQuantBits(paramsB, budget)

    const totalRam = os.totalmem()

    const picks = CONVERT_BITS.map((bits) => {
      const est = paramsB ? bytesForBits(paramsB, bits) : undefined
      const fit = est ? explainFit(est, budget, totalRam) : undefined
      return {
        label: `${bits}-bit${bits === recommended ? '  (recommended)' : ''}`,
        description: fit ? `≈ ${formatBytes(est!)}  — ${fit.summary}` : undefined,
        detail:
          bits === recommended
            ? `Highest quantization that fits ${formatBytes(budget)} of usable memory`
            : fit?.detail,
        bits,
      }
    })
    if (recommended === undefined && paramsB) {
      // Even the smallest quantization is past the budget — say whether that means
      // "impossible" or merely "only with everything else closed".
      const smallest = explainFit(bytesForBits(paramsB, CONVERT_BITS.at(-1)!), budget, totalRam)
      void vscode.window.showWarningMessage(
        `MLX: ${repo} (~${paramsB}B params) does not fit ${formatBytes(budget)} of usable memory even at ` +
          `${CONVERT_BITS.at(-1)}-bit. ${smallest.detail}`,
      )
    }

    const chosen = await vscode.window.showQuickPick(picks, {
      title: `Quantization for ${repo}`,
      placeHolder: paramsB
        ? `~${paramsB}B parameters · ${formatBytes(budget)} usable of ${formatBytes(totalRam)} unified memory`
        : 'Parameter count unknown — pick a bit width',
    })
    if (!chosen) return

    const outPath = path.join(this.outputRoot(), `${repo.split('/').pop()}-${chosen.bits}bit`)
    await this.run(repo, outPath, chosen.bits)
  }

  private async run(repo: string, outPath: string, bits: number): Promise<void> {
    const bin = this.env.binPath('mlx_lm.convert')
    const args = [
      '--hf-path',
      repo,
      '--mlx-path',
      outPath,
      '-q',
      '--q-bits',
      String(bits),
      '--q-group-size',
      '64',
    ]
    log.info(`Converting: ${bin} ${args.join(' ')}`)

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `MLX: converting ${repo} → ${bits}-bit`,
        cancellable: true,
      },
      (progress, token) =>
        new Promise<void>((resolve) => {
          const child = spawn(bin, args, { env: mlxProcessEnv() })
          token.onCancellationRequested(() => child.kill('SIGTERM'))

          const onData = (d: Buffer) => {
            const text = d.toString().trimEnd()
            if (!text) return
            log.info(`[convert] ${text}`)
            progress.report({ message: text.split('\n').pop()?.slice(0, 80) })
          }
          child.stdout?.on('data', onData)
          child.stderr?.on('data', onData)

          child.on('error', (err) => {
            log.error('convert failed to start', err)
            void vscode.window.showErrorMessage(`MLX convert failed: ${String(err)}`)
            resolve()
          })

          child.on('close', (code) => {
            if (token.isCancellationRequested) {
              void vscode.window.showWarningMessage('MLX: conversion canceled.')
              return resolve()
            }
            if (code === 0) {
              void this.onConverted(outPath)
            } else {
              void vscode.window.showErrorMessage(
                `MLX: conversion exited with code ${code}. See MLX Console logs.`,
              )
              log.show()
            }
            resolve()
          })
        }),
    )
  }

  private async onConverted(outPath: string) {
    log.info(`Converted model saved to ${outPath}`)
    const pick = await vscode.window.showInformationMessage(
      `MLX: converted model saved to ${outPath}`,
      'Set as default',
      'Launch',
      'Reveal',
    )
    if (pick === 'Set as default') {
      await vscode.workspace
        .getConfiguration('mlxConsole')
        .update('defaultModel', outPath, vscode.ConfigurationTarget.Global)
    } else if (pick === 'Launch') {
      await this.server.warmUp(outPath)
    } else if (pick === 'Reveal') {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outPath))
    }
  }
}
