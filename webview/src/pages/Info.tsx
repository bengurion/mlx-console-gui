import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import mermaid from 'mermaid'
import readme from '../../../README.md'
import { openExternal } from '../api'

/**
 * The full README, inside the app.
 *
 * Embedded at build time (esbuild loads .md as text), so there is no runtime
 * file plumbing and every host that ships the bundle ships its docs. The
 * document is long, so each top-level section becomes a tab — nobody scrolls
 * a 700-line page — with the small tail sections folded into one "About" tab.
 * Mermaid fences render as real diagrams; the bundle cost is what it is, and
 * a diagram you can read beats a code block you have to imagine.
 */

/** Small tail sections fold into shared tabs instead of five one-liner tabs. */
const MERGE: Record<string, string> = {
  Status: 'About',
  Contributing: 'About',
  Author: 'About',
  License: 'About',
  'Settings reference': 'Configuration',
}

/** Long README headings, shortened to fit a tab. */
const RENAME: Record<string, string> = {
  'One system, three front ends': 'Overview',
  'The web dashboard': 'Dashboard',
  'Headless mode': 'Headless',
  'Calling the API': 'API',
}

/**
 * `html` is the exact object handed to dangerouslySetInnerHTML. React 19
 * diffs that prop by object identity and resets innerHTML on mismatch, so a
 * fresh `{ __html }` per render would wipe the heading ids and rendered
 * diagrams this page adds to the DOM on every tab switch.
 */
type Tab = { label: string; html: { __html: string } }

/** Split the README at each `## ` heading (outside code fences) into tabs. */
function buildTabs(md: string): Tab[] {
  const parts: { title: string; lines: string[] }[] = [{ title: 'Overview', lines: [] }]
  let inFence = false
  let inTabBar = false
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence
    // Screenshots ship in the repo, not in this bundle — a broken-image icon
    // of the very page being looked at helps nobody.
    if (!inFence && /^!\[.*\]\(print_screens\//.test(line.trim())) continue
    // GitHub's stand-in for these very tabs; here the real ones exist.
    if (!inFence && line.trim() === '<!-- tabs -->') inTabBar = true
    if (inTabBar) {
      if (line.trim() === '<!-- /tabs -->') inTabBar = false
      continue
    }
    const m = inFence ? null : line.match(/^## +(.+)/)
    if (m) parts.push({ title: m[1].trim(), lines: [line] })
    else parts[parts.length - 1].lines.push(line)
  }
  const tabs: { label: string; md: string[] }[] = []
  const byLabel = new Map<string, { label: string; md: string[] }>()
  for (const p of parts) {
    const label = MERGE[p.title] ?? RENAME[p.title] ?? p.title
    let tab = byLabel.get(label)
    if (!tab) {
      tab = { label, md: [] }
      byLabel.set(label, tab)
      tabs.push(tab)
    }
    tab.md.push(p.lines.join('\n'))
  }
  return tabs.map((t) => ({
    label: t.label,
    html: { __html: marked.parse(t.md.join('\n\n'), { async: false }) },
  }))
}

/** GitHub-style heading slug, so the README's own `](#install)` links resolve. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\- ]+/g, '')
    .replace(/ +/g, '-')
}

/**
 * Both hosts stamp the theme as a class, and the class is authoritative:
 * the dashboard folds the OS preference into `.dark` before first paint, so
 * consulting prefers-color-scheme here would override an explicit choice.
 */
function isDark(): boolean {
  const body = document.body.classList
  if (body.contains('vscode-high-contrast-light')) return false
  if (body.contains('vscode-dark') || body.contains('vscode-high-contrast')) return true
  if (body.contains('vscode-light')) return false
  return document.documentElement.classList.contains('dark')
}

export function InfoPage() {
  const tabs = useMemo(() => buildTabs(readme), [])
  const [active, setActive] = useState(0)
  const [dark, setDark] = useState(isDark)
  const bodyRef = useRef<HTMLDivElement>(null)
  // Set when a #anchor click switches tabs: scroll there instead of to the top.
  const pendingAnchor = useRef<string | null>(null)

  // One-time DOM pass over every tab: heading ids for anchor links, GitHub
  // alert callouts, and mermaid fences swapped for divs holding their source.
  useEffect(() => {
    const root = bodyRef.current
    if (!root) return

    root.querySelectorAll('h1, h2, h3, h4').forEach((h) => {
      if (!h.id) h.id = slug(h.textContent ?? '')
    })

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

    root.querySelectorAll('code.language-mermaid').forEach((code) => {
      const pre = code.closest('pre')
      if (!pre) return
      const div = document.createElement('div')
      div.className = 'mermaid'
      div.dataset.src = code.textContent ?? ''
      div.textContent = code.textContent
      pre.replaceWith(div)
    })
  }, [])

  // The hosts flip a class to change theme; re-render diagrams when they do.
  useEffect(() => {
    const update = () => setDark(isDark())
    const mo = new MutationObserver(update)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', update)
    return () => {
      mo.disconnect()
      mq.removeEventListener('change', update)
    }
  }, [])

  // Render diagrams in the visible tab only: mermaid measures text with
  // getBBox, which reports zero inside display:none, so hidden tabs wait
  // until they are shown. A theme flip marks rendered diagrams stale.
  useEffect(() => {
    const section = bodyRef.current?.querySelector(`[data-tab="${active}"]`)
    if (!section) return
    const theme = dark ? 'dark' : 'neutral'
    const stale = [...section.querySelectorAll<HTMLElement>('.mermaid')].filter(
      (el) => el.dataset.theme !== theme,
    )
    if (!stale.length) return
    for (const el of stale) {
      el.dataset.theme = theme
      el.removeAttribute('data-processed')
      el.textContent = el.dataset.src ?? ''
    }
    mermaid.initialize({ startOnLoad: false, theme, fontFamily: 'inherit' })
    void mermaid.run({ nodes: stale, suppressErrors: true })
  }, [active, dark])

  // Tab switches start at the top — unless an anchor asked for a heading.
  useEffect(() => {
    const anchor = pendingAnchor.current
    pendingAnchor.current = null
    if (anchor) {
      bodyRef.current
        ?.querySelector(`#${CSS.escape(anchor)}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else {
      // The dashboard scrolls a <main>, the VS Code webview scrolls the page.
      const scroller = bodyRef.current?.closest('main') ?? document.scrollingElement
      if (scroller) scroller.scrollTop = 0
    }
  }, [active])

  return (
    <div style={{ minWidth: 0 }}>
      <nav className="doc-tabs" aria-label="Sections">
        {tabs.map((t, i) => (
          <button
            key={t.label}
            className={i === active ? 'active' : undefined}
            onClick={() => setActive(i)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div
        ref={bodyRef}
        className="prose"
        onClick={(e) => {
          const a = (e.target as HTMLElement).closest('a')
          if (!a?.getAttribute('href')) return
          const href = a.getAttribute('href')!
          // External links leave through the host (browser tab / default
          // browser), not by navigating the app window away from the dashboard.
          if (/^https?:/.test(href)) {
            e.preventDefault()
            openExternal(a.href)
            return
          }
          // The README's own #anchors may point into another tab.
          if (href.startsWith('#')) {
            e.preventDefault()
            const id = decodeURIComponent(href.slice(1))
            const target = bodyRef.current?.querySelector(`#${CSS.escape(id)}`)
            const section = target?.closest<HTMLElement>('[data-tab]')
            if (!target || !section) return
            const idx = Number(section.dataset.tab)
            if (idx === active) {
              target.scrollIntoView({ behavior: 'smooth', block: 'start' })
            } else {
              pendingAnchor.current = id
              setActive(idx)
            }
          }
        }}
      >
        {tabs.map((t, i) => (
          <section
            key={t.label}
            data-tab={i}
            style={{ display: i === active ? undefined : 'none' }}
            // Our own README, embedded at build time — not user input.
            dangerouslySetInnerHTML={t.html}
          />
        ))}
      </div>
    </div>
  )
}
