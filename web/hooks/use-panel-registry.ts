'use client'

import { createContext, useContext, useEffect, useRef } from 'react'

/**
 * Handler for Escape: collapse/close the panel and return true, or return false when there
 * is nothing to close (so Escape can fall through to the next panel or the selection).
 */
export type PanelEscapeHandler = () => boolean

/** Registers a handler; the returned function unregisters it. */
export type RegisterPanel = (id: string, onEscape: PanelEscapeHandler) => () => void

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
