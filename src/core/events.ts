/**
 * Events and disposal, without VSCode.
 *
 * Deliberately shaped like `vscode.EventEmitter`/`vscode.Disposable` — the
 * same `.event` property, the same `dispose()` — so the classes that used them
 * needed no call-site changes when they moved out of the extension. VSCode's
 * own emitters remain assignable to these types, which is what lets the
 * extension keep using its host's implementations where that matters.
 */

export interface Disposable {
  dispose(): void
}

export interface Event<T> {
  (listener: (e: T) => unknown): Disposable
}

export class Emitter<T> {
  private readonly listeners = new Set<(e: T) => unknown>()

  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener)
    return { dispose: () => void this.listeners.delete(listener) }
  }

  fire(value: T): void {
    // Copy first: a listener that unsubscribes itself must not perturb the
    // iteration, and one that throws must not silence the rest.
    for (const listener of [...this.listeners]) {
      try {
        listener(value)
      } catch {
        /* a broken listener is its own problem */
      }
    }
  }

  dispose(): void {
    this.listeners.clear()
  }
}

/** Dispose everything, even if one of them throws. */
export function disposeAll(items: Iterable<Disposable>): void {
  for (const d of items) {
    try {
      d.dispose()
    } catch {
      /* keep going */
    }
  }
}
