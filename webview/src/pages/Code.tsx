import { TOKEN_COLORS, detectLanguage, tokenize, type Language } from '../highlight'

/**
 * A highlighted code block.
 *
 * All the judgement lives in `highlight.ts`; this only turns tokens into
 * spans. Line breaks are real elements rather than relying on `pre` wrapping,
 * so a long line can scroll horizontally instead of forcing the card wider.
 */
export function Code({ text, language }: { text: string; language?: Language }) {
  const lang = language ?? detectLanguage(text)

  return (
    <pre className="snippet" style={{ overflowX: 'auto', whiteSpace: 'pre' }}>
      {text.split('\n').map((line, row) => {
        const tokens = tokenize(line, lang)
        return (
          <div key={row}>
            {tokens.length === 0
              ? // An empty line still needs height.
                ' '
              : tokens.map((t, i) => (
                  <span key={i} style={{ color: TOKEN_COLORS[t.kind] }}>
                    {t.text}
                  </span>
                ))}
          </div>
        )
      })}
    </pre>
  )
}
