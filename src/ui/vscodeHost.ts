/**
 * The editor half of the hosts the core can run under.
 *
 * Everything here is a translation: settings to `workspace.getConfiguration`,
 * prompts to modals, progress to a notification, elevation to a terminal the
 * user can read. The core asks in host-neutral terms; this decides what that
 * looks like in VSCode. The CLI answers the same questions on stdout.
 */
import * as vscode from 'vscode'
import * as path from 'node:path'
import type { SettingsSource } from '../core/settings'
import type { EnvHost } from '../backend/environmentManager'
import type { HubHost } from './webview/webviewHub'
import { SECTION } from '../config'

/** Settings backed by VSCode's configuration, including its scope rules. */
export class VsCodeSettings implements SettingsSource {
  private cfg() {
    return vscode.workspace.getConfiguration(SECTION)
  }

  get<T>(key: string, fallback: T): T {
    return this.cfg().get<T>(key, fallback)
  }

  /**
   * Whether the user set this, at any scope.
   *
   * `get` cannot answer it: a setting left alone and a setting deliberately
   * set to the default read identically. Several values fall back to the
   * model's own metadata when untouched, so the difference decides whether the
   * model or the user wins.
   */
  isExplicit(key: string): boolean {
    const i = this.cfg().inspect(key)
    return (i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue) !== undefined
  }

  async update(key: string, value: unknown): Promise<void> {
    await this.cfg().update(key, value, vscode.ConfigurationTarget.Global)
  }
}

/** Environment prompts, as VSCode dialogs. */
export function vscodeEnvHost(context: vscode.ExtensionContext): EnvHost {
  return {
    storageDir: context.globalStorageUri.fsPath,

    // A project's own .venv is preferred over the managed one when it already
    // has mlx-lm, so opening a repo that ships an environment just works.
    extraVenvDirs: () =>
      (vscode.workspace.workspaceFolders ?? []).flatMap((f) => [
        path.join(f.uri.fsPath, '.venv'),
        path.join(f.uri.fsPath, 'venv'),
      ]),

    confirm: async (message, detail, action) =>
      (await vscode.window.showInformationMessage(message, { modal: true, detail }, action)) === action,

    reportError: async (message, action) => {
      const pick = action
        ? await vscode.window.showErrorMessage(message, action)
        : void vscode.window.showErrorMessage(message)
      if (pick === 'Open Settings') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'mlxConsole.pythonPath')
      }
      return pick ?? undefined
    },

    reportInfo: (message) => void vscode.window.showInformationMessage(message),

    // withProgress returns a Thenable; the core wants a Promise.
    progress: async (title, task) =>
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: false },
        (progress) => task((message) => progress.report({ message })),
      ),
  }
}

/**
 * Elevation, in a terminal the user can inspect.
 *
 * Deliberately not a password prompt of our own: the command is shown, `sudo`
 * is entered by the user, and nothing here ever sees the password.
 */
export async function vscodeElevate(args: string[]): Promise<boolean> {
  const choice = await vscode.window.showInformationMessage(
    'Per-process GPU attribution needs root.',
    {
      modal: true,
      detail:
        `Runs:\n  sudo ${args.join(' ')}\n\n` +
        'powermetrics is read-only telemetry. It runs in a terminal so you enter your own ' +
        'password — the extension never sees it. This reports GPU time per process; macOS ' +
        'has no per-process GPU memory accounting.',
    },
    'Run in Terminal',
  )
  if (choice !== 'Run in Terminal') return false

  const term = vscode.window.createTerminal('MLX: per-process GPU')
  term.show()
  term.sendText(`sudo ${args.join(' ')}`)
  return true
}

/** The hub's interactive acts, as VSCode dialogs. */
export function vscodeHubHost(): HubHost {
  return {
    confirm: async ({ message, detail, action }) =>
      (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action,

    reportError: (message) => void vscode.window.showErrorMessage(message),
    reportInfo: (message) => void vscode.window.showInformationMessage(message),

    // A terminal, not a hidden sudo: the command is visible and the password
    // is typed by the user into their own shell.
    runElevated: (command, title) => {
      const term = vscode.window.createTerminal(title)
      term.show()
      term.sendText(command)
      return true
    },

    progress: async (title, task) =>
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title },
        () => task(),
      ),

    openExternal: (url) => void vscode.env.openExternal(vscode.Uri.parse(url)),
    copy: (text) => Promise.resolve(vscode.env.clipboard.writeText(text)).then(() => {}),
    // Our own settings view, not the editor's settings editor: every value is
    // editable in this UI, and sending people elsewhere to change one is the
    // thing that is being removed.
    openSettings: () => void vscode.commands.executeCommand('mlxConsole.server.focus'),
  }
}
