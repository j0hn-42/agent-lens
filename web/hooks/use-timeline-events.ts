'use client'

import { useMemo, useRef } from 'react'
import type { useAgentSimulation } from '@/hooks/use-agent-simulation'
import { createMarkerTracker, type MarkerResult } from '@/lib/timeline-markers'

type Sim = ReturnType<typeof useAgentSimulation>

/** Scrubber markers: incremental, followed by message id (not by length) so they survive the per-agent
 *  conversation cap, and reset when a conversation is cleared or replaced. `lost` counts the markers that
 *  could not be made or kept, so the bar can say so (#648). */
export function useTimelineEvents(conversations: Sim['conversations'], droppedMessages?: Sim['droppedMessages']): MarkerResult {
  const trackerRef = useRef<ReturnType<typeof createMarkerTracker>>(null)
  return useMemo(() => {
    trackerRef.current ??= createMarkerTracker()
    return trackerRef.current.update(conversations, droppedMessages)
  }, [conversations, droppedMessages])
}
