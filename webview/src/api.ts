import type { HostBound, RpcMethod, ViewId, WebviewBound } from '../../src/shared/protocol'

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void
  getState(): unknown
  setState(state: unknown): void
}

const vscodeApi = acquireVsCodeApi()

let seq = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

type PushName = Extract<WebviewBound, { type: 'push' }>['name']
const handlers = new Map<PushName, Set<(data: unknown) => void>>()

window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as WebviewBound
  if (msg.type === 'rpcResult') {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new Error(msg.error))
  } else if (msg.type === 'push') {
    handlers.get(msg.name)?.forEach((h) => h(msg.data))
  }
})

function post(msg: HostBound) {
  vscodeApi.postMessage(msg)
}

export function rpc<T = unknown>(method: RpcMethod, params?: unknown): Promise<T> {
  const id = ++seq
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    post({ type: 'rpc', id, method, params })
  })
}

export function onPush<T = unknown>(name: PushName, handler: (data: T) => void): () => void {
  let set = handlers.get(name)
  if (!set) {
    set = new Set()
    handlers.set(name, set)
  }
  const h = handler as (d: unknown) => void
  set.add(h)
  return () => {
    set!.delete(h)
  }
}

/** Build id stamped in by esbuild; `dev` when the bundle was not built by it. */
declare const __BUILD_ID__: string | undefined
export const BUILD = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'

export function ready(view: ViewId) {
  post({ type: 'ready', view, build: BUILD })
}
export function openExternal(url: string) {
  post({ type: 'openExternal', url })
}
export function copy(text: string) {
  post({ type: 'copy', text })
}
export function openSettings(query?: string) {
  post({ type: 'openSettings', query })
}
