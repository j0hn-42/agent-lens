"use client"

import type { useAgentSimulation } from "@/hooks/use-agent-simulation"
import type { useVSCodeBridge } from "@/hooks/use-vscode-bridge"
import type { useSelectionState } from "@/hooks/use-selection-state"
import type { usePanelsState } from "@/hooks/use-panels-state"
import type { useAttentionSummary } from "@/hooks/use-attention-summary"
import type { useSessionActions } from "@/hooks/use-session-actions"
import type { UseUiPreferences } from "@/hooks/use-ui-preferences"
import { isUnionSelection } from "@/lib/bridge-types"
import { scopeEmptyHint } from "@/lib/relay-scope"
import type { AgentStateCounts } from "@/lib/chrome-utils"
import { FileAttentionPanel } from "./file-attention-panel"
import { TimelinePanel } from "./timeline-panel"
import { SessionListPanel } from "./session-list-panel"
import { ProjectContextPanel } from "./project-context-panel"
import { SystemPanel } from "./system-panel"

type Simulation = ReturnType<typeof useAgentSimulation>
type Bridge = ReturnType<typeof useVSCodeBridge>
type Panels = ReturnType<typeof usePanelsState>
type SessionActions = ReturnType<typeof useSessionActions>

interface PanelDockProps {
  panels: Panels
  sim: Pick<Simulation, 'fileAttention' | 'waste' | 'agents' | 'timelineEntries' | 'currentTime'>
  bridge: Bridge
  selection: Pick<ReturnType<typeof useSelectionState>, 'selectedAgentId' | 'handleAgentClick'>
  attention: ReturnType<typeof useAttentionSummary>['attention']
  health: ReturnType<typeof useAttentionSummary>['health']
  sessionActions: SessionActions
  uiPrefs: Pick<UseUiPreferences, 'prefs' | 'setPref'>
  allSessionCount: number
  /** Agents of the view by state, drawn in the Sessions panel header (#523, moved from the top bar) */
  agentCounts: AgentStateCounts
  /** The agents the sessions list shows (finished ones hidden like on the canvas) */
  listAgents: Simulation['agents']
  agentLabel: (key: string) => string
  openFile: (filePath: string, line?: number) => void
  fetchContext: ComponentPropsOf<typeof ProjectContextPanel>['fetchContext']
  contextOrigin: string
}

type ComponentPropsOf<T> = T extends (props: infer P) => unknown ? P : never

/** The slide-in panels around the canvas: files, sessions, project context, system, timeline */
export function PanelDock({
  panels, sim, bridge, selection, attention, health, sessionActions, uiPrefs, allSessionCount, agentCounts, listAgents, agentLabel, openFile, fetchContext, contextOrigin,
}: PanelDockProps) {
  const { prefs, setPref } = uiPrefs
  const selectedSession = bridge.sessions.find(s => s.id === bridge.selectedSessionId)
  return (
    <>
      {/* File attention panel (slide-in from right) */}
      <div ref={panels.panelRefs.files} style={{ display: 'contents' }}>
        <FileAttentionPanel
          visible={panels.showFileAttention}
          fileAttention={sim.fileAttention}
          waste={sim.waste}
          agents={sim.agents}
          onClose={() => panels.setShowFileAttention(false)}
          onOpenFile={bridge.isVSCode ? openFile : undefined}
          agentLabel={agentLabel}
          replayLost={bridge.replayLost}
        />
      </div>

      {/* Sessions panel (slide-in from left): sessions with their agent and sub-agent tree */}
      <div ref={panels.panelRefs.sessions} style={{ display: 'contents' }}>
        <SessionListPanel
          visible={panels.showSessions}
          attention={attention}
          health={health.bySession}
          onClose={() => panels.setShowSessions(false)}
          sessions={bridge.sessions}
          relayOffline={!bridge.useMockData && bridge.connectionStatus === 'disconnected'}
          allSessionCount={allSessionCount}
          agentCounts={agentCounts}
          selectedSessionId={bridge.selectedSessionId}
          sessionsWithActivity={bridge.sessionsWithActivity}
          sessionModels={bridge.sessionModels}
          onSelectSession={bridge.selectSession}
          onCloseSession={sessionActions.handleCloseSession}
          onRenameSession={bridge.renameSession}
          onExportSession={bridge.useMockData ? undefined : sessionActions.handleExportSession}
          canExportSession={sessionActions.canExportSession}
          agents={listAgents}
          selectedAgentId={selection.selectedAgentId}
          onSelectAgent={selection.handleAgentClick}
          teams={bridge.teams}
          teamWorking={bridge.teamWorking}
          teamSummaries={bridge.teamSummaries}
          teamMemberCounts={bridge.teamMemberCounts}
          filterProject={prefs.sessionFilterProject}
          filterRuntime={prefs.sessionFilterRuntime}
          filterBranch={prefs.sessionFilterBranch}
          scopeHint={scopeEmptyHint(bridge.relayScope)}
          activeOnly={prefs.sessionListActiveOnly}
          onActiveOnlyChange={v => setPref('sessionListActiveOnly', v)}
          onFilterChange={change => {
            if (change.projectId !== undefined) setPref('sessionFilterProject', change.projectId)
            if (change.runtime !== undefined) setPref('sessionFilterRuntime', change.runtime)
            if (change.branch !== undefined) setPref('sessionFilterBranch', change.branch)
          }}
        />
      </div>

      {/* Project context panel: CLAUDE.md, memory and cited issues, loaded on demand from the relay */}
      <div ref={panels.panelRefs.context} style={{ display: 'contents' }}>
        <ProjectContextPanel
          visible={panels.showContext}
          sessionId={bridge.selectedSessionId && !isUnionSelection(bridge.selectedSessionId) ? bridge.selectedSessionId : null}
          unavailableReason={bridge.isVSCode ? 'Project context is read through the standalone relay; it is not available inside VS Code.'
            : bridge.useMockData ? 'Project context is not available in demo mode.' : undefined}
          fetchContext={fetchContext}
          relayOrigin={contextOrigin}
          sessionBranch={selectedSession?.branch}
          session={selectedSession}
          onOpenTerminal={bridge.isVSCode ? bridge.bridgeOpenTerminal : undefined}
          onClose={() => panels.setShowContext(false)}
        />
      </div>

      {/* System panel: machine health sampled by the standalone relay (left dock, below the agent card) */}
      <div ref={panels.panelRefs.system} style={{ display: 'contents' }}>
        <SystemPanel
          visible={panels.showSystem}
          samples={bridge.systemStats}
          unavailableReason={bridge.isVSCode ? 'System metrics come from the standalone relay; not available inside VS Code.'
            : bridge.useMockData ? 'System metrics are not available in demo mode.' : undefined}
          onClose={() => panels.setShowSystem(false)}
        />
      </div>

      {/* Timeline panel (slide-in from bottom) */}
      <div ref={panels.panelRefs.timeline} style={{ display: 'contents' }}>
        <TimelinePanel
          visible={panels.showTimeline}
          timelineEntries={sim.timelineEntries}
          currentTime={sim.currentTime}
          onClose={() => panels.setShowTimeline(false)}
        />
      </div>
    </>
  )
}
