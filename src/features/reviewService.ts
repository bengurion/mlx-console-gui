import * as vscode from 'vscode'
import * as path from 'node:path'
import { log } from '../core/logging'

const REVIEW_SYSTEM = [
  'You are a meticulous senior code reviewer.',
  'Report concrete, actionable issues as a Markdown list.',
  'For each finding include a severity (blocker / major / minor / nit), the location, and a suggested fix.',
  'Be specific and concise; do not restate the whole file.',
].join(' ')

const DIAGNOSTIC_INSTRUCTION = [
  '\n\nAt the very end, append a fenced ```json code block containing an array named findings',
  'of objects {"line": number, "severity": "error"|"warning"|"info", "message": string},',
  'using 1-based line numbers for this file. Emit an empty array if there are no issues.',
].join(' ')

/** Runs code reviews over the active file or the current git diff. */
export class ReviewService {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('mlx-review')

  dispose() {
    this.diagnostics.dispose()
  }

  async reviewActiveFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
      void vscode.window.showWarningMessage('MLX: open a file to review.')
      return
    }
    const doc = editor.document
    const lang = doc.languageId
    const name = path.basename(doc.fileName || 'untitled')
    const numbered = numberLines(doc.getText())
    const content = `Review this ${lang} file \`${name}\` (line numbers are shown):\n\n\`\`\`${lang}\n${numbered}\n\`\`\`${DIAGNOSTIC_INSTRUCTION}`
    const text = await this.run(content, `Reviewing ${name}…`)
    if (text) await this.present(text, doc.uri)
  }

  async reviewGitDiff(): Promise<void> {
    const diff = await getGitDiff()
    if (!diff) {
      void vscode.window.showInformationMessage('MLX: no staged or working-tree changes to review.')
      return
    }
    const content = `Review the following git diff. Focus on the changed (+) lines and their impact.\n\n\`\`\`diff\n${clip(diff, 16000)}\n\`\`\``
    const text = await this.run(content, 'Reviewing git diff…')
    if (text) await this.present(text)
  }

  private async run(userContent: string, title: string): Promise<string | undefined> {
    const model = await pickModel()
    if (!model) {
      void vscode.window.showWarningMessage(
        'MLX: no language model available. Start the server and download a model first.',
      )
      return undefined
    }
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `MLX: ${title}`, cancellable: true },
      async (_progress, token) => {
        try {
          const messages = [
            vscode.LanguageModelChatMessage.User(REVIEW_SYSTEM),
            vscode.LanguageModelChatMessage.User(userContent),
          ]
          const response = await model.sendRequest(messages, {}, token)
          let text = ''
          for await (const fragment of response.text) text += fragment
          return text
        } catch (err) {
          log.error('review failed', err)
          void vscode.window.showErrorMessage(`MLX review failed: ${String(err)}`)
          return undefined
        }
      },
    )
  }

  private async present(text: string, fileUri?: vscode.Uri): Promise<void> {
    const { markdown, findings } = splitFindings(text)
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: markdown })
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true })
    if (fileUri && findings) this.applyDiagnostics(fileUri, findings)
  }

  private applyDiagnostics(uri: vscode.Uri, findings: Finding[]): void {
    this.diagnostics.delete(uri)
    const diags = findings.map((f) => {
      const line = Math.max(0, (f.line ?? 1) - 1)
      return new vscode.Diagnostic(
        new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
        f.message,
        severityOf(f.severity),
      )
    })
    if (diags.length) this.diagnostics.set(uri, diags)
  }
}

interface Finding {
  line?: number
  severity?: string
  message: string
}

async function pickModel(): Promise<vscode.LanguageModelChat | undefined> {
  try {
    let models = await vscode.lm.selectChatModels({ vendor: 'mlx' })
    if (models.length === 0) models = await vscode.lm.selectChatModels()
    return models[0]
  } catch {
    return undefined
  }
}

async function getGitDiff(): Promise<string | undefined> {
  const ext = vscode.extensions.getExtension('vscode.git')
  if (!ext) return undefined
  try {
    const gitExt = ext.isActive ? ext.exports : await ext.activate()
    const api = (gitExt as { getAPI(v: number): unknown }).getAPI(1) as {
      repositories: Array<{ diff(staged?: boolean): Promise<string> }>
    }
    const repo = api.repositories[0]
    if (!repo) return undefined
    const staged = await repo.diff(true)
    if (staged && staged.trim()) return staged
    const unstaged = await repo.diff(false)
    return unstaged && unstaged.trim() ? unstaged : undefined
  } catch (err) {
    log.warn('getGitDiff failed', err)
    return undefined
  }
}

function splitFindings(text: string): { markdown: string; findings?: Finding[] } {
  const match = text.match(/```json\s*([\s\S]*?)```\s*$/)
  if (!match) return { markdown: text }
  try {
    const parsed = JSON.parse(match[1]) as Finding[] | { findings?: Finding[] }
    const findings = Array.isArray(parsed) ? parsed : (parsed.findings ?? [])
    const markdown = text.slice(0, match.index).trimEnd()
    return { markdown, findings }
  } catch {
    return { markdown: text }
  }
}

function severityOf(s?: string): vscode.DiagnosticSeverity {
  switch ((s ?? '').toLowerCase()) {
    case 'error':
    case 'blocker':
      return vscode.DiagnosticSeverity.Error
    case 'warning':
    case 'major':
      return vscode.DiagnosticSeverity.Warning
    default:
      return vscode.DiagnosticSeverity.Information
  }
}

function numberLines(code: string): string {
  return code
    .split('\n')
    .map((line, i) => `${i + 1}\t${line}`)
    .join('\n')
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '\n… (truncated)' : s
}
