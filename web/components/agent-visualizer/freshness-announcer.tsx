'use client'

import { useEffect, useRef, useState } from 'react'
import { useFreshnessValue, getFreshnessClock, type FreshnessClock } from '@/hooks/use-freshness-clock'
import {
  buildFreshnessAnnouncement, freshnessKey, freshnessMap, type Freshness, type FreshnessSubject,
} from '@/hooks/simulation/freshness'

interface FreshnessAnnouncerProps {
  /** Agents of the current view (read through a ref, so a new map never re-renders this component) */
  agents: ReadonlyMap<string, FreshnessSubject>
  /** Clock override for tests */
  clock?: FreshnessClock
}

/**
 * Screen reader announcements for agents that go stale or closed (issue #48). Polite and sparing: it
 * re-renders only when the coarse freshness key changes (never on a plain tick), and every change
 * produces at most ONE aggregated message. The first reading is a baseline and is never announced.
 */
export function FreshnessAnnouncer({ agents, clock }: FreshnessAnnouncerProps) {
  const agentsRef = useRef(agents)
  agentsRef.current = agents
  const key = useFreshnessValue(now => freshnessKey(agentsRef.current.values(), now), clock)
  const previous = useRef<Map<string, Freshness> | null>(null)
  const [message, setMessage] = useState('')

  useEffect(() => {
    const list = Array.from(agentsRef.current.values())
    const next = freshnessMap(list, (clock ?? getFreshnessClock()).getNow())
    const prev = previous.current
    previous.current = next
    if (!prev) return
    const names = new Map(list.map(a => [a.id, a.name]))
    const text = buildFreshnessAnnouncement(prev, next, names)
    if (text) setMessage(text)
  }, [key, clock])

  return <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{message}</div>
}
