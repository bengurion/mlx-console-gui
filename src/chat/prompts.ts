import * as vscode from 'vscode'
import * as path from 'node:path'

export const SYSTEM_PROMPT = [
  'You are MLX, an expert, concise coding assistant running locally via mlx-lm on Apple Silicon.',
  'Prefer correct, idiomatic, minimal code. Use GitHub-flavored Markdown with fenced code blocks tagged by language.',
  'When proposing edits, show only the relevant changes. Be direct; skip filler.',
].join(' ')

const MAX_CODE_CHARS = 8000

export interface EditorContext {
  code: string
  languageId: string
  fileName: string
  selection: boolean
}

/** Snapshot the active editor's selection (or whole file) for command context. */
export function getEditorContext(): EditorContext | undefined {
  const ed = vscode.window.activeTextEditor
  if (!ed) return undefined
  const hasSel = !ed.selection.isEmpty
  let code = hasSel ? ed.document.getText(ed.selection) : ed.document.getText()
  if (code.length > MAX_CODE_CHARS) code = code.slice(0, MAX_CODE_CHARS) + '\n/* …truncated… */'
  return {
    code,
    languageId: ed.document.languageId,
    fileName: path.basename(ed.document.fileName || 'untitled'),
    selection: hasSel,
  }
}

export const EDITOR_COMMANDS = new Set(['explain', 'fix', 'review', 'test', 'doc'])

function fence(ctx: EditorContext): string {
  const where = ctx.selection ? 'selected' : 'full-file'
  return `Context — ${where} ${ctx.languageId} from \`${ctx.fileName}\`:\n\n\`\`\`${ctx.languageId}\n${ctx.code}\n\`\`\``
}

/** Build the user task string for a slash command (or plain chat). */
export function buildCommandPrompt(
  command: string | undefined,
  userPrompt: string,
  ctx: EditorContext | undefined,
): string {
  const extra = userPrompt.trim() ? `\n\nAdditional instructions: ${userPrompt.trim()}` : ''
  const code = ctx ? `\n\n${fence(ctx)}` : ''

  switch (command) {
    case 'explain':
      return `Explain what the following code does, step by step, and call out anything subtle or risky.${code}${extra}`
    case 'fix':
      return `Find and fix bugs or issues in the following code. First briefly explain the problem, then provide the corrected code.${code}${extra}`
    case 'test':
      return `Write focused unit tests for the following code. Use the idiomatic test framework for the language.${code}${extra}`
    case 'doc':
      return `Write clear documentation (docstrings / comments) for the following code without changing its behavior.${code}${extra}`
    case 'review':
      return `Review the following code. Report concrete issues as a list with severity (blocker / major / minor / nit), the location, and a suggested fix. Be specific.${code}${extra}`
    default:
      return `${userPrompt.trim()}${code}`
  }
}
