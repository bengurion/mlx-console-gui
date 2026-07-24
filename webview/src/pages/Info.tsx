import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import readme from '../../../README.md'
import { openExternal } from '../api'

/**
 * The full README, inside the app.
 *
 * Embedded at build time (esbuild loads .md as text), so there is no runtime
 * file plumbing and every host that ships the bundle ships its docs. A sticky
 * table of contents built from the section headings keeps a long document
 * navigable. Mermaid fences render as code blocks — the diagrams' text reads
 * fine, and a renderer would cost a megabyte.
 */
export function InfoPage() {
  const html = useMemo(() => marked.parse(readme, { async: false }), [])
  const bodyRef = useRef<HTMLDivElement>(null)
  const [sections, setSections] = useState<{ id: string; text: string }[]>([])

  // marked emits bare <h2>s; give each an id so the contents can jump to it.
  useEffect(() => {
    const root = bodyRef.current
    if (!root) return
    const found: { id: string; text: string }[] = []
    root.querySelectorAll('h2').forEach((h) => {
      const text = h.textContent ?? ''
      const id = 'sec-' + text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      h.id = id
      found.push({ id, text })
    })
    setSections(found)

    // GitHub alert syntax ([!NOTE] etc.) is plain text to marked; dress those
    // blockquotes as the callouts they are meant to be.
    root.querySelectorAll('blockquote').forEach((q) => {
      const p = q.querySelector('p')
      const m = p?.textContent?.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/)
      if (!m || !p) return
      p.innerHTML = p.innerHTML.replace(/^\[!\w+\]\s*(<br\s*\/?>)?\s*/, '')
      const kind = m[1]
      const color =
        kind === 'WARNING' || kind === 'CAUTION' ? 'var(--viz-warn, #b45309)' : 'var(--viz-1, #4f46e5)'
      const label = document.createElement('div')
      label.textContent = kind.charAt(0) + kind.slice(1).toLowerCase()
      label.style.cssText = `font-weight:600;font-size:0.8em;text-transform:uppercase;letter-spacing:0.06em;color:${color}`
      const el = q as HTMLElement
      el.style.borderLeftColor = color
      el.prepend(label)
    })
  }, [html])

  return (
    <div style={{ display: 'flex', gap: 28, alignItems: 'flex-start' }}>
      {sections.length > 1 && (
        <nav
          className="col small"
          aria-label="Contents"
          style={{ position: 'sticky', top: 0, flex: '0 0 210px', gap: 4, paddingTop: 4 }}
        >
          <span className="muted" style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: '0.8em' }}>
            Contents
          </span>
          {sections.map((s) => (
            <a
              key={s.id}
              onClick={() =>
                bodyRef.current?.querySelector(`#${s.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
            >
              {s.text}
            </a>
          ))}
        </nav>
      )}

      <div
        ref={bodyRef}
        className="prose"
        style={{ minWidth: 0, flex: 1 }}
        // Our own README, embedded at build time — not user input.
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={(e) => {
          // External links leave through the host (browser tab / default
          // browser), not by navigating the app window away from the dashboard.
          const a = (e.target as HTMLElement).closest('a')
          if (a?.href && /^https?:/.test(a.href)) {
            e.preventDefault()
            openExternal(a.href)
          }
        }}
      />
    </div>
  )
}
