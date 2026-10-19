'use client'

import { FileAttention, Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { formatTokens, truncatePath } from '@/lib/utils'
import { PanelHeader, ProgressBar, SlidingPanel, DockResizer, useDockPanel, dockAttrs, dockPanelDomId } from './shared-ui'
import { useLocale } from '@/lib/locale'
import { translate, type Locale } from '@/lib/messages'
import { panelName } from '@/lib/command-palette'
import { fileStepTotal, type FileTimeline } from '@/lib/file-timeline'
import { combineUsage, type UsageTotal } from '@/lib/usage'
import { DATA_EN, t as tr, pluralText, tokensSpoken, conflictHeadingText, conflictEditorsText, boundedFilesText, lostSentence, succeededNoteText, fileTimelineText } from '@/lib/panel-text'
import { FOCUS_RING_INSET } from '@/lib/focus-ring'
import { deriveFileConflicts, conflictPath, conflictPathSet } from '@/lib/file-conflicts'
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
 * The observed steps of one file (#385), oldest first, in a native disclosure: each step says its kind in words,
 * its agent and its call id. Steps past the cap are counted; commits are never shown.
 */
function FileTimelineDetails({ path, timeline, label, incomplete, locale }: {
  path: string
  timeline: FileTimeline
  label: (agentKey: string) => string
  incomplete: boolean
  locale: Locale
}) {
  const L = fileTimelineText(locale)
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
            {' '}{L.by(label(s.agentId))}
            <span style={{ color: COLORS.textMuted }}>{' · '}{s.toolUseId ? <span className="break-all">{L.call(s.toolUseId)}</span> : L.noCallId}</span>
          </li>
        ))}
      </ol>
      <p className="m-0 mt-0.5" style={{ color: COLORS.textMuted }}>{L.noCommits}</p>
    </details>
  )
}

export function FileAttentionPanel({ visible, fileAttention, onClose, onOpenFile, agentLabel, waste = EMPTY_WASTE, agents, replayLost = 0 }: FileAttentionPanelProps) {
  const { locale } = useLocale()
  const t = (key: Parameters<typeof tr>[1], params?: Parameters<typeof tr>[2]) => tr(locale, key, params)
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
      label={panelName(locale, 'files')}
      labelLang={locale}
      style={dock.hidden ? { display: 'none' } : undefined}
    >
      <DockResizer label={t('files.resize')} valueText={px => t('sessions.resize.value', { px })} controls={dockPanelDomId('files')} />
      <div lang={locale} className="glass-card relative flex flex-col" style={{ maxHeight: rect?.h }}>
        <PanelHeader onClose={onClose} closeLabel={t('common.close')}>
          <span lang={locale} className="text-[11px] font-mono tracking-wider" style={{ color: COLORS.textPrimary }}>
            {translate(locale, 'panel.heading.files')}
          </span>
        </PanelHeader>

        {/* File list */}
        <div
          role="region"
          aria-label={t('files.region')}
          tabIndex={0}
          className={`min-h-0 flex-1 overflow-y-auto ${FOCUS_RING_INSET}`}
        >
          <WasteSection waste={waste} agents={agents} onOpenFile={onOpenFile} replayLost={replayLost} />
          {files.length === 0 && (
            <div className="text-[11px] font-mono py-2 text-center" style={{ color: COLORS.textMuted }}>
              {replayLost > 0 ? t('files.emptyIncomplete') : t('files.empty')}
            </div>
          )}
          {conflicts.length === 0 && replayLost > 0 && (
            <p data-testid="file-conflicts-incomplete" className="m-0 mb-2 text-[11px] font-mono" style={{ color: COLORS.textMuted }}>
              {t('files.conflicts.lostLine', { heading: conflictHeadingText(locale, 0, replayLost) ?? '', sentence: lostSentence(locale, replayLost) })}
            </p>
          )}
          {conflicts.length > 0 && (
            <div className="mb-2">
              <h3 id="file-conflicts-heading" className="text-[11px] font-mono font-semibold mb-1" style={{ color: COLORS.error }}>
                {t('files.conflicts.heading', { heading: conflictHeadingText(locale, conflicts.length, replayLost) ?? '' })}
              </h3>
              <ul aria-label={t('files.conflicts.list')} className="space-y-1 list-none p-0 m-0">
                {conflicts.map(c => {
                  const who = conflictEditorsText(locale, c, label)
                  return (
                    <li key={c.path} className="rounded px-2 py-1.5 text-[11px] font-mono" style={{ background: COLORS.fileCardBg, border: `1px solid ${COLORS.error}40` }}>
                      {onOpenFile ? (
                        <button
                          type="button"
                          onClick={() => onOpenFile(c.path)}
                          title={c.path}
                          aria-label={t('files.conflicts.openAria', { path: c.path, who })}
                          className={`block w-full min-h-6 truncate rounded text-left hover:brightness-125 ${FOCUS_RING_INSET}`}
                          style={{ color: COLORS.textPrimary }}
                        >
                          <span {...DATA_EN}>{truncatePath(c.path)}</span>
                        </button>
                      ) : (
                        <div className="truncate" title={c.path} style={{ color: COLORS.textPrimary }}><span {...DATA_EN}>{c.path}</span></div>
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
            const tokenSpoken = hasTokens ? tokensSpoken(locale, usage) : file.tokensPartial ? t('tok.unavailable') : null
            const tokenMark = hasTokens ? `${file.tokensPartial ? '≥' : ''}${file.tokensEstimated ? '~' : ''}` : ''
            const tokenLabel = tokenSpoken ?? t('tok.none')
            const conflicted = inConflict.has(conflictPath(file.path) ?? '')
            const headerInner = (
              <>
                <span {...DATA_EN} className="text-[11px] font-mono truncate min-w-0 flex-1 text-left" style={{ color: heatColor }}>
                  {displayPath}
                </span>
                <span className="text-[11px] font-mono shrink-0" style={{ color: COLORS.textMuted }}>
                  {tokenSpoken === null ? '—' : hasTokens ? (
                    <>
                      <span aria-hidden="true">{`${tokenMark}${formatTokens(file.totalTokens)}`}</span>
                      <span className="sr-only">{tokenLabel}</span>
                    </>
                  ) : (
                    <><span className="sr-only">{t('tok.word')} </span><span>{tr(locale, 'usage.unavailable')}</span></>
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
                    aria-label={conflicted ? t('files.openTokensConflict', { path: file.path, tokens: tokenLabel }) : t('files.openTokens', { path: file.path, tokens: tokenLabel })}
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
                      {pluralText(locale, 'files.reads', file.reads)}{succeededNoteText(locale, file.reads, file.readers)}
                    </span>
                  )}
                  {file.edits > 0 && (
                    <span className="text-[11px] font-mono" style={{ color: COLORS.tool }}>
                      {pluralText(locale, 'files.edits', file.edits)}{succeededNoteText(locale, file.edits, file.editors)}
                    </span>
                  )}
                  {conflicted && (
                    <span className="text-[11px] font-mono font-semibold" style={{ color: COLORS.error }}>{t('files.conflict')}</span>
                  )}
                  {file.agents.length > 0 && (
                    <span className="text-[11px] font-mono" style={{ color: COLORS.textMuted }}
                      title={file.agents.join(', ')}
                    >
                      {pluralText(locale, 'count.agent', file.agents.length)}
                    </span>
                  )}
                </div>
                {file.timeline && fileStepTotal(file.timeline) > 0 && (
                  <FileTimelineDetails path={file.path} timeline={file.timeline} label={label} incomplete={replayLost > 0} locale={locale} />
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
            <span>{boundedFilesText(locale, files.length, replayLost)}</span>
            <span>{t('files.summary.tokens', { tokens: tokensSpoken(locale, combineUsage(files.map(fileUsage))) })}</span>
          </div>
        )}
      </div>
    </SlidingPanel>
  )
}
