'use client'

import { useId } from 'react'
import { POPUP, type ToolCallState, type ToolCallNode } from '@/lib/agent-types'
import { COLORS, themed } from '@/lib/colors'
import { parseMcpTool, formatToolName } from '@/lib/mcp-tool'
import { TOOL_STATE_LABELS, toolEndWarning } from '@/lib/tool-lifecycle'
import { USAGE_LABELS } from '@/lib/usage'
import { ToolContentRenderer } from './tool-content-renderer'
import { PanelHeader, DetailPopup } from './shared-ui'
import { AnsiText } from './transcript-message'
import { parseAnsi } from '@/lib/ansi'

interface ToolDetailPopupProps {
  tool: {
    id: string
    toolName: string
    state: ToolCallState
    args: string
    result?: string
    tokenCost?: number | null
    tokenSource?: ToolCallNode['tokenSource']
    endObserved?: boolean
    inputData?: Record<string, unknown>
  }
  position: { x: number; y: number }
  onClose: () => void
}

const STATE_DISPLAY: Record<ToolCallState, { color: string; icon: string; label: string }> = themed(() => ({
  running: { color: COLORS.tool_calling, icon: '⚙', label: TOOL_STATE_LABELS.running },
  complete: { color: COLORS.complete, icon: '✓', label: TOOL_STATE_LABELS.complete },
  error: { color: COLORS.error, icon: '✕', label: TOOL_STATE_LABELS.error },
  cancelled: { color: COLORS.textMuted, icon: '⊘', label: TOOL_STATE_LABELS.cancelled },
  expired: { color: COLORS.tool_calling, icon: '⧖', label: TOOL_STATE_LABELS.expired },
}))

export function ToolDetailPopup({ tool, position, onClose }: ToolDetailPopupProps) {
  const titleId = useId()
  const { color: stateColor, icon: stateIcon, label: stateLabel } = STATE_DISPLAY[tool.state] ?? STATE_DISPLAY.complete
  const warning = toolEndWarning(tool)

  return (
    <DetailPopup position={position} width={POPUP.tool.width} estimatedHeight={POPUP.tool.estimatedHeight} onClose={onClose} titleId={titleId}>
      <PanelHeader onClose={onClose} titleId={titleId}>
        <span className="text-[11px]" style={{ color: stateColor }} aria-hidden="true">
          {stateIcon}
        </span>
        <span className="text-xs font-mono font-semibold" style={{ color: parseMcpTool(tool.toolName) ? COLORS.mcp : COLORS.tool_calling }}>
          {parseMcpTool(tool.toolName) && <span className="mr-1 uppercase tracking-wide opacity-80">MCP</span>}
          {formatToolName(tool.toolName)}
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

      {/* The outcome rests on an end nobody saw: say so before anything else */}
      {warning && (
        <div role="note" className="mt-2 rounded px-2 py-1 text-[11px] font-mono" style={{ color: COLORS.tool_calling, border: `1px solid ${COLORS.tool_calling}` }}>
          {warning}
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
          <span className="opacity-70 mr-1">{tool.endObserved === false ? 'Reported result (unconfirmed):' : 'Result:'}</span>
          {tool.toolName === 'Bash' ? <AnsiText segments={parseAnsi(tool.result)} /> : tool.result}
        </div>
      )}

      {/* Token cost */}
      {tool.state !== 'running' && (
        <div className="mt-1.5 text-[11px] font-mono" style={{ color: COLORS.textMuted }}>
          {tool.tokenCost == null
            ? `tokens ${USAGE_LABELS.unavailable}`
            : `${tool.tokenCost} tokens${tool.tokenSource === 'estimated' ? ` ${USAGE_LABELS.estimated}` : ''}`}
        </div>
      )}
    </DetailPopup>
  )
}
