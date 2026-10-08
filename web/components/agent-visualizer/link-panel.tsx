'use client'

import { emptyState } from '@/lib/ui-glossary'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Agent } from '@/lib/agent-types'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import type { AgentLink } from '@/hooks/simulation/types'
import { buildLinkPanelModel, type LinkPanelEntry } from './canvas/link-panel-model'
import { GlassCard } from './glass-card'
import { useCopyFeedback } from '@/hooks/use-copy-feedback'
import { conversationToMarkdown, copyText, downloadText, exportFileName, exportNotes, type CommsExportEntry } from '@/lib/comms-export'
import { PanelHeader, useDialogBehavior, useDockPanel, dockAttrs } from './shared-ui'

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
  // Right dock, stacked above Files / Conversation (shared layout: never over another panel)
  const dock = useDockPanel('link', true)
  const { rect } = dock

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
  // The message list is a scroll container: it joins the tab order only while it actually scrolls, so a
  // keyboard user can scroll it even when every entry is short (WCAG 2.1.1). Set imperatively because the
  // jsx-a11y rule rejects a static tabIndex on a list.
  const listRef = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    if (el.scrollHeight > el.clientHeight + 1) el.setAttribute('tabindex', '0')
    else el.removeAttribute('tabindex')
  }, [model.entries.length, expanded])
  const collapsible = model.entries.filter(e => e.long)
  const allExpanded = collapsible.length > 0 && collapsible.every(e => expanded.has(e.id))

  const toggle = (id: string) => setExpanded(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const { message: feedback, notify } = useCopyFeedback()
  const toExport = (e: LinkPanelEntry): CommsExportEntry => ({
    label: e.typeLabel, sender: e.senderName, receiver: e.receiverName, time: e.timeText,
    content: e.content, isError: e.isError, truncatedChars: e.truncatedChars,
  })
  const copyEntry = async (e: LinkPanelEntry) => {
    const ok = await copyText(e.content)
    const cut = e.truncatedChars > 0 ? ` (truncated: ${e.truncatedChars} characters were cut)` : ''
    notify(ok ? `${e.typeLabel} copied${cut}` : 'Copy failed: select the text and copy it by hand')
  }
  const exportAll = () => {
    const title = `${model.fromName} and ${model.toName}: ${model.kindLabel}`
    const md = conversationToMarkdown({ title, entries: model.entries.map(toExport), notes: exportNotes({ droppedText: model.droppedText }) })
    notify(downloadText(exportFileName(title), md) ? 'Conversation exported as Markdown' : 'Export failed in this browser')
  }
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
      {...dockAttrs('link', 'right', dock)}
      className="link-panel outline-none"
      style={{
        position: 'absolute',
        left: rect?.x ?? 'auto',
        right: rect ? 'auto' : 12,
        top: rect?.y ?? 'calc(var(--topbar-h, 60px) + 8px)',
        width: rect?.w ?? 380,
        maxWidth: 'calc(100vw - 24px)',
        zIndex: Z.detailCard,
        display: dock.hidden ? 'none' : undefined,
      }}
    >
      <GlassCard visible={true} style={{ display: 'flex', flexDirection: 'column', maxHeight: rect?.h ?? 'min(60vh, 28rem)' }}>
        <PanelHeader
          onClose={onClose}
          className="mb-2"
          titleId={titleId}
          actions={(
            <>
              {model.entries.length > 0 && (
                <button
                  type="button"
                  onClick={exportAll}
                  className={buttonClass}
                  style={{ color: COLORS.textPrimary, border: `1px solid ${COLORS.controlBorder}` }}
                >
                  Export conversation
                </button>
              )}
              {collapsible.length > 0 && (
                <button
                  type="button"
                  onClick={toggleAll}
                  className={buttonClass}
                  style={{ color: COLORS.textPrimary, border: `1px solid ${COLORS.controlBorder}` }}
                >
                  {allExpanded ? 'Collapse all' : 'Show all'}
                </button>
              )}
            </>
          )}
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

        <p role="status" className="m-0 min-h-0 text-[11px] font-mono empty:hidden" style={{ color: COLORS.textPrimary }}>{feedback}</p>

        {model.entries.length === 0 ? (
          <p className="text-xs font-mono" style={{ color: COLORS.textMuted }}>{emptyState('messages on this link')}</p>
        ) : (
          <ol
            ref={listRef}
            className="m-0 flex min-h-0 flex-1 list-none flex-col gap-2 overflow-y-auto p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#99e0ff]"
            aria-label="Messages, oldest first"
          >
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
                  <div className="mt-1 flex flex-wrap gap-1">
                    {entry.long && (
                      <button
                        type="button"
                        onClick={() => toggle(entry.id)}
                        aria-expanded={isOpen}
                        aria-controls={contentId}
                        className={buttonClass}
                        style={{ color: COLORS.textPrimary }}
                      >
                        {isOpen ? 'Show less' : 'Show more'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => { void copyEntry(entry) }}
                      aria-label={`Copy ${entry.typeLabel.toLowerCase()}, ${entry.directionText}`}
                      className={buttonClass}
                      style={{ color: COLORS.textPrimary }}
                    >
                      Copy
                    </button>
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </GlassCard>
    </div>
  )
}
