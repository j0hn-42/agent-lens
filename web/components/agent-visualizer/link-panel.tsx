'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Agent } from '@/lib/agent-types'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import type { AgentLink } from '@/hooks/simulation/types'
import { buildLinkPanelModel, type LinkPanelEntry } from './canvas/link-panel-model'
import { GlassCard } from './glass-card'
import { PanelHeader, useDialogBehavior } from './shared-ui'

interface LinkPanelProps {
  link: AgentLink
  agents: Map<string, Agent>
  onClose: () => void
}

const TYPE_COLOR: Record<LinkPanelEntry['type'], string> = {
  dispatch: COLORS.dispatch,
  return: COLORS.return,
  message: COLORS.holoBase,
}

/**
 * Detail panel of a communication link: every message of the link in chronological order, with sender,
 * receiver, direction, time and the full content (long messages collapse; "Show all" expands them).
 *
 * Semantics: a non-modal `role="dialog"`, like the other detail cards of the visualizer. It opens with
 * focus on the dialog, closes with Escape or the close button (and when focus leaves it), and gives
 * focus back to what opened it (useDialogBehavior). It does not trap focus or block the canvas: the
 * graph stays usable behind it, which is why it is not `aria-modal`.
 */
export function LinkPanel({ link, agents, onClose }: LinkPanelProps) {
  const titleId = useId()
  const descId = useId()
  const ref = useRef<HTMLDivElement>(null)
  useDialogBehavior(ref, onClose)

  // Escape closes exactly this layer (one Escape, one thing: see shared-ui's arbitration note).
  // A native listener keeps the dialog element free of JSX key handlers.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      onCloseRef.current()
    }
    el.addEventListener('keydown', onKeyDown)
    return () => el.removeEventListener('keydown', onKeyDown)
  }, [])

  const model = useMemo(() => buildLinkPanelModel(link, agents), [link, agents])
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const collapsible = model.entries.filter(e => e.long)
  const allExpanded = collapsible.length > 0 && collapsible.every(e => expanded.has(e.id))

  const toggle = (id: string) => setExpanded(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const toggleAll = () => setExpanded(allExpanded ? new Set() : new Set(collapsible.map(e => e.id)))

  const buttonClass = 'inline-flex min-h-6 min-w-6 items-center justify-center rounded px-2 text-[11px] font-mono '
    + 'hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#99e0ff]'

  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={titleId}
      aria-describedby={descId}
      tabIndex={-1}
      className="link-panel max-w-[calc(100vw-24px)] outline-none"
      style={{ position: 'absolute', right: 12, top: 56, width: 380, zIndex: Z.detailCard }}
    >
      <GlassCard visible={true}>
        <PanelHeader
          onClose={onClose}
          className="mb-2"
          titleId={titleId}
          actions={collapsible.length > 0 ? (
            <button
              type="button"
              onClick={toggleAll}
              aria-pressed={allExpanded}
              className={buttonClass}
              style={{ color: COLORS.textPrimary, border: `1px solid ${COLORS.controlBorder}` }}
            >
              {allExpanded ? 'Collapse all' : 'Show all'}
            </button>
          ) : undefined}
        >
          <span className="flex min-w-0 flex-col">
            <span className="break-words text-xs font-mono" style={{ color: COLORS.textPrimary }}>
              {model.fromName} <span aria-hidden="true">{'↔'}</span><span className="sr-only">and</span> {model.toName}
            </span>
            <span className="text-[11px] font-mono" style={{ color: COLORS.textMuted }}>{model.kindLabel}</span>
          </span>
        </PanelHeader>

        <p id={descId} className="mb-2 text-[11px] font-mono" style={{ color: COLORS.textMuted }}>
          {model.summary}
          {model.droppedText ? `. ${model.droppedText}.` : ''}
        </p>

        {model.entries.length === 0 ? (
          <p className="text-xs font-mono" style={{ color: COLORS.textMuted }}>No message on this link yet.</p>
        ) : (
          <ol className="m-0 flex max-h-[min(60vh,28rem)] list-none flex-col gap-2 overflow-y-auto p-0" aria-label="Messages, oldest first">
            {model.entries.map(entry => {
              const isOpen = !entry.long || expanded.has(entry.id)
              const color = entry.isError ? COLORS.error : TYPE_COLOR[entry.type]
              const contentId = `${descId}-${entry.id}`
              return (
                <li
                  key={entry.id}
                  className="rounded-md p-2"
                  style={{ background: COLORS.holoBg05, borderLeft: `3px solid ${color}` }}
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-mono">
                    <span aria-hidden="true" style={{ color }}>{entry.arrow}</span>
                    <span className="font-semibold" style={{ color }}>
                      {entry.typeLabel}{entry.isError ? ' (error)' : ''}
                    </span>
                    <span className="break-words" style={{ color: COLORS.textPrimary }}>
                      <span className="sr-only">{entry.directionText}</span>
                      <span aria-hidden="true">{entry.senderName} {entry.arrow} {entry.receiverName}</span>
                    </span>
                    <span className="ml-auto" style={{ color: COLORS.textMuted }}>{entry.timeText}</span>
                  </div>
                  <pre
                    id={contentId}
                    className="m-0 mt-1 whitespace-pre-wrap break-words font-mono text-xs"
                    style={{
                      color: COLORS.textPrimary,
                      maxHeight: isOpen ? undefined : '7.5rem',
                      overflow: isOpen ? undefined : 'hidden',
                    }}
                  >
                    {entry.content || '(empty message)'}
                  </pre>
                  {entry.long && (
                    <button
                      type="button"
                      onClick={() => toggle(entry.id)}
                      aria-expanded={isOpen}
                      aria-controls={contentId}
                      className={`${buttonClass} mt-1`}
                      style={{ color: COLORS.textPrimary }}
                    >
                      {isOpen ? 'Show less' : 'Show more'}
                    </button>
                  )}
                </li>
              )
            })}
          </ol>
        )}
      </GlassCard>
    </div>
  )
}
