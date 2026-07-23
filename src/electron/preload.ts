/**
 * The window's bridge to the main process.
 *
 * The dashboard itself needs nothing from here — it talks HTTP to the daemon
 * like any browser. What the desktop shell adds is the few things a web page
 * cannot do: a native folder picker and a look at where the app is installed.
 * Exposed under `window.mlxDesktop`, absent everywhere the page is served to
 * an ordinary browser, so the UI treats it as optional.
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('mlxDesktop', {
  /** Native directory picker; resolves to the chosen path or undefined. */
  pickFolder: (): Promise<string | undefined> => ipcRenderer.invoke('mlx:pickFolder'),
  /** Reveal a path in Finder. */
  openPath: (p: string): Promise<void> => ipcRenderer.invoke('mlx:openPath', p),
})

/**
 * The first-run Setup window's message bus. Client→host goes over IPC; the
 * host's replies and progress pushes come back re-dispatched as window
 * messages, which is the one envelope the React app listens for.
 */
contextBridge.exposeInMainWorld('mlxSetup', {
  post: (msg: unknown) => ipcRenderer.send('mlx:setup', msg),
})
ipcRenderer.on('mlx:setup:push', (_e, msg: unknown) => window.postMessage(msg, '*'))
