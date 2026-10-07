'use client'

import { useCallback, type KeyboardEvent } from 'react'
import type { A11yModel, CommEntry, AnnouncementItem } from './canvas/a11y-model'
import type { NavNode } from './canvas/keyboard-nav'

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
  onAgentClick, onToolCallClick, onDiscoveryClick, onFocusNode,
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

  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="false" className="sr-only">
        {announcements.map(a => <p key={a.id}>{a.text}</p>)}
      </div>

      <section aria-label="Agent graph outline" className="sr-only" onKeyDown={handleKeyDown}>
        <h2>Agent graph outline</h2>
        <p>Use arrow keys to move between items and Enter to open details.</p>
        {model.agents.length === 0 ? (
          <p>No agents yet.</p>
        ) : (
          <ul>
            {model.agents.map((agent, index) => (
              <li key={agent.id}>
                <button
                  type="button"
                  data-graph-node=""
                  tabIndex={tabIndexFor('agent', agent.id, index === 0)}
                  onFocus={() => onFocusNode({ type: 'agent', id: agent.id })}
                  onClick={() => onAgentClick(agent.id)}
                >
                  {agent.name}, {agent.stateText}
                </button>
                <p>
                  {agent.relation}. {agent.runtime}, {agent.model}. {agent.tokens}. Cost {agent.cost}. {agent.toolCalls} tool calls.
                </p>
                {agent.childNames.length > 0 && (
                  <p>Parent of {agent.childNames.join(', ')}.</p>
                )}
                {agent.tools.length > 0 && (
                  <ul aria-label={`Tool calls of ${agent.name}`}>
                    {agent.tools.map(tool => {
                      const text = `${agent.name} called ${tool.name}${tool.args ? ` ${tool.args}` : ''}, ${tool.stateText}${tool.error ? `, error: ${tool.error}` : ''}`
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
            ))}
          </ul>
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
