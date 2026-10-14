'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { useAgentSimulation } from '@/hooks/use-agent-simulation'
import type { useSelectionState } from '@/hooks/use-selection-state'
import type { useVSCodeBridge } from '@/hooks/use-vscode-bridge'
import { createLabelledSimulationRef } from '@/lib/chrome-utils'
import { shiftPickPair, prunePairStore } from '@/lib/pair-filter-store'

type Simulation = ReturnType<typeof useAgentSimulation>

/** What a click on the canvas does, and the simulation the canvas draws from */
export function useCanvasSelection(
  selection: Pick<ReturnType<typeof useSelectionState>, 'selectedAgentId' | 'handleAgentClick'>,
  sim: Pick<Simulation, 'agents' | 'links' | 'frameRef'>,
  sessions: ReturnType<typeof useVSCodeBridge>['sessions'],
) {
  const { agents, links, frameRef } = sim

  // Selected agent link (canvas edge between teammates); the link panel is mounted by the integration
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null)
  const handleLinkClick = useCallback((linkId: string) => {
    setSelectedLinkId(prev => (prev === linkId ? null : linkId))
  }, [])
  useEffect(() => {
    if (selectedLinkId && !links.has(selectedLinkId)) setSelectedLinkId(null)
  }, [links, selectedLinkId])

  // Pair filter: Shift-click on an agent picks it as one end of the pair, a plain click keeps selecting
  const { handleAgentClick: selectAgent } = selection
  const selectedAgentIdForPair = selection.selectedAgentId
  const handleCanvasAgentClick = useCallback((agentId: string | null, modifiers?: { shiftKey: boolean }) => {
    if (modifiers?.shiftKey && agentId) {
      // Picking must not change the selection: the feed clears the pair whenever the selected agent
      // changes (the tab would no longer describe the list), which would wipe the pair just chosen.
      shiftPickPair(selectedAgentIdForPair, agentId)
      return
    }
    selectAgent(agentId)
  }, [selectAgent, selectedAgentIdForPair])
  // An agent that left the simulation cannot stay in the pair
  useEffect(() => { prunePairStore(key => agents.has(key)) }, [agents])

  // The canvas draws from the simulation ref: hand it agents that carry their session label and runtime
  const sessionsForCanvasRef = useRef(sessions)
  sessionsForCanvasRef.current = sessions
  const labelledSimulationRef = useMemo(
    () => createLabelledSimulationRef(frameRef, () => sessionsForCanvasRef.current),
    [frameRef],
  )

  return { selectedLinkId, setSelectedLinkId, handleLinkClick, handleCanvasAgentClick, labelledSimulationRef }
}
