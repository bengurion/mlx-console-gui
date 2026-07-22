import { StrictMode, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { ready } from './api'
import { SearchPage } from './pages/Search'
import { ModelsPage } from './pages/Models'
import { DownloadsPage } from './pages/Downloads'
import { ServerPage } from './pages/Server'
import type { ViewId } from '../../src/shared/protocol'

declare global {
  interface Window {
    __MLX_VIEW__?: ViewId
  }
}

const view: ViewId = window.__MLX_VIEW__ ?? 'server'

const pages: Record<ViewId, ComponentType> = {
  search: SearchPage,
  models: ModelsPage,
  downloads: DownloadsPage,
  server: ServerPage,
}

const Page = pages[view]
const container = document.getElementById('root')
if (container) {
  createRoot(container).render(
    <StrictMode>
      <Page />
    </StrictMode>,
  )
  ready(view)
}
