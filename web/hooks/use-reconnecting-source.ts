'use client'

import { useEffect, useRef, useState } from 'react'
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
  onMessage: (data: unknown) => void
  onParseError?: () => void
}

const IDLE: SourceStatus = { status: 'connecting', mode: 'sse', attempt: 0, detail: null }

/**
 * Relay SSE connection with backoff, polling fallback, stale-selection guard and replay dedupe
 * (logic in lib/reconnect). Timers and the stream are released on unmount or when inputs change.
 */
export function useReconnectingSource(opts: UseReconnectingSourceOptions): SourceStatus {
  const [state, setState] = useState<SourceStatus>(IDLE)
  const tokenRef = useRef(createLoadToken())
  // Latest callbacks/deps without restarting the connection on every render
  const latest = useRef(opts)
  latest.current = opts
  const { enabled, origin, sessionId } = opts

  useEffect(() => {
    if (!enabled) return
    setState(IDLE)
    const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''
    const source = createReconnectingSource({
      url: `${origin}/events${query}`,
      statusUrl: `${origin}/status`,
      sessionId,
      loadToken: tokenRef.current,
      onMessage: d => latest.current.onMessage(d),
      onParseError: () => latest.current.onParseError?.(),
      onStatus: setState,
      createEventSource: latest.current.createEventSource ?? (url => new EventSource(url) as unknown as EventSourceLike),
      fetchStatus: latest.current.fetchStatus ?? ((url, signal) => fetch(url, { signal, cache: 'no-store' })),
      random: latest.current.random,
    })
    return () => source.close()
  }, [enabled, origin, sessionId])

  return state
}
