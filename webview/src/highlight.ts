/**
 * Syntax highlighting for the snippets, without a dependency.
 *
 * The snippets are things you copy into a config file, and an unhighlighted
 * wall of text is easy to mis-read — a missing quote, or a comment marker
 * taken for content. A highlighter for three small languages is a few dozen
 * lines; a library would be hundreds of kilobytes and, in the browser host,
 * blocked by the page's own content-security policy anyway.
 *
 * Kept free of JSX so it can be tested directly: the rendering is trivial, the
 * tokenising is where this goes wrong.
 */

export type Language = 'json' | 'yaml' | 'shell'
export type TokenKind = 'text' | 'comment' | 'key' | 'string' | 'number' | 'literal'

export interface Token {
  text: string
  kind: TokenKind
}

/** Theme variables both hosts define, so highlighting follows the theme. */
export const TOKEN_COLORS: Record<TokenKind, string | undefined> = {
  text: undefined,
  comment: 'var(--vscode-descriptionForeground)',
  key: 'var(--vscode-charts-blue, #3794ff)',
  string: 'var(--vscode-testing-iconPassed, #3fb950)',
  number: 'var(--vscode-editorWarning-foreground, #d29922)',
  literal: 'var(--vscode-editorWarning-foreground, #d29922)',
}

/**
 * Guess the language from the shape of the text.
 *
 * Commands are tested before YAML: `-H 'Content-Type: application/json'` looks
 * exactly like a YAML key to a looser test, and mis-detecting it colours half
 * a curl command as configuration.
 */
export function detectLanguage(text: string): Language {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json'
  if (/^\s*(curl|sudo|npm|node|\$|alias|mlx-console|git)\b/m.test(trimmed)) return 'shell'
  if (/^\s*[\w.-]+:\s/m.test(trimmed) || /^\s*-\s+[\w.-]+:/m.test(trimmed)) return 'yaml'
  return 'shell'
}

/**
 * Split one line into coloured pieces.
 *
 * Order matters: a comment swallows the rest of the line, and strings are
 * matched before keys so a colon inside a quoted value is not read as a key
 * separator — which is what `apiBase: http://…` would otherwise become.
 */
export function tokenize(line: string, language: Language): Token[] {
  const out: Token[] = []
  const push = (text: string, kind: TokenKind = 'text') => {
    if (!text) return
    const last = out[out.length - 1]
    // Merge runs of plain text so the DOM does not get a span per character.
    if (last && last.kind === kind && kind === 'text') last.text += text
    else out.push({ text, kind })
  }

  const comment = /^(\s*)(#.*)$/.exec(line)
  if (comment) {
    push(comment[1])
    push(comment[2], 'comment')
    return out
  }

  let rest = line
  while (rest) {
    const str = /^"(?:[^"\\]|\\.)*"/.exec(rest)
    if (str) {
      // A quoted token followed by a colon is a key, not a value.
      const isKey = language === 'json' && /^\s*:/.test(rest.slice(str[0].length))
      push(str[0], isKey ? 'key' : 'string')
      rest = rest.slice(str[0].length)
      continue
    }

    const yamlKey = language !== 'json' && /^(\s*-?\s*)([\w.-]+)(:)(?=\s|$)/.exec(rest)
    if (yamlKey) {
      push(yamlKey[1])
      push(yamlKey[2], 'key')
      push(yamlKey[3])
      rest = rest.slice(yamlKey[0].length)
      continue
    }

    const literal = /^(true|false|null|unused)\b/.exec(rest)
    if (literal) {
      push(literal[0], 'literal')
      rest = rest.slice(literal[0].length)
      continue
    }

    const num = /^-?\d+(\.\d+)?\b/.exec(rest)
    if (num) {
      push(num[0], 'number')
      rest = rest.slice(num[0].length)
      continue
    }

    // Nothing matched here: take one character and continue, so a pattern that
    // never matches cannot loop forever.
    push(rest[0])
    rest = rest.slice(1)
  }
  return out
}
