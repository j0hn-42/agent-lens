'use client'

import { useRef, useLayoutEffect, useState, useCallback, type MutableRefObject } from 'react'
import type { useAgentSimulation } from '@/hooks/use-agent-simulation'
import type { useVSCodeBridge, MemoryMark } from '@/hooks/use-vscode-bridge'
import { ALL_SESSIONS_ID, isUnionSelection } from '@/lib/bridge-types'
import { mustRestartFromBuffer } from '@/lib/session-buffers'

type Simulation = ReturnType<typeof useAgentSimulation>
type Bridge = ReturnType<typeof useVSCodeBridge>

interface SessionViewSwapInput {
  bridge: Pick<Bridge, 'selectedSessionId' | 'flushSessionEvents' | 'getSessionEventCount' | 'getBufferedEventCount' | 'getBufferedLifecycleCount' | 'allViewKey' | 'getViewMark' | 'getMemoryDropped'>
  restart: Simulation['restart']
  saveSnapshot: Simulation['saveSnapshot']
  restoreSnapshot: Simulation['restoreSnapshot']
  isReviewingRef: MutableRefObject<boolean>
  /** Called when a session change ends a review (the pause belonged to the view that was left) */
  onReviewEnded: () => void
}

/**
 * Per-session state cache: save/restore simulation state on tab switch so sessions stay up to date and
 * switching is instant. Layout effects, so the restart happens synchronously before any animation frame can
 * consume and discard events from the bridge's pending queue.
 * Returns the cache (closing a session drops its entry once undo is no longer possible), and `memoryDropped`: how many
 * events of the view shown the page freed from its own memory before handing them to it (#613), for the truncation
 * banner. A view rebuilt from the buffer lacks every event the buffer dropped; a restored snapshot lacks what it
 * lacked when it was left plus what was dropped after its mark. `noteRebuilt` recounts it after another rebuild.
 */
export function useSessionViewSwap({ bridge, restart, saveSnapshot, restoreSnapshot, isReviewingRef, onReviewEnded }: SessionViewSwapInput) {
  const sessionCacheRef = useRef<Map<string, {
    snapshot: ReturnType<Simulation['saveSnapshot']>; eventCount: number; viewKey: string
    /** Where the view stood when it was left, and how many events it lacked then (#613) */
    mark: MemoryMark; dropped: number
  }>>(new Map())
  const [memoryDropped, setMemoryDropped] = useState(0)
  const memoryDroppedRef = useRef(0)
  const showDropped = useCallback((n: number) => { memoryDroppedRef.current = n; setMemoryDropped(n) }, [])
  const prevSelectedRef = useRef<string | null>(null)
  const allViewKeyRef = useRef(bridge.allViewKey)
  allViewKeyRef.current = bridge.allViewKey
  const { selectedSessionId, flushSessionEvents, getSessionEventCount, getBufferedEventCount, getBufferedLifecycleCount, getViewMark, getMemoryDropped } = bridge
  useLayoutEffect(() => {
    if (selectedSessionId && selectedSessionId !== prevSelectedRef.current) {
      // Save outgoing session state (if any)
      if (prevSelectedRef.current !== null) {
        sessionCacheRef.current.set(prevSelectedRef.current, {
          snapshot: saveSnapshot(),
          eventCount: getSessionEventCount(prevSelectedRef.current),
          viewKey: allViewKeyRef.current,
          mark: getViewMark(prevSelectedRef.current),
          dropped: memoryDroppedRef.current,
        })
      }

      // Restore or cold-start the incoming session, then flush events.
      // Flushing happens HERE (after state swap) to prevent the animation
      // frame from processing events in the wrong simulation context.
      const cached = sessionCacheRef.current.get(selectedSessionId)
      // The union views depend on which sessions 'All' shows: a snapshot of another set is stale
      // A trim (#613) that dropped events after the snapshot makes it stale too: resuming would skip them, so the view
      // restarts from the buffer, which keeps the lifecycle events. A freed buffer holds none of them: restarting would
      // empty the canvas, so the snapshot is kept; the events missing between the two are not drawn, memoryDropped counts them.
      const selected = selectedSessionId
      const cacheUsable = cached && (isUnionSelection(selected)
        ? cached.viewKey === allViewKeyRef.current
        : !mustRestartFromBuffer(cached.eventCount, getSessionEventCount(selected) - getBufferedEventCount(selected), getBufferedLifecycleCount(selected)))
      if (cached && cacheUsable) {
        restoreSnapshot(cached.snapshot)
        showDropped(cached.dropped + getMemoryDropped(selected, cached.mark))
        flushSessionEvents(selectedSessionId, cached.eventCount)
      } else {
        restart()
        showDropped(getMemoryDropped(selected))
        flushSessionEvents(selectedSessionId)
      }

      // Both paths above leave the simulation playing: the pause belonged to the view that was left (#248).
      // The events it had queued are re-fed from the cursor, so none is lost; the bar must not claim review.
      if (isReviewingRef.current) onReviewEnded()

      prevSelectedRef.current = selectedSessionId
    }
  }, [selectedSessionId, restart, flushSessionEvents, saveSnapshot, restoreSnapshot, getSessionEventCount, getBufferedEventCount, getBufferedLifecycleCount, getViewMark, getMemoryDropped, showDropped, isReviewingRef, onReviewEnded])

  // 'All' membership changed (an old session woke up, a session went quiet, the toggle flipped):
  // rebuild the union from the buffered events of the sessions it now shows.
  const lastViewKeyRef = useRef(bridge.allViewKey)
  useLayoutEffect(() => {
    allViewKeyRef.current = bridge.allViewKey
    if (lastViewKeyRef.current === bridge.allViewKey) return
    lastViewKeyRef.current = bridge.allViewKey
    if (selectedSessionId !== ALL_SESSIONS_ID) return
    restart()
    showDropped(getMemoryDropped(ALL_SESSIONS_ID))
    flushSessionEvents(ALL_SESSIONS_ID)
  }, [bridge.allViewKey, selectedSessionId, restart, flushSessionEvents, getMemoryDropped, showDropped])

  // Another rebuild of the view from the buffer (Reload session events): it lacks every event the buffer dropped
  const noteRebuilt = useCallback(() => {
    if (selectedSessionId) showDropped(getMemoryDropped(selectedSessionId))
  }, [selectedSessionId, getMemoryDropped, showDropped])

  return { sessionCacheRef, memoryDropped, noteRebuilt }
}
