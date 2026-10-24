'use client'

// #662: a component that is a chunk of its own, loaded the first time it has to show (`when`, or its first render).
// It renders nothing until then: no fallback text that the component would then replace, and nothing the screen reader
// could announce before the real content. Once loaded it stays mounted, so a dialog keeps its state between two
// openings, as it did when it was in the first bundle. Plain React (no next/dynamic): the same file runs in the Next
// app and in the Vite bundles of the webview and the standalone app.

import { useEffect, useState, type ComponentType, type ReactElement } from 'react'

interface LazyOptions<P> {
  /** Load and show only once this is true (a dialog: its `open` prop). Without it the first render loads. */
  when?: (props: P) => boolean
}

export interface LazyComponent<P> {
  (props: P): ReactElement | null
  /** Loads the chunk ahead of time (tests, or a hover); later renders show the component at once */
  preload: () => Promise<void>
}

export function lazyComponent<P extends object>(load: () => Promise<ComponentType<P>>, options: LazyOptions<P> = {}): LazyComponent<P> {
  let loaded: ComponentType<P> | null = null
  let pending: Promise<void> | null = null
  const preload = (): Promise<void> => {
    if (loaded) return Promise.resolve()
    if (!pending) {
      pending = load().then(c => { loaded = c }).finally(() => { pending = null })
    }
    return pending
  }

  function Lazy(props: P): ReactElement | null {
    const wanted = options.when ? options.when(props) : true
    const [Component, setComponent] = useState<ComponentType<P> | null>(() => loaded)
    useEffect(() => {
      if (Component || !wanted) return
      let live = true
      preload().then(
        () => { if (live) setComponent(() => loaded) },
        (err: unknown) => { console.error('[lazy] a chunk did not load', err) },
      )
      return () => { live = false }
    }, [Component, wanted])
    return Component ? <Component {...props} /> : null
  }

  return Object.assign(Lazy, { preload })
}
