'use client'

import { createContext, useContext, useEffect, useRef } from 'react'
import { runEscapeHandlers } from '../lib/chrome-utils'

/**
 * Handler for Escape: collapse/close the panel and return true, or return false when there
 * is nothing to close (so Escape can fall through to the next panel or the selection).
 */
export type PanelEscapeHandler = () => boolean

/** Registers a handler; the returned function unregisters it. */
export type RegisterPanel = (id: string, onEscape: PanelEscapeHandler) => () => void

/** Registry state behind the Escape stack (pure: no React), used by AgentVisualizer. */
export interface PanelRegistry {
  register: RegisterPanel
  /** Ask the registered panels (newest first) to close; true when one did. */
  escape: () => boolean
  /** Ids of the registered panels, oldest first (diagnostics and tests) */
  ids: () => string[]
}

/**
 * Contract: registering an id that already exists replaces the earlier handler (and moves it to the
 * top of the stack); unregistering a replaced registration is a no-op for the new one; `escape`
 * stops at the first handler (newest first) that returns true.
 */
export function createPanelRegistry(): PanelRegistry {
  let entries: Array<{ id: string; onEscape: PanelEscapeHandler }> = []
  return {
    register(id, onEscape) {
      const entry = { id, onEscape }
      entries = [...entries.filter(p => p.id !== id), entry]
      return () => { entries = entries.filter(p => p !== entry) }
    },
    // A throwing handler must neither break Escape for the panels below it nor leave the key press
    // half-handled: it counts as "nothing to close" and the next panel is asked.
    escape: () => runEscapeHandlers(entries.map(p => () => {
      try { return p.onEscape() } catch { return false }
    })),
    ids: () => entries.map(p => p.id),
  }
}

/** Provided by AgentVisualizer. The default no-op keeps panels usable standalone (tests, storybook). */
export const PanelRegistryContext = createContext<RegisterPanel>(() => () => {})

/**
 * Let a panel take part in the Escape stack: while mounted, `onEscape` is asked to close the
 * panel after the built-in sliding panels have been closed. Example (message feed):
 *
 *   usePanelRegistration('message-feed', () => { if (!expanded) return false; setExpanded(false); return true })
 */
export function usePanelRegistration(id: string, onEscape: PanelEscapeHandler): void {
  const register = useContext(PanelRegistryContext)
  const handlerRef = useRef(onEscape)
  handlerRef.current = onEscape
  useEffect(() => register(id, () => handlerRef.current()), [register, id])
}
