'use client'

import { useMemo, useRef } from 'react'
import type { useAgentSimulation } from '@/hooks/use-agent-simulation'
import type { useSelectionState } from '@/hooks/use-selection-state'
import type { ToolWhy } from '@/components/agent-visualizer/tool-why'
import { reasoningBefore, causalChain } from '@/lib/tool-reasoning'
import { deriveDelegationReport } from '@/lib/delegation-report'
import { nextInspectorMemory, type InspectorMemory } from '@/lib/inspector-model'

type Simulation = ReturnType<typeof useAgentSimulation>
type Selection = ReturnType<typeof useSelectionState>

/** What the agent card and the tool popup show about the current selection */
export function useInspector(
  selection: Pick<Selection, 'selectedAgentId' | 'selectedToolData'>,
  sim: Pick<Simulation, 'agents' | 'conversations' | 'droppedMessages' | 'edges' | 'fileAttention'>,
) {
  const { agents, conversations, droppedMessages, edges, fileAttention } = sim
  const selectedAgent = selection.selectedAgentId ? agents.get(selection.selectedAgentId) : null
  // Inspector (#57): remembers the selected node's last name so "no longer listed" can name it; reset on every new selection
  const inspectorMemoryRef = useRef<InspectorMemory | null>(null)
  inspectorMemoryRef.current = nextInspectorMemory(inspectorMemoryRef.current, selection.selectedAgentId, selectedAgent ?? undefined)
  const selectedGone = !!selection.selectedAgentId && !selectedAgent
  // Delegation report of the selected agent (#233): its direct sub-agents, each value proven or said unknown
  const selectedAgentId = selectedAgent?.id
  const delegation = useMemo(
    () => selectedAgentId ? deriveDelegationReport(selectedAgentId, agents, fileAttention, edges) : [],
    [selectedAgentId, agents, fileAttention, edges],
  )

  // "Why this tool?": derived only from the owner's own history (see lib/tool-reasoning)
  const toolData = selection.selectedToolData
  const toolWhy = useMemo((): ToolWhy | undefined => {
    if (!toolData?.agentId) return undefined
    const nameOf = (id: string) => agents.get(id)?.name ?? id
    const reasoning = reasoningBefore(conversations.get(toolData.agentId), toolData.toolUseId, droppedMessages.get(toolData.agentId) ?? 0)
    const chain = toolData.state === 'error'
      ? causalChain({
        agentId: toolData.agentId, toolUseId: toolData.toolUseId, errorText: toolData.errorMessage ?? toolData.result ?? '',
        agents, conversations, droppedMessages, edges,
      })
      : null
    return { reasoning, chain, nameOf }
  }, [toolData, agents, conversations, droppedMessages, edges])

  return { selectedAgent, selectedGone, goneName: inspectorMemoryRef.current?.name ?? null, delegation, toolWhy }
}
