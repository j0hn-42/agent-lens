'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createLoadToken, createReconnectingSource,
  type EventSourceLike, type SourceStatus,
} from '@/lib/reconnect'

export interface ReconnectingSourceDeps {
  createEventSource?: (url: string) => EventSourceLike
  fetchStatus?: (url: string, signal: AbortSignal) => Promise<{ ok: boolean }>
  random?: () => number
}

export interface UseReconnectingSourceOptions extends ReconnectingSourceDeps {
  /** False = no connection at all */
  enabled: boolean
  /** Relay origin without trailing slash ('' = same origin) */
  origin: string
  /** Single session requested (also sent as ?session=); null = every session */
  sessionId?: string | null
  /** Bumped to drop the connection and open a new one (a new replay), e.g. after the relay's scope changed (#291) */
  generation?: number
  onMessage: (data: unknown) => void
  /** Called synchronously with each status change, before the messages of that connection (a render may not have run yet) */
  onStatusChange?: (status: SourceStatus['status']) => void
  onParseError?: () => void
}

const IDLE: SourceStatus = { status: 'connecting', mode: 'sse', attempt: 0, detail: null }

/**
 * Relay SSE connection with backoff, polling fallback, stale-selection guard and replay dedupe
 * (logic in lib/reconnect). Timers and the stream are released on unmount or when inputs change.
 */
export function useReconnectingSource(opts: UseReconnectingSourceOptions): SourceStatus & { retryNow: () => void } {
  const [state, setState] = useState<SourceStatus>(IDLE)
  const tokenRef = useRef(createLoadToken())
  const retryRef = useRef<(() => void) | null>(null)
  // Latest callbacks/deps without restarting the connection on every render
  const latest = useRef(opts)
  latest.current = opts
  const { enabled, origin, sessionId, generation } = opts

  useEffect(() => {
    if (!enabled) return
    latest.current.onStatusChange?.('connecting')
    setState(IDLE)
    const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''
    const source = createReconnectingSource({
      url: `${origin}/events${query}`,
      statusUrl: `${origin}/status`,
      sessionId,
      loadToken: tokenRef.current,
      onMessage: d => latest.current.onMessage(d),
      onParseError: () => latest.current.onParseError?.(),
      onStatus: s => { latest.current.onStatusChange?.(s.status); setState(s) },
      createEventSource: latest.current.createEventSource ?? (url => new EventSource(url) as unknown as EventSourceLike),
      fetchStatus: latest.current.fetchStatus ?? ((url, signal) => fetch(url, { signal, cache: 'no-store' })),
      random: latest.current.random,
    })
    retryRef.current = () => source.retryNow()
    return () => { retryRef.current = null; source.close() }
  }, [enabled, origin, sessionId, generation])

  const retryNow = useCallback(() => { retryRef.current?.() }, [])
  return useMemo(() => ({ ...state, retryNow }), [state, retryNow])
}
