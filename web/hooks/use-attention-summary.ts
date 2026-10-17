'use client'

import { useState, useEffect, useMemo, useCallback, useRef, type RefObject } from 'react'
import type { useAgentSimulation } from '@/hooks/use-agent-simulation'
import type { useVSCodeBridge } from '@/hooks/use-vscode-bridge'
import { useAttentionAlerts } from '@/hooks/use-attention-alerts'
import { useNotificationRules } from '@/hooks/use-notification-rules'
import { vscodeBridge } from '@/lib/vscode-bridge'
import { sessionUsage } from '@/lib/attribution'
import { nextAttentionTarget, summarizeAttention, withForeignAttention } from '@/lib/attention'
import { assessHealth } from '@/lib/loop-detection'

type Simulation = ReturnType<typeof useAgentSimulation>
type Bridge = ReturnType<typeof useVSCodeBridge>

interface AttentionSummaryInput {
  sim: Pick<Simulation, 'agents' | 'unattributed' | 'foreignAttention' | 'conversations' | 'droppedMessages' | 'catchUp'>
  /** Always the agents of the latest render: callbacks read it without being re-created */
  agentsRef: RefObject<Simulation['agents']>
  bridge: Pick<Bridge, 'sessions' | 'isVSCode' | 'selectSession' | 'eventLoss'>
  /** Select an agent of this view (the one that waits for the operator) */
  selectAgent: (agentId: string | null) => void
  /** The selected agent: the next jump starts after it when it is one of the blocked agents (#377) */
  selectedAgentId: string | null
}

/** Session totals, the agents that need the operator (#126), the notification rules (#225) and the loop verdicts (#230) */
export function useAttentionSummary({ sim, agentsRef, bridge, selectAgent, selectedAgentId }: AttentionSummaryInput) {
  const { agents, unattributed, foreignAttention, conversations, droppedMessages, catchUp } = sim

  // Totals never show a missing figure as 0: agents without data make them a lower bound; usage that belongs
  // to no single agent is kept apart (#61) but counts in the session total
  const usage = useMemo(() => sessionUsage(agents.values(), unattributed.values()), [agents, unattributed])

  // Agents waiting for a permission or in error (#126): counter, tab title and opt-in notification.
  // The clock only re-evaluates freshness: a waiting status nothing proves any more drops out.
  const [attentionNow, setAttentionNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setAttentionNow(Date.now()), 10_000)
    return () => clearInterval(t)
  }, [])
  const attention = useMemo(() => summarizeAttention(withForeignAttention(agents.values(), foreignAttention), Math.max(attentionNow, Date.now())), [agents, foreignAttention, attentionNow])
  // Configurable triggers (#225): rules chosen in Settings; inside VS Code the item goes to the extension
  const { rules: notifyRules, setRules: setNotifyRules } = useNotificationRules()
  const sendNative = useCallback((item: { trigger: string; title: string; body: string }) => vscodeBridge?.notify(item), [])
  const { notifyState, toggleNotify } = useAttentionAlerts(attention, {
    rules: notifyRules, sessions: bridge.sessions, cost: usage.cost, replaying: catchUp !== null,
    native: bridge.isVSCode ? sendNative : undefined,
  })
  // Loop verdict (#230), per agent and per session, from the tool calls kept in the conversations of this view.
  // Recomputed when a conversation changes, not on every frame; an agent's session never changes.
  // Events the relay could not replay (#366) make a session's verdict "incomplete", never "clear".
  const replayLost = useMemo(() => new Map(Object.entries(bridge.eventLoss?.evicted ?? {})), [bridge.eventLoss])
  const health = useMemo(
    () => assessHealth(conversations, droppedMessages, k => agentsRef.current?.get(k)?.sessionId, replayLost),
    [conversations, droppedMessages, agentsRef, replayLost],
  )
  // Each jump goes to the blocked agent after the selected one (or after the last jump, when the selection is not a
  // blocked agent: an agent of another session is not in this view, so its session is selected instead) (#377)
  const lastJumpRef = useRef<string | null>(null)
  const nextTarget = useCallback(() => {
    const current = selectedAgentId && attention.blockedIds.has(selectedAgentId) ? selectedAgentId : lastJumpRef.current
    return nextAttentionTarget(attention, current)
  }, [attention, selectedAgentId])
  const jumpToAttention = useCallback(() => {
    const target = nextTarget()
    if (!target) return
    lastJumpRef.current = target.id
    if (agentsRef.current?.has(target.id)) selectAgent(target.id)
    else bridge.selectSession(target.sessionId)
  }, [nextTarget, selectAgent, bridge, agentsRef])
  /** The next jump selects an agent of this view (its card takes the focus), not another session */
  const nextAttentionInView = useCallback(() => {
    const target = nextTarget()
    return target !== null && Boolean(agentsRef.current?.has(target.id))
  }, [nextTarget, agentsRef])

  return { usage, attention, notifyRules, setNotifyRules, notifyState, toggleNotify, health, jumpToAttention, nextAttentionInView }
}
