// Scope of the replay loss (#366) as the shell hands it to the panels: the agent card gets the count of the
// agent's OWN session (never the total of a view that groups sessions), the Files panel gets bridge.replayLost
// (the selection's figure, computed once in the bridge: a team counts only its sessions, never otherEvents).
// The cards are rendered with hand-made props elsewhere (inspector-own-state, file-conflicts-panel); here the
// value goes through SelectionOverlays and PanelDock, so dropping or re-scoping that wiring fails a test.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'

import { SelectionOverlays } from '@/components/agent-visualizer/selection-overlays'
import { PanelDock } from '@/components/agent-visualizer/panel-dock'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const noop = () => {}
// A view that groups sessions: s1 lost 3, s2 lost 40, and 9 events of sessions the relay no longer names
const LOSS = { evicted: { s1: 3, s2: 40 }, otherEvents: 9 }

function overlays(agent: Record<string, unknown>, eventLoss: typeof LOSS | null) {
  const props = {
    selection: { selectedAgentWorldPos: { x: 10, y: 10 }, selectedAgentId: agent.id, handleAgentClick: noop, clearAgent: noop, setContextMenu: noop, clearTool: noop, clearDiscovery: noop },
    inspector: { selectedAgent: agent, selectedGone: false, goneName: null, delegation: [], toolWhy: null },
    agents: new Map(), links: new Map(), droppedMessages: new Map(),
    health: { byAgent: new Map(), bySession: new Map() },
    bridge: { relayOrigin: null, launch: null, eventLoss },
    selectedLinkId: null, onCloseLink: noop, onEscapeFromCard: noop,
    menuActions: { toggleStats: noop, zoomToFit: noop, toggleGrid: noop, clearHistory: noop, reloadSessionEvents: null },
  } as unknown as React.ComponentProps<typeof SelectionOverlays>
  return render(<SelectionOverlays {...props} />)
}

const agent = (sessionId: string | undefined) => ({
  id: `${sessionId}:main`, name: 'Worker', state: 'thinking', tokensUsed: 1, tokensMax: 10, toolCalls: 2, timeAlive: 1,
  toolErrors: 0, lastEventAt: Date.now(), freshnessSource: 'live', sessionId,
})

test('agent card: the replay loss of its own session, not the total of the view', () => {
  const v = overlays(agent('s1'), LOSS)
  const line = v.getByTestId('inspector-replay-lost').textContent ?? ''
  assert.match(line, /at least 3 earlier events/, line)
  assert.match(v.getByTestId('inspector-errors').textContent ?? '', /no tool error observed \(incomplete\)/)
})

test('agent card: a session the relay does not name, or no session at all, claims nothing', () => {
  for (const sid of ['s9', undefined]) {
    const v = overlays(agent(sid), LOSS)
    assert.equal(v.queryByTestId('inspector-replay-lost')?.textContent ?? null, null, `session ${String(sid)}: otherEvents and other sessions are not borrowed`)
    assert.match(v.getByTestId('inspector-errors').textContent ?? '', /^0 tool errors$/)
    cleanup()
  }
})

function dock(replayLost: number) {
  const ref = () => ({ current: null })
  const props = {
    panels: {
      panelRefs: { files: ref(), sessions: ref(), context: ref(), system: ref(), timeline: ref() },
      showFileAttention: true, showSessions: false, showContext: false, showSystem: false, showTimeline: false,
      setShowFileAttention: noop, setShowSessions: noop, setShowContext: noop, setShowSystem: noop, setShowTimeline: noop,
    },
    sim: { fileAttention: new Map(), waste: undefined, agents: new Map(), timelineEntries: new Map(), currentTime: 0 },
    bridge: {
      sessions: [], selectedSessionId: 'team:x', sessionsWithActivity: new Set(), sessionModels: new Map(),
      selectSession: noop, renameSession: noop, useMockData: true, isVSCode: false, connectionStatus: 'connected',
      teams: new Map(), teamWorking: new Map(), teamSummaries: new Map(), teamMemberCounts: new Map(), relayScope: null,
      systemStats: [], quota: null, eventLoss: LOSS, replayLost,
    },
    selection: { selectedAgentId: null, handleAgentClick: noop },
    attention: undefined, health: { bySession: undefined },
    sessionActions: { handleCloseSession: noop, handleExportSession: noop, canExportSession: () => false },
    uiPrefs: { prefs: { sessionListActiveOnly: true }, setPref: noop },
    allSessionCount: 0, listAgents: new Map(), agentLabel: (k: string) => k, openFile: noop,
    fetchContext: async () => null, contextOrigin: '',
  } as unknown as React.ComponentProps<typeof PanelDock>
  return render(<PanelDock {...props} />)
}

test('Files panel: the figure is bridge.replayLost of the selection, not the raw tally', () => {
  const lossy = dock(7)
  assert.match(lossy.getByTestId('file-conflicts-incomplete').textContent ?? '', /at least 7 earlier events/)
  assert.equal(lossy.queryByText('No file observed (incomplete)') !== null, true)
  cleanup()

  // A team whose sessions lost nothing: replayLost is 0 although the tally (and otherEvents) is not empty
  const clean = dock(0)
  assert.equal(clean.queryByTestId('file-conflicts-incomplete')?.textContent ?? null, null)
  assert.equal(clean.queryByText('No file observed (incomplete)') === null, true)
})
