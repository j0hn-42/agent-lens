// Browser entry of the top bar harness (topbar-worstcase.ts): the REAL TopBar, with props that make row 1 as full as it gets
// (attention counter, scope selector with its ceilings, finished-sessions toggle). The demo cannot draw these three: they need
// a relay link and finished sessions. Bundled by esbuild at test time; nothing of it ships.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { TopBar, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'
import { parseRelayScopeState } from '@/lib/relay-scope'

const noop = () => {}
const scopeState = parseRelayScopeState({
  relayVersion: '1', workspace: '/home/me/code/alpha', runtimes: ['claude'], hooksConfigured: true, disable1MContext: false,
  sessionCount: 1, allWorkspaces: false,
  // ?ceilings=0: no discovery ceiling reached, so the scope sentence is the only text next to the select
  skippedSessions: new URLSearchParams(location.search).get('ceilings') === '0' ? { watchLimit: 0, sizeLimit: 0, fileLimit: 0 } : { watchLimit: 1, sizeLimit: 2, fileLimit: 2 },
  discovery: { projectDirsCapped: false, maxProjectDirs: 200, maxFilesPerDir: 500 },
})!
const sessions = [{ id: 's1', label: 'alpha-run', status: 'active', startTime: 1, lastActivityTime: 2, projectId: 'p', projectName: 'Alpha' }] as TopBarProps['sessions']
const props: TopBarProps = {
  sessions, selectedSessionId: ALL_SESSIONS_ID, sessionsWithActivity: new Set(['other']),
  showSessions: false, onToggleSessions: noop, isVSCode: false, connectionStatus: 'watching',
  activeAgentCount: 2, staleAgentCount: 1, idleAgentCount: 1, errorAgentCount: 1, doneAgentCount: 3, totalTokens: 1200, totalCost: 1, unattributedCost: 0.5,
  showFileAttention: false, showConversation: false, showCostOverlay: false, showTimeline: false, isMuted: false,
  onTogglePanel: noop, onToggleTimeline: noop, onToggleStats: noop, showStats: false, onToggleMute: noop, onOpenShortcuts: noop,
  onChangeShowMode: noop, onOpenSettings: noop, onToggleFullscreen: noop, onOpenPalette: noop, notifyState: 'off', onToggleNotify: noop,
  showMode: 'active',
  attention: { waiting: 2, errors: 1 }, onJumpToAttention: noop,
  scope: { state: scopeState, sessions, projectId: null, pending: false, error: null, onChoose: noop },
}
createRoot(document.getElementById('root')!).render(<TopBar {...props} />)
