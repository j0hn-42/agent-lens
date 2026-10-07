'use client'

import { useId } from 'react'
import { POPUP } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { ToolContentRenderer } from './tool-content-renderer'
import { PanelHeader, DetailPopup } from './shared-ui'

interface ToolDetailPopupProps {
  tool: {
    id: string
    toolName: string
    state: 'running' | 'complete' | 'error'
    args: string
    result?: string
    tokenCost?: number
    inputData?: Record<string, unknown>
  }
  position: { x: number; y: number }
  onClose: () => void
}

const STATE_DISPLAY = {
  running: { color: COLORS.tool_calling, icon: '⚙', label: 'Running' },
  complete: { color: COLORS.complete, icon: '✓', label: 'Complete' },
  error: { color: COLORS.error, icon: '✕', label: 'Error' },
} as const

export function ToolDetailPopup({ tool, position, onClose }: ToolDetailPopupProps) {
  const titleId = useId()
  const { color: stateColor, icon: stateIcon, label: stateLabel } = STATE_DISPLAY[tool.state] ?? STATE_DISPLAY.complete

  return (
    <DetailPopup position={position} width={POPUP.tool.width} estimatedHeight={POPUP.tool.estimatedHeight} onClose={onClose} titleId={titleId}>
      <PanelHeader onClose={onClose} titleId={titleId}>
        <span className="text-[11px]" style={{ color: stateColor }} aria-hidden="true">
          {stateIcon}
        </span>
        <span className="text-xs font-mono font-semibold" style={{ color: COLORS.tool_calling }}>
          {tool.toolName}
        </span>
        <span className="text-[11px] font-mono" style={{ color: stateColor }}>
          {stateLabel}
        </span>
      </PanelHeader>

      {/* Rich content */}
      {tool.inputData ? (
        <ToolContentRenderer
          toolName={tool.toolName}
          inputData={tool.inputData}
          args={tool.args}
          compact={false}
        />
      ) : (
        <div className="text-xs font-mono" style={{ color: COLORS.textPrimary }}>
          {tool.args}
        </div>
      )}

      {/* Result */}
      {tool.result && (
        <div
          role="region"
          aria-label="Tool result"
          tabIndex={0}
          className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded px-2 py-1 text-xs font-mono"
          style={{
            background: COLORS.resultBg,
            border: `1px solid ${COLORS.resultBorder}`,
            color: COLORS.complete,
          }}
        >
          <span className="opacity-70 mr-1">Result:</span>
          {tool.result}
        </div>
      )}

      {/* Token cost */}
      {tool.tokenCost != null && tool.tokenCost > 0 && (
        <div className="mt-1.5 text-[11px] font-mono" style={{ color: COLORS.textMuted }}>
          {tool.tokenCost} tokens
        </div>
      )}
    </DetailPopup>
  )
}
