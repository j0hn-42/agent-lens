'use client'

import { useEffect, useRef } from 'react'
import type { Agent } from '@/lib/agent-types'
import { createChrono, activeSummaryText } from '@/lib/active-time'
import { useFreshnessValue, getFreshnessClock, type FreshnessClock } from '@/hooks/use-freshness-clock'
import { deriveFreshness } from '@/hooks/simulation/freshness'

type ActiveAgent = Pick<Agent, 'state' | 'activeMs' | 'activeSince' | 'lastEventAt' | 'freshnessSource'>

interface ActiveTimeStatProps {
  agent: ActiveAgent
  /** Tick period of the local counter (ms) */
  tickMs?: number
  /** Overrides for tests */
  now?: () => number
  monotonic?: () => number
  freshnessClock?: FreshnessClock
}

/**
 * "active for 0:12 · 1:35 total" (issue #59). The counter advances by writing the text node
 * directly: no re-render and no fetch per tick, and it follows the monotonic clock so a wall-clock
 * jump cannot move it. The component only re-renders when the freshness of the agent changes, and an
 * agent that is not fresh reads "active time unknown" instead of a counter that keeps running.
 */
export function ActiveTimeStat({ agent, tickMs = 1000, now = Date.now, monotonic = () => performance.now(), freshnessClock }: ActiveTimeStatProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const agentRef = useRef(agent)
  agentRef.current = agent
  const clock = freshnessClock ?? getFreshnessClock()
  const freshness = useFreshnessValue(t => deriveFreshness(agentRef.current, t), clock)
  const running = agent.activeSince !== undefined
  const since = agent.activeSince

  // The chrono restarts only when the span (or its validity) changes, never on a plain tick
  const chrono = createChrono({ startedAt: since ?? 0, wallNow: now(), monotonic })
  const text = activeSummaryText(agent, freshness, running ? chrono.elapsedMs() : 0)

  useEffect(() => {
    if (!running || freshness !== 'fresh' || since === undefined) return
    const c = createChrono({ startedAt: since, wallNow: now(), monotonic })
    const tick = () => {
      if (ref.current && !(typeof document !== 'undefined' && document.visibilityState === 'hidden')) {
        ref.current.textContent = activeSummaryText(agentRef.current, 'fresh', c.elapsedMs())
      }
    }
    tick()
    const handle = setInterval(tick, tickMs)
    return () => clearInterval(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- now/monotonic are stable clock sources
  }, [running, freshness, since, tickMs])

  return <span ref={ref} data-testid="active-time">{text}</span>
}
