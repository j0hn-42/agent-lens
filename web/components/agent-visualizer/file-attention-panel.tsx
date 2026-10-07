'use client'

import { FileAttention, Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { formatTokens, truncatePath, pluralize } from '@/lib/utils'
import { PanelHeader, ProgressBar, SlidingPanel, DockResizer, useDockPanel, dockAttrs } from './shared-ui'
import { FOCUS_RING } from '@/lib/feed-utils'

interface FileAttentionPanelProps {
  visible: boolean
  fileAttention: Map<string, FileAttention>
  onClose: () => void
  onOpenFile?: (filePath: string) => void
}

export function FileAttentionPanel({ visible, fileAttention, onClose, onOpenFile }: FileAttentionPanelProps) {
  // Right dock (resizable): placed by the shared layout, below the link panel, above the control bar
  const dock = useDockPanel('files', visible)
  const { rect } = dock
  if (!visible) return null

  const files = Array.from(fileAttention.values())
    .sort((a, b) => b.totalTokens - a.totalTokens)

  const maxTokens = Math.max(...files.map(f => f.totalTokens), 1)

  return (
    <SlidingPanel
      visible={visible}
      position={rect ? { top: rect.y, left: rect.x } : { top: 'calc(var(--topbar-h, 60px) + 8px)', right: 12 }}
      zIndex={Z.sidePanel}
      width={rect?.w ?? 380}
      attrs={dockAttrs('files', 'right', dock)}
      style={dock.hidden ? { display: 'none' } : undefined}
    >
      <DockResizer label="Resize files panel" />
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
              No files yet
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
                  background: `rgba(10, 15, 30, 0.5)`,
                  border: `1px solid ${canOpen ? heatColor + '30' : heatColor + '15'}`,
                }}
              >
                {/* Filename */}
                {canOpen ? (
                  <button
                    type="button"
                    onClick={() => onOpenFile?.(file.path)}
                    title={file.path}
                    aria-label={`Open ${file.path}, ${tokenText} tokens`}
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
