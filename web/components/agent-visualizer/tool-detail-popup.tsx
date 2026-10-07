'use client'

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
  const { color: stateColor, icon: stateIcon, label: stateLabel } = STATE_DISPLAY[tool.state] ?? STATE_DISPLAY.complete

  return (
    <DetailPopup position={position} width={POPUP.tool.width} estimatedHeight={POPUP.tool.estimatedHeight} onClose={onClose}>
      <PanelHeader onClose={onClose}>
        <span className="text-[9px]" style={{ color: stateColor }} aria-hidden="true">
          {stateIcon}
        </span>
        <span className="text-[11px] font-mono font-semibold" style={{ color: COLORS.tool_calling }}>
          {tool.toolName}
        </span>
        <span className="text-[9px] font-mono" style={{ color: stateColor + '90' }}>
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
        <div className="text-[10px] font-mono" style={{ color: COLORS.textPrimary + '90' }}>
          {tool.args}
        </div>
      )}

      {/* Result */}
      {tool.result && (
        <div
          className="mt-2 rounded px-2 py-1 text-[9px] font-mono"
          style={{
            background: COLORS.resultBg,
            border: `1px solid ${COLORS.resultBorder}`,
            color: COLORS.complete + '90',
          }}
        >
          <span className="opacity-50 mr-1">Result:</span>
          {tool.result}
        </div>
      )}

      {/* Token cost */}
      {tool.tokenCost != null && tool.tokenCost > 0 && (
        <div className="mt-1.5 text-[9px] font-mono" style={{ color: COLORS.textMuted }}>
          {tool.tokenCost} tokens
        </div>
      )}
    </DetailPopup>
  )
}
