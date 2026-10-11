'use client'

import { FileAttention, Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { formatTokens, truncatePath, pluralize } from '@/lib/utils'
import { PanelHeader, ProgressBar, SlidingPanel, DockResizer, useDockPanel, dockAttrs, dockPanelDomId } from './shared-ui'
import { emptyState } from '@/lib/ui-glossary'
import { FOCUS_RING } from '@/lib/feed-utils'
import { deriveFileConflicts, conflictPath, conflictPathSet, describeConflictEditors } from '@/lib/file-conflicts'

interface FileAttentionPanelProps {
  visible: boolean
  fileAttention: Map<string, FileAttention>
  onClose: () => void
  onOpenFile?: (filePath: string) => void
  /** Readable name of an agent key ("alpha (session Main)"); the key itself when absent */
  agentLabel?: (agentKey: string) => string
}

export function FileAttentionPanel({ visible, fileAttention, onClose, onOpenFile, agentLabel }: FileAttentionPanelProps) {
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
      attrs={dockAttrs('files', 'right', dock)}
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
          className={`min-h-0 flex-1 overflow-y-auto ${FOCUS_RING}`}
        >
          {files.length === 0 && (
            <div className="text-[11px] font-mono py-2 text-center" style={{ color: COLORS.textMuted }}>
              {emptyState('files')}
            </div>
          )}
          {conflicts.length > 0 && (
            <div className="mb-2">
              <h3 id="file-conflicts-heading" className="text-[11px] font-mono font-semibold mb-1" style={{ color: COLORS.error }}>
                {pluralize(conflicts.length, 'conflict')}: files edited by several agents
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
                          className={`block w-full min-h-6 truncate rounded text-left hover:brightness-125 ${FOCUS_RING}`}
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
            const heatColor = heatRatio > 0.7 ? COLORS.error :
              heatRatio > 0.4 ? COLORS.tool :
                COLORS.holoBase
            const canOpen = Boolean(onOpenFile && file.path.startsWith('/'))
            const displayPath = truncatePath(file.path)
            const tokenText = file.totalTokens > 0 ? formatTokens(file.totalTokens) : '—'
            const conflicted = inConflict.has(conflictPath(file.path) ?? '')
            const headerInner = (
              <>
                <span className="text-[11px] font-mono truncate min-w-0 flex-1 text-left" style={{ color: heatColor }}>
                  {displayPath}
                </span>
                <span className="text-[11px] font-mono shrink-0" style={{ color: COLORS.textMuted }}>
                  {tokenText}
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
                    aria-label={`Open ${file.path}, ${tokenText} tokens${conflicted ? ', conflict' : ''}`}
                    className={`flex items-center justify-between gap-2 w-full min-h-6 rounded hover:brightness-125 ${FOCUS_RING}`}
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
                <div className="flex items-center gap-2 mt-1">
                  {file.reads > 0 && (
                    <span className="text-[11px] font-mono" style={{ color: COLORS.filePathActive }}>
                      {file.reads} read{file.reads > 1 ? 's' : ''}
                    </span>
                  )}
                  {file.edits > 0 && (
                    <span className="text-[11px] font-mono" style={{ color: COLORS.tool }}>
                      {file.edits} edit{file.edits > 1 ? 's' : ''}
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
            <span>{pluralize(files.length, 'file')}</span>
            <span>{formatTokens(files.reduce((s, f) => s + f.totalTokens, 0))} tokens in file reads</span>
          </div>
        )}
      </div>
    </SlidingPanel>
  )
}
