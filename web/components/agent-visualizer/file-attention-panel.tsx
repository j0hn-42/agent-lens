'use client'

import { FileAttention, Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { formatTokens, truncatePath } from '@/lib/utils'
import { PanelHeader, ProgressBar, SlidingPanel, DockResizer, useDockPanel, dockAttrs, dockPanelDomId } from './shared-ui'
import { emptyState, FILE_TIMELINE_LABELS, PANEL_NAMES } from '@/lib/ui-glossary'
import { fileStepTotal, type FileTimeline } from '@/lib/file-timeline'
import { combineUsage, formatTokenUsage, qualify, type UsageTotal } from '@/lib/usage'
import { FOCUS_RING_INSET } from '@/lib/focus-ring'
import { deriveFileConflicts, conflictPath, conflictPathSet, conflictHeading, describeConflictEditors } from '@/lib/file-conflicts'
import { boundedCount, replayLostSentence } from '@/lib/event-loss'
import type { Agent } from '@/lib/agent-types'
import { emptyWasteLedger, type WasteLedger } from '@/lib/waste'
import { WasteSection } from './waste-section'

interface FileAttentionPanelProps {
  visible: boolean
  fileAttention: Map<string, FileAttention>
  onClose: () => void
  onOpenFile?: (filePath: string) => void
  /** Readable name of an agent key ("alpha (session Main)"); the key itself when absent */
  agentLabel?: (agentKey: string) => string
  /** Repeated reads and identical calls (see lib/waste); absent: nothing observed */
  waste?: WasteLedger
  /** Names of the agents the waste rows refer to */
  agents?: ReadonlyMap<string, Agent>
  /** Events the relay could not replay for the shown scope (#366): the conflicts read "at least", a zero is the observed part only */
  replayLost?: number
}

const EMPTY_WASTE = emptyWasteLedger()

/** A file's tokens, qualified like every other figure: a lower bound when a call gave none, estimated when any part is. */
function fileUsage(f: FileAttention): UsageTotal {
  return { value: f.totalTokens, status: f.tokensPartial ? 'partial' : 'available', estimated: f.tokensEstimated === true }
}

/**
 * The calls started count failures and calls still running: when fewer were observed to succeed, say how many
 * did. Without per-agent tracking nothing is claimed.
 */
function succeededNote(started: number, perAgent: readonly { succeeded: number }[] | undefined): string {
  if (!perAgent) return ''
  const succeeded = perAgent.reduce((s, a) => s + a.succeeded, 0)
  return succeeded < started ? ` (${succeeded} succeeded)` : ''
}

/**
 * The observed steps of one file (#385), oldest first, in a native disclosure: each step says its kind in words,
 * its agent and its call id. Steps past the cap are counted; commits are never shown.
 */
function FileTimelineDetails({ path, timeline, label, incomplete }: {
  path: string
  timeline: FileTimeline
  label: (agentKey: string) => string
  incomplete: boolean
}) {
  const L = FILE_TIMELINE_LABELS
  return (
    <details className="mt-1 text-[11px] font-mono">
      <summary className={`cursor-pointer min-h-6 rounded hover:brightness-125 ${FOCUS_RING_INSET}`} style={{ color: COLORS.textMuted }}>
        {L.summary(fileStepTotal(timeline), incomplete)}<span className="sr-only">{L.summaryOf(path)}</span>
      </summary>
      {timeline.omitted > 0 && (
        <p className="m-0 mt-0.5" style={{ color: COLORS.textMuted }}>{L.omitted(timeline.omitted)}</p>
      )}
      <ol aria-label={L.list(path)} className="m-0 mt-0.5 pl-5 list-decimal space-y-0.5" start={timeline.omitted + 1}>
        {timeline.steps.map(s => (
          <li key={s.callId} style={{ color: COLORS.textPrimary }}>
            <span className="font-semibold">{L.kinds[s.kind]}</span>
            {' by '}{label(s.agentId)}
            <span style={{ color: COLORS.textMuted }}>{' · '}{s.toolUseId ? <span className="break-all">call {s.toolUseId}</span> : L.noCallId}</span>
          </li>
        ))}
      </ol>
      <p className="m-0 mt-0.5" style={{ color: COLORS.textMuted }}>{L.noCommits}</p>
    </details>
  )
}

export function FileAttentionPanel({ visible, fileAttention, onClose, onOpenFile, agentLabel, waste = EMPTY_WASTE, agents, replayLost = 0 }: FileAttentionPanelProps) {
  // Right dock (resizable): placed by the shared layout, below the link panel, above the control bar
  const dock = useDockPanel('files', visible)
  const { rect } = dock
  if (!visible) return null

  const files = Array.from(fileAttention.values())
    .sort((a, b) => b.totalTokens - a.totalTokens)

  const maxTokens = Math.max(...files.map(f => f.totalTokens), 1)
  const conflicts = deriveFileConflicts(fileAttention)
  const inConflict = conflictPathSet(conflicts)
  const label = agentLabel ?? ((key: string) => key)

  return (
    <SlidingPanel
      visible={visible}
      position={rect ? { top: rect.y, left: rect.x } : { top: 'calc(var(--topbar-h, 60px) + 8px)', right: 12 }}
      zIndex={Z.sidePanel}
      width={rect?.w ?? 380}
      attrs={{ ...dockAttrs('files', 'right', dock), 'data-sensitive': '' }}
      label={PANEL_NAMES.files}
      style={dock.hidden ? { display: 'none' } : undefined}
    >
      <DockResizer label="Resize files panel" controls={dockPanelDomId('files')} />
      <div className="glass-card relative flex flex-col" style={{ maxHeight: rect?.h }}>
        <PanelHeader onClose={onClose}>
          <span className="text-[11px] font-mono tracking-wider" style={{ color: COLORS.textPrimary }}>
            FILE ATTENTION
          </span>
        </PanelHeader>

        {/* File list */}
        <div
          role="region"
          aria-label="Files accessed by agents"
          tabIndex={0}
          className={`min-h-0 flex-1 overflow-y-auto ${FOCUS_RING_INSET}`}
        >
          <WasteSection waste={waste} agents={agents} onOpenFile={onOpenFile} />
          {files.length === 0 && (
            <div className="text-[11px] font-mono py-2 text-center" style={{ color: COLORS.textMuted }}>
              {replayLost > 0 ? 'No file observed (incomplete)' : emptyState('files')}
            </div>
          )}
          {conflicts.length === 0 && replayLost > 0 && (
            <p data-testid="file-conflicts-incomplete" className="m-0 mb-2 text-[11px] font-mono" style={{ color: COLORS.textMuted }}>
              {conflictHeading(0, replayLost)}: {replayLostSentence(replayLost)}
            </p>
          )}
          {conflicts.length > 0 && (
            <div className="mb-2">
              <h3 id="file-conflicts-heading" className="text-[11px] font-mono font-semibold mb-1" style={{ color: COLORS.error }}>
                {conflictHeading(conflicts.length, replayLost)}: files edited by several agents
              </h3>
              <ul aria-label="File conflicts" className="space-y-1 list-none p-0 m-0">
                {conflicts.map(c => {
                  const who = describeConflictEditors(c, label)
                  return (
                    <li key={c.path} className="rounded px-2 py-1.5 text-[11px] font-mono" style={{ background: COLORS.fileCardBg, border: `1px solid ${COLORS.error}40` }}>
                      {onOpenFile ? (
                        <button
                          type="button"
                          onClick={() => onOpenFile(c.path)}
                          title={c.path}
                          aria-label={`Open ${c.path}, conflict: ${who}`}
                          className={`block w-full min-h-6 truncate rounded text-left hover:brightness-125 ${FOCUS_RING_INSET}`}
                          style={{ color: COLORS.textPrimary }}
                        >
                          {truncatePath(c.path)}
                        </button>
                      ) : (
                        <div className="truncate" title={c.path} style={{ color: COLORS.textPrimary }}>{c.path}</div>
                      )}
                      <p className="m-0 mt-0.5" style={{ color: COLORS.textMuted }}>{who}</p>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
          <ul className="space-y-1 list-none p-0 m-0">
          {files.map((file) => {
            const heatRatio = file.totalTokens / maxTokens
            // A heavy file is not a failure: never the error red
            const heatColor = heatRatio > 0.7 ? COLORS.tool :
              heatRatio > 0.4 ? COLORS.holoBright :
                COLORS.holoBase
            const canOpen = Boolean(onOpenFile && file.path.startsWith('/'))
            const displayPath = truncatePath(file.path)
            const usage = fileUsage(file)
            const hasTokens = file.totalTokens > 0
            // Nothing counted and nothing missing: a dash. Nothing counted but a call gave no figure: unknown, not 0.
            const tokenSpoken = hasTokens ? qualify(usage, formatTokens(file.totalTokens)) : file.tokensPartial ? 'tokens not reported' : null
            const tokenMark = hasTokens ? `${file.tokensPartial ? '≥' : ''}${file.tokensEstimated ? '~' : ''}` : ''
            const tokenLabel = tokenSpoken ? (hasTokens ? `${tokenSpoken} tokens` : tokenSpoken) : '— tokens'
            const conflicted = inConflict.has(conflictPath(file.path) ?? '')
            const headerInner = (
              <>
                <span className="text-[11px] font-mono truncate min-w-0 flex-1 text-left" style={{ color: heatColor }}>
                  {displayPath}
                </span>
                <span className="text-[11px] font-mono shrink-0" style={{ color: COLORS.textMuted }}>
                  {tokenSpoken === null ? '—' : hasTokens ? (
                    <>
                      <span aria-hidden="true">{`${tokenMark}${formatTokens(file.totalTokens)}`}</span>
                      <span className="sr-only">{tokenLabel}</span>
                    </>
                  ) : (
                    <><span className="sr-only">tokens </span><span>not reported</span></>
                  )}
                </span>
              </>
            )

            return (
              <li
                key={file.path}
                className="rounded px-2 py-1.5 motion-safe:transition-colors"
                style={{
                  background: COLORS.fileCardBg,
                  border: `1px solid ${canOpen ? heatColor + '30' : heatColor + '15'}`,
                }}
              >
                {/* Filename */}
                {canOpen ? (
                  <button
                    type="button"
                    onClick={() => onOpenFile?.(file.path)}
                    title={file.path}
                    aria-label={`Open ${file.path}, ${tokenLabel}${conflicted ? ', conflict' : ''}`}
                    className={`flex items-center justify-between gap-2 w-full min-h-6 rounded hover:brightness-125 ${FOCUS_RING_INSET}`}
                  >
                    {headerInner}
                  </button>
                ) : (
                  <div className="flex items-center justify-between gap-2 min-h-6" title={file.path}>
                    {headerInner}
                  </div>
                )}

                <div className="mt-1">
                  <ProgressBar percent={heatRatio * 100} color={heatColor} trackColor={COLORS.holoBg05} />
                </div>

                {/* Stats row */}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1">
                  {file.reads > 0 && (
                    <span className="text-[11px] font-mono" style={{ color: COLORS.filePathActive }}>
                      {file.reads} read{file.reads > 1 ? 's' : ''}{succeededNote(file.reads, file.readers)}
                    </span>
                  )}
                  {file.edits > 0 && (
                    <span className="text-[11px] font-mono" style={{ color: COLORS.tool }}>
                      {file.edits} edit{file.edits > 1 ? 's' : ''}{succeededNote(file.edits, file.editors)}
                    </span>
                  )}
                  {conflicted && (
                    <span className="text-[11px] font-mono font-semibold" style={{ color: COLORS.error }}>conflict</span>
                  )}
                  {file.agents.length > 0 && (
                    <span className="text-[11px] font-mono" style={{ color: COLORS.textMuted }}
                      title={file.agents.join(', ')}
                    >
                      {file.agents.length} agent{file.agents.length > 1 ? 's' : ''}
                    </span>
                  )}
                </div>
                {file.timeline && fileStepTotal(file.timeline) > 0 && (
                  <FileTimelineDetails path={file.path} timeline={file.timeline} label={label} incomplete={replayLost > 0} />
                )}
              </li>
            )
          })}
          </ul>
        </div>

        {/* Summary */}
        {files.length > 0 && (
          <div className="mt-2 pt-2 flex justify-between text-[11px] font-mono" style={{
            borderTop: `1px solid ${COLORS.holoBorder08}`,
            color: COLORS.textMuted,
          }}>
            <span>{boundedCount(files.length, replayLost, 'file')}</span>
            <span>{formatTokenUsage(combineUsage(files.map(fileUsage)))} tokens in file reads</span>
          </div>
        )}
      </div>
    </SlidingPanel>
  )
}
