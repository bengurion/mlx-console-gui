import * as vscode from 'vscode'
import { SYSTEM_PROMPT, buildCommandPrompt, getEditorContext, EDITOR_COMMANDS } from './prompts'

const HISTORY_TURNS = 6
/** Safety valve on the tool-calling loop so a confused model cannot spin forever. */
const MAX_TOOL_ROUNDS = 8
/** Attached files are inlined; keep any single one from swamping the context. */
const MAX_ATTACHMENT_CHARS = 32_000

/** Registers the `@mlx` chat participant that drives the user-selected model. */
export function registerParticipant(context: vscode.ExtensionContext): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant('mlx-console-gui.mlx', handler)
  participant.iconPath = new vscode.ThemeIcon('chip')
  context.subscriptions.push(participant)
  return participant
}

const handler: vscode.ChatRequestHandler = async (request, context, stream, token) => {
  const command = request.command
  const editorCtx = command && EDITOR_COMMANDS.has(command) ? getEditorContext() : undefined
  const task = buildCommandPrompt(command, request.prompt, editorCtx)

  const attachments = await attachmentMessages(request, stream)

  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(SYSTEM_PROMPT),
    ...historyMessages(context),
    ...attachments,
    vscode.LanguageModelChatMessage.User(task),
  ]

  const model = request.model
  if (!model) {
    stream.markdown(
      'No language model is selected. Pick an **MLX** model in the chat model picker, or run **MLX: Start Server** and download a model first.',
    )
    return {}
  }

  try {
    await runToolLoop(model, messages, availableTools(request), stream, token)
  } catch (err) {
    if (err instanceof vscode.LanguageModelError) {
      stream.markdown(`\n\n_Language model error: ${err.message}_`)
    } else {
      stream.markdown(`\n\n_Error: ${String(err)}_`)
    }
  }
  return {}
}

/**
 * Every tool VSCode knows about — built-ins, other extensions' contributions,
 * and MCP servers the user has configured — narrowed to an explicit `#tool`
 * selection when the request carries one.
 */
function availableTools(request: vscode.ChatRequest): vscode.LanguageModelChatTool[] {
  const all = vscode.lm.tools
  const picked = new Set(request.toolReferences.map((r) => r.name))
  const chosen = picked.size ? all.filter((t) => picked.has(t.name)) : all
  return chosen.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }))
}

/**
 * Drive the model, running any tools it asks for and feeding the results back
 * until it answers in prose (or we hit the round cap).
 */
async function runToolLoop(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  tools: vscode.LanguageModelChatTool[],
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const options: vscode.LanguageModelChatRequestOptions = tools.length ? { tools } : {}

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (token.isCancellationRequested) return

    const response = await model.sendRequest(messages, options, token)
    const calls: vscode.LanguageModelToolCallPart[] = []
    const assistantParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = []

    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        stream.markdown(part.value)
        assistantParts.push(part)
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        calls.push(part)
        assistantParts.push(part)
      }
    }

    if (calls.length === 0) return

    messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts))
    const results: vscode.LanguageModelToolResultPart[] = []

    for (const call of calls) {
      stream.progress(`Running ${call.name}…`)
      try {
        const result = await vscode.lm.invokeTool(
          call.name,
          { input: call.input, toolInvocationToken: undefined },
          token,
        )
        results.push(new vscode.LanguageModelToolResultPart(call.callId, result.content))
      } catch (err) {
        // Report the failure to the model — it can retry or explain, which is
        // more useful than aborting the whole turn.
        results.push(
          new vscode.LanguageModelToolResultPart(call.callId, [
            new vscode.LanguageModelTextPart(`Tool ${call.name} failed: ${String(err)}`),
          ]),
        )
      }
    }
    messages.push(vscode.LanguageModelChatMessage.User(results))
  }

  stream.markdown(`\n\n_Stopped after ${MAX_TOOL_ROUNDS} tool rounds._`)
}

/** Inline files and selections the user attached to the prompt. */
async function attachmentMessages(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
): Promise<vscode.LanguageModelChatMessage[]> {
  const out: vscode.LanguageModelChatMessage[] = []

  for (const ref of request.references) {
    const value = ref.value as unknown
    try {
      if (value instanceof vscode.Uri) {
        const bytes = await vscode.workspace.fs.readFile(value)
        out.push(refMessage(vscode.workspace.asRelativePath(value), decode(bytes)))
        stream.reference(value)
      } else if (value instanceof vscode.Location) {
        const doc = await vscode.workspace.openTextDocument(value.uri)
        const name = `${vscode.workspace.asRelativePath(value.uri)}:${value.range.start.line + 1}-${value.range.end.line + 1}`
        out.push(refMessage(name, doc.getText(value.range)))
        stream.reference(value)
      } else if (typeof value === 'string') {
        out.push(refMessage(ref.id ?? 'context', value))
      }
    } catch (err) {
      out.push(refMessage(ref.id ?? 'attachment', `<could not be read: ${String(err)}>`))
    }
  }
  return out
}

function refMessage(name: string, body: string): vscode.LanguageModelChatMessage {
  const clipped =
    body.length > MAX_ATTACHMENT_CHARS
      ? `${body.slice(0, MAX_ATTACHMENT_CHARS)}\n… (truncated)`
      : body
  return vscode.LanguageModelChatMessage.User(`Attached \`${name}\`:\n\n\`\`\`\n${clipped}\n\`\`\``)
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

function historyMessages(context: vscode.ChatContext): vscode.LanguageModelChatMessage[] {
  const out: vscode.LanguageModelChatMessage[] = []
  for (const turn of context.history.slice(-HISTORY_TURNS)) {
    if (turn instanceof vscode.ChatRequestTurn) {
      out.push(vscode.LanguageModelChatMessage.User(turn.prompt))
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const text = responseTurnText(turn)
      if (text) out.push(vscode.LanguageModelChatMessage.Assistant(text))
    }
  }
  return out
}

function responseTurnText(turn: vscode.ChatResponseTurn): string {
  let text = ''
  for (const part of turn.response) {
    if (part instanceof vscode.ChatResponseMarkdownPart) {
      text += part.value.value
    }
  }
  return text
}
