'use client'

import { useState, useEffect, useMemo, useCallback, type RefObject } from 'react'
import type { useAgentSimulation } from '@/hooks/use-agent-simulation'
import type { useVSCodeBridge } from '@/hooks/use-vscode-bridge'
import { useAttentionAlerts } from '@/hooks/use-attention-alerts'
import { useNotificationRules } from '@/hooks/use-notification-rules'
import { vscodeBridge } from '@/lib/vscode-bridge'
import { sessionUsage } from '@/lib/attribution'
import { summarizeAttention, withForeignAttention } from '@/lib/attention'
import { assessHealth } from '@/lib/loop-detection'

type Simulation = ReturnType<typeof useAgentSimulation>
type Bridge = ReturnType<typeof useVSCodeBridge>

interface AttentionSummaryInput {
  sim: Pick<Simulation, 'agents' | 'unattributed' | 'foreignAttention' | 'conversations' | 'droppedMessages' | 'catchUp'>
  /** Always the agents of the latest render: callbacks read it without being re-created */
  agentsRef: RefObject<Simulation['agents']>
  bridge: Pick<Bridge, 'sessions' | 'isVSCode' | 'selectSession'>
  /** Select an agent of this view (the one that waits for the operator) */
  selectAgent: (agentId: string | null) => void
}

/** Session totals, the agents that need the operator (#126), the notification rules (#225) and the loop verdicts (#230) */
export function useAttentionSummary({ sim, agentsRef, bridge, selectAgent }: AttentionSummaryInput) {
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
  const attentionTarget = attention.firstAgentId
  const attentionSession = attention.firstSessionId
  // Loop verdict (#230), per agent and per session, from the tool calls kept in the conversations of this view.
  // Recomputed when a conversation changes, not on every frame; an agent's session never changes.
  const health = useMemo(
    () => assessHealth(conversations, droppedMessages, k => agentsRef.current?.get(k)?.sessionId),
    [conversations, droppedMessages, agentsRef],
  )
  // An agent of another session is not in this view: go to its session instead
  const jumpToAttention = useCallback(() => {
    if (!attentionTarget) return
    if (agentsRef.current?.has(attentionTarget)) selectAgent(attentionTarget)
    else if (attentionSession) bridge.selectSession(attentionSession)
  }, [attentionTarget, attentionSession, selectAgent, bridge, agentsRef])

  return { usage, attention, notifyRules, setNotifyRules, notifyState, toggleNotify, health, jumpToAttention }
}
