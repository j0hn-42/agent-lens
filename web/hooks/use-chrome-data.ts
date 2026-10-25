'use client'

import { useCallback, useMemo, type RefObject } from 'react'
import type { useAgentSimulation } from '@/hooks/use-agent-simulation'
import type { useVSCodeBridge } from '@/hooks/use-vscode-bridge'
import { useFreshnessValue } from '@/hooks/use-freshness-clock'
import { parseTeamSelection } from '@/lib/bridge-types'
import { agentActivityCounts, buildSessionMeta, connectionDisplay, labelAgentsWithSession } from '@/lib/chrome-utils'
import { listedAgents, emptiedByHidingCount } from '@/lib/inactive-agents'
import { deriveSessionLinks } from '@/lib/session-links'
import { detectedSessions } from '@/lib/session-model'
import { selectionLabel } from '@/lib/session-tree'
import { useLocale } from '@/lib/locale'
import { translate } from '@/lib/messages'

type Simulation = ReturnType<typeof useAgentSimulation>
type Bridge = ReturnType<typeof useVSCodeBridge>

/** The figures, labels and lists the chrome (top bar, announcer, panels) derives from the agents and the session list */
export function useChromeData(
  agents: Simulation['agents'],
  agentsRef: RefObject<Simulation['agents']>,
  bridge: Bridge,
  selectedAgentId: string | null,
  hideInactiveShown: boolean,
) {
  // Agents whose status is older than the freshness limit are counted apart: they are not "active" any more (#145)
  const countsKey = useFreshnessValue(now => {
    const c = agentActivityCounts(agentsRef.current!.values(), now)
    return `${c.active}|${c.done}|${c.stale}|${c.idle}|${c.error}`
  })
  const { activeAgentCount, doneAgentCount, staleAgentCount, idleAgentCount, errorAgentCount } = useMemo(() => {
    const [active, done, stale, idle, error] = countsKey.split('|').map(Number)
    return { activeAgentCount: active, doneAgentCount: done, staleAgentCount: stale, idleAgentCount: idle, errorAgentCount: error }
  }, [countsKey, agents])

  const { locale } = useLocale()

  // 'All' counts only the sessions it shows (all of them while finished ones are included)
  const allSessionCount = useMemo(() => {
    const ids = bridge.allViewSessionIds
    return detectedSessions(bridge.sessions).filter(s => !ids || ids.has(s.id)).length
  }, [bridge.allViewSessionIds, bridge.sessions])

  const connection = connectionDisplay(bridge.connectionStatus, bridge.useMockData)
  const selectedSessionLabel = bridge.isAllSelected
    ? translate(locale, 'sessions.allSessions')
    : parseTeamSelection(bridge.selectedSessionId) !== null
      ? selectionLabel(bridge.selectedSessionId, bridge.sessions, bridge.teams)
      : bridge.sessions.find(s => s.id === bridge.selectedSessionId)?.label ?? null

  // The selected agent stays listed even when it would be hidden
  const hiddenKeepIds = useMemo(() => [selectedAgentId], [selectedAgentId])
  // Same finished agents as the canvas and the DOM mirror (#147): the sessions list must not show what is announced hidden
  const listAgents = useMemo(() => listedAgents(agents, hideInactiveShown, hiddenKeepIds), [agents, hideInactiveShown, hiddenKeepIds])
  // Every agent finished and hidden: the canvas would be blank without a word (#369)
  const blankByHidingCount = useMemo(() => emptiedByHidingCount(agents, hideInactiveShown, hiddenKeepIds), [agents, hideInactiveShown, hiddenKeepIds])
  // Agents labelled with their session (label + runtime) so the feed can show a session chip
  const labelledAgents = useMemo(() => labelAgentsWithSession(agents, bridge.sessions), [agents, bridge.sessions])

  // Halo titles (session label, runtime, workspace, status) come from the session list
  const sessionMeta = useMemo(() => buildSessionMeta(bridge.sessions), [bridge.sessions])
  const sessionLinks = useMemo(() => deriveSessionLinks(bridge.sessions), [bridge.sessions])
  // Permission requests (#240) name their session with the label of the list when it has one
  const permissionSessionLabel = useCallback(
    (id: string) => bridge.sessions.find(s => s.id === id)?.label,
    [bridge.sessions],
  )

  return {
    activeAgentCount, doneAgentCount, staleAgentCount, idleAgentCount, errorAgentCount, allSessionCount, connection, selectedSessionLabel,
    hiddenKeepIds, listAgents, blankByHidingCount, labelledAgents, sessionMeta, sessionLinks, permissionSessionLabel,
  }
}
