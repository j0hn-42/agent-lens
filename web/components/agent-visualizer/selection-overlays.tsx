"use client"

import type { ComponentProps } from "react"
import type { useAgentSimulation } from "@/hooks/use-agent-simulation"
import type { useSelectionState } from "@/hooks/use-selection-state"
import type { useVSCodeBridge } from "@/hooks/use-vscode-bridge"
import type { useInspector } from "@/hooks/use-inspector"
import type { useAttentionSummary } from "@/hooks/use-attention-summary"
import { detectLoops } from "@/lib/loop-detection"
import { AgentDetailCard, AgentGoneCard } from "./agent-detail-card"
import { GlassContextMenu } from "./glass-context-menu"
import { ToolDetailPopup } from "./tool-detail-popup"
import { DiscoveryDetailPopup } from "./discovery-detail-popup"
import { LinkPanel } from "./link-panel"
import { stopPropagationHandlers } from "./shared-ui"

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
  bridge: Pick<Bridge, 'relayOrigin' | 'launch'>
  selectedLinkId: string | null
  onCloseLink: () => void
  onEscapeFromCard: () => void
  menuActions: ContextMenuActions
}

interface ContextMenuActions {
  toggleStats: () => void
  zoomToFit: () => void
  toggleGrid: () => void
  clearHistory: () => void
  /** Only offered on a real session */
  reloadSessionEvents: (() => void) | null
}

function contextMenuItems(onAgent: boolean, a: ContextMenuActions): ComponentProps<typeof GlassContextMenu>['items'] {
  if (onAgent) return [{ label: '📊  Toggle Stats', onClick: a.toggleStats }]
  return [
    { label: '🔍  Zoom to Fit', onClick: a.zoomToFit },
    { label: '📊  Toggle Stats', onClick: a.toggleStats },
    { label: '⬡  Toggle Grid', onClick: a.toggleGrid },
    { label: '', onClick: () => {}, separator: true },
    { label: '⟲  Clear history', confirmLabel: 'Confirm clear history', onClick: a.clearHistory },
    ...(a.reloadSessionEvents ? [{ label: '↻  Reload session events', onClick: a.reloadSessionEvents }] : []),
  ]
}

/** What opens over the canvas after a click: the agent card, the tool and discovery popups, the link panel, the context menu */
export function SelectionOverlays({
  selection, inspector, agents, links, droppedMessages, health, bridge, selectedLinkId, onCloseLink, onEscapeFromCard, menuActions,
}: SelectionOverlaysProps) {
  const { selectedAgent, selectedGone, goneName, delegation, toolWhy } = inspector
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
          items={contextMenuItems(Boolean(selection.contextMenu.agentId), menuActions)}
          onClose={() => selection.setContextMenu(null)}
        />
      )}
    </>
  )
}
