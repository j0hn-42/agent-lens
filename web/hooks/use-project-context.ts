'use client'

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import {
  createProjectContextLoader, type ContextState, type ProjectContextData, type ProjectContextLoader,
} from '@/lib/project-context'

export interface UseProjectContext {
  state: ContextState
  /** Reload now, ignoring the 60 s cache */
  refresh: () => void
}

/**
 * Project context of `sessionId`, loaded ONLY while `active` (panel open) and re-used for 60 s.
 * `sessionId` null (no single session selected) loads nothing. Changing session loads the new one;
 * an answer for the previous session is dropped by the loader's token.
 */
export function useProjectContext(
  fetchContext: (sessionId: string) => Promise<ProjectContextData | 'unavailable'>,
  sessionId: string | null,
  active: boolean,
): UseProjectContext {
  const fetchRef = useRef(fetchContext)
  fetchRef.current = fetchContext
  const loaderRef = useRef<ProjectContextLoader | null>(null)
  if (!loaderRef.current) loaderRef.current = createProjectContextLoader({ fetchContext: id => fetchRef.current(id) })
  const loader = loaderRef.current

  const state = useSyncExternalStore(loader.subscribe, loader.getState, loader.getState)

  useEffect(() => {
    if (active && sessionId) void loader.load(sessionId)
  }, [active, sessionId, loader])

  const refresh = useCallback(() => {
    if (sessionId) void loader.load(sessionId, { force: true })
  }, [loader, sessionId])

  return { state, refresh }
}
