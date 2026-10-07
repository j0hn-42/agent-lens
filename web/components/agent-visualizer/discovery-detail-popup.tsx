'use client'

import { useId } from 'react'
import { POPUP } from '@/lib/agent-types'
import { COLORS, getDiscoveryTypeColor } from '@/lib/colors'
import { PanelHeader, DetailPopup } from './shared-ui'

interface DiscoveryDetailPopupProps {
  /** Display name of the discovering agent; falls back to the raw id */
  agentName?: string
  discovery: {
    id: string
    type: string
    label: string
    content: string
    agentId: string
  }
  position: { x: number; y: number }
  onClose: () => void
}

export function DiscoveryDetailPopup({ discovery, agentName, position, onClose }: DiscoveryDetailPopupProps) {
  const titleId = useId()
  const typeColor = getDiscoveryTypeColor(discovery.type)

  const typeLabel =
    discovery.type === 'file' ? 'FILE' :
    discovery.type === 'pattern' ? 'PATTERN' :
    discovery.type === 'finding' ? 'FINDING' : 'CODE'

  return (
    <DetailPopup position={position} width={POPUP.discovery.width} estimatedHeight={POPUP.discovery.estimatedHeight} onClose={onClose} titleId={titleId}>
      <PanelHeader onClose={onClose} titleId={titleId}>
        <span
          className="text-[11px] font-mono font-bold px-1.5 py-0.5 rounded"
          style={{ background: typeColor + '20', color: typeColor, border: `1px solid ${typeColor}30` }}
        >
          {typeLabel}
        </span>
      </PanelHeader>

      {/* Label */}
      <div
        className="text-xs font-mono font-semibold mb-2"
        style={{ color: typeColor, wordBreak: 'break-all' }}
      >
        {discovery.label}
      </div>

      {/* Content */}
      {discovery.content && (
        <div
          role="region"
          aria-label="Discovery content"
          tabIndex={0}
          className="rounded px-2 py-1.5 text-xs font-mono whitespace-pre-wrap break-words"
          style={{
            background: COLORS.holoBg03,
            border: `1px solid ${COLORS.holoBorder08}`,
            color: COLORS.textPrimary,
            maxHeight: 120,
            overflow: 'auto',
          }}
        >
          {discovery.content}
        </div>
      )}

      {/* Agent attribution */}
      <div className="mt-1.5 text-[11px] font-mono" style={{ color: COLORS.textMuted }}>
        agent: {agentName ?? discovery.agentId}
      </div>
    </DetailPopup>
  )
}
