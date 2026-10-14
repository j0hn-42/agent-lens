'use client'

import { useMemo, useRef } from 'react'
import { useAgentSimulation } from '@/hooks/use-agent-simulation'
import type { useVSCodeBridge } from '@/hooks/use-vscode-bridge'
import { computeSessionOffsets } from '@/hooks/simulation/stamp-time'
import { buildSessionProjects } from '@/lib/chrome-utils'

/** The simulation the canvas draws, fed by what the bridge receives */
export function useVisualizerSimulation(
  bridge: Pick<ReturnType<typeof useVSCodeBridge>, 'sessions' | 'useMockData' | 'pendingEvents' | 'consumeEvents' | 'selectedSessionId' | 'selectedSessionIdRef' | 'disable1MContext'>,
  isReviewing: boolean,
  hideInactive: boolean,
) {
  // Union views ('All' / team) put every session on one wall-clock axis (offsets in seconds per session)
  const sessionOffsetsRef = useRef<ReadonlyMap<string, number> | undefined>(undefined)
  sessionOffsetsRef.current = useMemo(() => computeSessionOffsets(bridge.sessions), [bridge.sessions])

  const sessionProjects = useMemo(() => buildSessionProjects(bridge.sessions), [bridge.sessions])

  return useAgentSimulation({
    useMockData: bridge.useMockData,
    externalEvents: bridge.pendingEvents,
    onExternalEventsConsumed: bridge.consumeEvents,
    sessionFilter: bridge.selectedSessionId,
    // Pass the ref that's updated synchronously in session-started handler,
    // so the animation frame never uses a stale filter value.
    sessionFilterRef: bridge.selectedSessionIdRef,
    disable1MContext: bridge.disable1MContext,
    isReviewing,
    sessionOffsetsRef,
    sessionProjects,
    hideInactive,
  })
}
