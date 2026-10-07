'use client'

import { emptyState } from '@/lib/ui-glossary'
import { useCallback, type KeyboardEvent } from 'react'
import type { A11yModel, A11yAgentItem, CommEntry, AnnouncementItem } from './canvas/a11y-model'
import type { NavNode } from './canvas/keyboard-nav'
import type { LinkMessageItem } from './canvas/edge-bubble-set'

interface GraphA11yListProps {
  model: A11yModel
  /** Dispatch / return exchanges, newest last */
  communications: CommEntry[]
  /** Recent semantic transitions, announced through the polite live region */
  announcements: AnnouncementItem[]
  focusedNode: NavNode | null
  onAgentClick: (agentId: string | null) => void
  onToolCallClick?: (toolCallId: string | null) => void
  onDiscoveryClick?: (discoveryId: string | null) => void
  /** Open the link panel for a communication link */
  onLinkClick?: (linkId: string) => void
  /** Recent messages of the links (the same ones the bubbles on the edges show), each opening the link panel */
  linkMessages?: LinkMessageItem[]
  /** Id of the link whose panel is open (aria-current) */
  selectedLinkId?: string | null
  /** Zoom to a session / team cluster (same action as a click on its halo label) */
  onClusterClick?: (clusterKey: string) => void
  /** Key of the cluster last selected (aria-current) */
  selectedClusterKey?: string | null
  /** Sync the canvas focus ring / camera with the focused list button */
  onFocusNode: (node: NavNode) => void
}

/**
 * Visually hidden DOM mirror of the canvas graph (WCAG 1.1.1, 1.3.1, 4.1.2).
 * Items that can open a detail view are real buttons wired to the same callbacks as
 * canvas clicks; arrow keys move between them (roving tabindex, one tab stop).
 * Tool-call history stays here after the canvas card fades.
 */
export function GraphA11yList({
  model, communications, announcements, focusedNode,
  onAgentClick, onToolCallClick, onDiscoveryClick, onLinkClick, linkMessages, selectedLinkId, onClusterClick, selectedClusterKey, onFocusNode,
}: GraphA11yListProps) {
  const isFocused = (type: NavNode['type'], id: string) => focusedNode?.type === type && focusedNode.id === id
  // Roving tabindex: the focused node (or the first agent) is the single tab stop of the list
  const hasFocusedButton = !!focusedNode && (
    (focusedNode.type === 'agent' && model.agents.some(a => a.id === focusedNode.id))
    || (focusedNode.type === 'tool' && model.agents.some(a => a.tools.some(t => t.id === focusedNode.id && t.live)))
    || (focusedNode.type === 'discovery' && model.discoveries.some(d => d.id === focusedNode.id))
  )
  const tabIndexFor = (type: NavNode['type'], id: string, isFirst: boolean) =>
    isFocused(type, id) || (!hasFocusedButton && isFirst) ? 0 : -1

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
    if (!keys.includes(e.key)) return
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-graph-node]'))
    const index = buttons.indexOf(e.target as HTMLButtonElement)
    if (index === -1) return
    e.preventDefault()
    e.stopPropagation()
    const next = e.key === 'Home' ? 0
      : e.key === 'End' ? buttons.length - 1
      : e.key === 'ArrowDown' ? Math.min(buttons.length - 1, index + 1)
      : Math.max(0, index - 1)
    buttons[next]?.focus()
  }, [])

  // Outline order: agents outside any cluster, then one group per session / team (heading + agents)
  const byCluster = new Map<string, A11yAgentItem[]>()
  const ungrouped: A11yAgentItem[] = []
  for (const agent of model.agents) {
    if (agent.clusterKey && model.clusters.some(c => c.key === agent.clusterKey)) {
      const list = byCluster.get(agent.clusterKey) ?? []
      list.push(agent)
      byCluster.set(agent.clusterKey, list)
    } else {
      ungrouped.push(agent)
    }
  }
  const groups = model.clusters
    .map(cluster => ({ cluster, agents: byCluster.get(cluster.key) ?? [] }))
    .filter(g => g.agents.length > 0)
  const firstAgentId = (ungrouped[0] ?? groups[0]?.agents[0])?.id

  const renderAgent = (agent: A11yAgentItem) => (
    <li key={agent.id}>
      <button
        type="button"
        data-graph-node=""
        tabIndex={tabIndexFor('agent', agent.id, agent.id === firstAgentId)}
        onFocus={() => onFocusNode({ type: 'agent', id: agent.id })}
        onClick={() => onAgentClick(agent.id)}
      >
        {agent.name}, {agent.orchestrator ? 'orchestrator, ' : ''}{agent.stateText}
        {agent.activityText ? `, ${agent.activityText}` : ''}
        {agent.archived ? ', archived' : ''}
      </button>
      <p>
        {agent.orchestrator === 'lead' ? 'Orchestrator, lead of the team. ' : agent.orchestrator === 'main' ? 'Orchestrator, main agent of the session. ' : ''}
        {agent.teamName ? `Teammate in team ${agent.teamName}. ` : ''}
        {agent.sessionLabel ? `Session ${agent.sessionLabel}. ` : ''}
        {agent.relation}. {agent.runtime}, {agent.model}. {agent.tokens}. Cost {agent.cost}. {agent.toolCalls} tool calls.
      </p>
      {agent.childNames.length > 0 && (
        <p>Parent of {agent.childNames.join(', ')}.</p>
      )}
      {agent.tools.length > 0 && (
        <ul aria-label={`Tool calls of ${agent.name}`}>
          {agent.tools.map(tool => {
            const text = `${agent.name} called ${tool.name}${tool.args ? ` ${tool.args}` : ''}, ${tool.stateText}${tool.error ? `, error: ${tool.error}` : ''}${tool.warning ? `. ${tool.warning}` : ''}`
            return (
              <li key={tool.id}>
                {tool.live ? (
                  <button
                    type="button"
                    data-graph-node=""
                    tabIndex={tabIndexFor('tool', tool.id, false)}
                    onFocus={() => onFocusNode({ type: 'tool', id: tool.id })}
                    onClick={() => onToolCallClick?.(tool.id)}
                  >
                    {text}
                  </button>
                ) : (
                  // Faded from the canvas: kept as history text (no card left to open)
                  <span>{text}</span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </li>
  )

  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="false" className="sr-only">
        {announcements.map(a => <p key={a.id}>{a.text}</p>)}
      </div>

      <section aria-label="Agent graph outline" className="sr-only" onKeyDown={handleKeyDown}>
        <h2>Agent graph outline</h2>
        <p>Use arrow keys to move between items and Enter to open details.</p>
        {model.agents.length === 0 ? (
          <p>{emptyState('agents')}</p>
        ) : (
          <>
            {ungrouped.length > 0 && <ul>{ungrouped.map(agent => renderAgent(agent))}</ul>}
            {groups.map(group => (
              <div key={group.cluster.key}>
                <h3>{group.cluster.kind === 'team' ? 'Team' : 'Session'} {group.cluster.title}</h3>
                <p>{group.cluster.text}</p>
                {onClusterClick && (
                  <button
                    type="button"
                    data-graph-node=""
                    tabIndex={-1}
                    aria-current={group.cluster.key === selectedClusterKey ? 'true' : undefined}
                    onClick={() => onClusterClick(group.cluster.key)}
                  >
                    Zoom to {group.cluster.kind === 'team' ? 'team' : 'session'} {group.cluster.title}
                  </button>
                )}
                <ul aria-label={`Agents of ${group.cluster.kind === 'team' ? 'team' : 'session'} ${group.cluster.title}`}>
                  {group.agents.map(agent => renderAgent(agent))}
                </ul>
              </div>
            ))}
          </>
        )}

        {model.teams.length > 0 && (
          <>
            <h3>Teams</h3>
            <ul>
              {model.teams.map(team => <li key={team.key}>{team.text}</li>)}
            </ul>
          </>
        )}

        {model.links.length > 0 && (
          <>
            <h3>Links</h3>
            <p>Each link opens the list of its messages.</p>
            <ul>
              {model.links.map(link => (
                <li key={link.id}>
                  <button
                    type="button"
                    data-graph-node=""
                    tabIndex={-1}
                    aria-current={link.id === selectedLinkId ? 'true' : undefined}
                    onClick={() => onLinkClick?.(link.id)}
                  >
                    {link.text}
                  </button>
                </li>
              ))}
            </ul>
            {linkMessages && linkMessages.length > 0 && (
              <ul aria-label="Link messages">
                {linkMessages.map(item => (
                  <li key={item.id}>
                    <button
                      type="button"
                      data-graph-node=""
                      tabIndex={-1}
                      onClick={() => onLinkClick?.(item.linkId)}
                    >
                      {item.text}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {model.discoveries.length > 0 && (
          <>
            <h3>Discoveries</h3>
            <ul>
              {model.discoveries.map(d => (
                <li key={d.id}>
                  <button
                    type="button"
                    data-graph-node=""
                    tabIndex={tabIndexFor('discovery', d.id, false)}
                    onFocus={() => onFocusNode({ type: 'discovery', id: d.id })}
                    onClick={() => onDiscoveryClick?.(d.id)}
                  >
                    {d.type} found by {d.agentName}: {d.label}
                  </button>
                  {d.content && <p>{d.content}</p>}
                </li>
              ))}
            </ul>
          </>
        )}

        {communications.length > 0 && (
          <>
            <h3>Communications</h3>
            <ul>
              {communications.map(c => <li key={c.id}>{c.text}</li>)}
            </ul>
          </>
        )}
      </section>
    </>
  )
}
