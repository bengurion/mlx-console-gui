import { StrictMode, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { onPush, ready } from './api'
import { SearchPage } from './pages/Search'
import { ModelsPage } from './pages/Models'
import { DownloadsPage } from './pages/Downloads'
import { SettingsView } from './pages/SettingsView'
import { ClientsPage } from './pages/Clients'
import { DashboardPage } from './pages/Dashboard'
import { InfoPage } from './pages/Info'
import { SetupPage } from './pages/Setup'
import type { ViewId } from '../../src/shared/protocol'

declare global {
  interface Window {
    __MLX_VIEW__?: ViewId
    /** Switch views in place. Present only when a host shows more than one. */
    __MLX_SHOW__?: (view: ViewId) => void
  }
}

const pages: Record<ViewId, ComponentType> = {
  dashboard: DashboardPage,
  models: ModelsPage,
  search: SearchPage,
  downloads: DownloadsPage,
  settings: SettingsView,
  clients: ClientsPage,
  info: InfoPage,
  setup: SetupPage,
}

const container = document.getElementById('root')

/**
 * Views are mounted once and then hidden, never torn down.
 *
 * In VSCode each view is its own webview with `retainContextWhenHidden`, so
 * collapsing a panel and reopening it does not refetch anything. A browser
 * host showing tabs has to reproduce that deliberately: mounting on every
 * switch would re-run each page's initial load — most visibly a fresh Hugging
 * Face search on every click of the Search tab.
 */
const mounted = new Map<ViewId, { root: Root; el: HTMLElement }>()

function show(view: ViewId): void {
  if (!container) return

  for (const [id, { el }] of mounted) {
    el.style.display = id === view ? '' : 'none'
  }
  if (mounted.has(view)) return

  const el = document.createElement('div')
  container.append(el)
  const root = createRoot(el)
  const Page = pages[view]
  root.render(
    <StrictMode>
      <Page />
    </StrictMode>,
  )
  mounted.set(view, { root, el })
  // Ask the host for the state this view needs, as each webview does on load.
  ready(view)
}

/**
 * Say when the page and the host disagree about which build they are.
 *
 * A stale host does not reject a newer page — it drops whatever it does not
 * recognise, so filters quietly stop filtering and nothing looks broken. A
 * banner is the only way anyone would know to reload.
 */
function warnIfStale(): void {
  onPush<{ host: string; client: string }>('stale', ({ host, client }) => {
    if (document.getElementById('mlx-stale')) return
    const bar = document.createElement('div')
    bar.id = 'mlx-stale'
    bar.className = 'card small'
    bar.style.cssText =
      'border-left:3px solid var(--vscode-editorWarning-foreground,#d29922);margin-bottom:8px'
    bar.textContent =
      'This page was built after the running host started, so some options may do nothing. ' +
      'Reload the window (VS Code) or restart `mlx-console serve`.'
    bar.title = `page ${client} · host ${host}`
    container?.prepend(bar)
  })
}

if (container) {
  window.__MLX_SHOW__ = show
  warnIfStale()
  show(window.__MLX_VIEW__ ?? 'dashboard')
}
