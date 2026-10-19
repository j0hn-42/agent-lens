"use client"

import type { useAgentSimulation } from "@/hooks/use-agent-simulation"
import type { useSelectionState } from "@/hooks/use-selection-state"
import type { useVSCodeBridge } from "@/hooks/use-vscode-bridge"
import type { useInspector } from "@/hooks/use-inspector"
import type { useAttentionSummary } from "@/hooks/use-attention-summary"
import { detectLoops } from "@/lib/loop-detection"
import { replayLostForSession } from "@/lib/event-loss"
import { AgentDetailCard, AgentGoneCard } from "./agent-detail-card"
import { GlassContextMenu } from "./glass-context-menu"
import { contextMenuItems, type ContextMenuActions } from "./context-menu-items"
import { ToolDetailPopup } from "./tool-detail-popup"
import { DiscoveryDetailPopup } from "./discovery-detail-popup"
import { LinkPanel } from "./link-panel"
import { stopPropagationHandlers } from "./shared-ui"
import { useLocale } from "@/lib/locale"

type Simulation = ReturnType<typeof useAgentSimulation>
type Selection = ReturnType<typeof useSelectionState>
type Bridge = ReturnType<typeof useVSCodeBridge>
type Inspector = ReturnType<typeof useInspector>

interface SelectionOverlaysProps {
  selection: Selection
  inspector: Inspector
  agents: Simulation['agents']
  links: Simulation['links']
  droppedMessages: Simulation['droppedMessages']
  health: ReturnType<typeof useAttentionSummary>['health']
  bridge: Pick<Bridge, 'relayOrigin' | 'launch' | 'eventLoss'>
  selectedLinkId: string | null
  onCloseLink: () => void
  onEscapeFromCard: () => void
  menuActions: ContextMenuActions
}

/**
 * The agent menu acts on the right-clicked agent, which a right click does not select:
 * - "Show details" selects it, which opens its detail card;
 * - "Zoom to fit" selects it first, since the fit frames the selected agent and its sub-agents (computeFitTransform).
 *   Both state updates land in the same render, and the camera runs its fit after the selection change (#377).
 */
function agentMenuActions(selection: Selection, actions: ContextMenuActions): ContextMenuActions {
  const agentId = selection.contextMenu?.agentId
  if (!agentId) return actions
  return {
    ...actions,
    showAgentDetails: () => selection.handleAgentClick(agentId),
    zoomToFit: () => {
      selection.handleAgentClick(agentId)
      actions.zoomToFit()
    },
  }
}

/** What opens over the canvas after a click: the agent card, the tool and discovery popups, the link panel, the context menu */
export function SelectionOverlays({
  selection, inspector, agents, links, droppedMessages, health, bridge, selectedLinkId, onCloseLink, onEscapeFromCard, menuActions,
}: SelectionOverlaysProps) {
  const { selectedAgent, selectedGone, goneName, delegation, toolWhy } = inspector
  const { locale } = useLocale()
  return (
    <>
      {/* Agent detail card (floating, tethered to node) */}
      {selectedAgent && selection.selectedAgentWorldPos && (
        <div {...stopPropagationHandlers}>
          <AgentDetailCard
            key={selectedAgent.id}
            agent={selectedAgent}
            toolErrors={selectedAgent.toolErrors}
            health={health.byAgent.get(selectedAgent.id) ?? detectLoops([], droppedMessages.get(selectedAgent.id) ?? 0)}
            sessionHealth={health.bySession.get(selectedAgent.sessionId)}
            delegation={delegation}
            replayLost={replayLostForSession(bridge.eventLoss, selectedAgent.sessionId)}
            onSelectAgent={selection.handleAgentClick}
            relayOrigin={bridge.relayOrigin}
            launch={bridge.launch}
            onClose={selection.clearAgent}
            onEscape={onEscapeFromCard}
          />
        </div>
      )}
      {selectedGone && selection.selectedAgentWorldPos && (
        <div {...stopPropagationHandlers}>
          <AgentGoneCard
            key={selection.selectedAgentId}
            name={goneName}
            onClose={selection.clearAgent}
            onEscape={onEscapeFromCard}
          />
        </div>
      )}

      {/* Tool call detail popup */}
      {selection.selectedToolData && selection.selectedToolScreenPos && (
        <div {...stopPropagationHandlers}>
          <ToolDetailPopup
            tool={selection.selectedToolData}
            why={toolWhy}
            position={selection.selectedToolScreenPos}
            onClose={selection.clearTool}
          />
        </div>
      )}

      {/* Discovery detail popup */}
      {selection.selectedDiscoveryData && selection.selectedDiscoveryScreenPos && (
        <div {...stopPropagationHandlers}>
          <DiscoveryDetailPopup
            discovery={selection.selectedDiscoveryData}
            agentName={agents.get(selection.selectedDiscoveryData.agentId)?.name}
            position={selection.selectedDiscoveryScreenPos}
            onClose={selection.clearDiscovery}
          />
        </div>
      )}

      {/* Communication link detail (opened by clicking an edge or its entry in the graph list) */}
      {selectedLinkId && links.get(selectedLinkId) && (
        <LinkPanel
          link={links.get(selectedLinkId)!}
          agents={agents}
          onClose={onCloseLink}
        />
      )}

      {/* Context menu */}
      {selection.contextMenu && (
        <GlassContextMenu
          position={selection.contextMenu}
          items={contextMenuItems(Boolean(selection.contextMenu.agentId), agentMenuActions(selection, menuActions), locale)}
          onClose={() => selection.setContextMenu(null)}
        />
      )}
    </>
  )
}
