'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { COLORS, getDiscoveryTypeColor } from '@/lib/colors'
import { STATE_LABEL_SHORT, STATE_LABEL_LONG, LEGEND_OPEN_KEY } from '@/lib/canvas-constants'
import type { AgentState } from '@/lib/agent-types'
import { stateColor, CLAUDE_SPARK_D, OPENAI_LOGO_D } from './canvas/draw-misc'

const STATES: AgentState[] = ['idle', 'thinking', 'tool_calling', 'waiting_permission', 'error', 'paused', 'complete']

const CONTEXT_SEGMENTS: Array<{ label: string; color: string }> = [
  { label: 'System prompt', color: COLORS.contextSystem },
  { label: 'User messages', color: COLORS.contextUser },
  { label: 'Tool results', color: COLORS.contextToolResults },
  { label: 'Reasoning', color: COLORS.contextReasoning },
  { label: 'Sub-agent results', color: COLORS.contextSubagent },
]

const DISCOVERY_TYPES: Array<{ type: string; label: string }> = [
  { type: 'file', label: 'File' },
  { type: 'pattern', label: 'Pattern' },
  { type: 'finding', label: 'Finding' },
  { type: 'code', label: 'Code' },
]

function hexPoints(r: number, cx: number, cy: number): string {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 2
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`
  }).join(' ')
}

function Row({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2 min-h-5">
      <span className="flex w-7 shrink-0 items-center justify-center" aria-hidden="true">{icon}</span>
      <span>{children}</span>
    </li>
  )
}

function Heading({ children }: { children: ReactNode }) {
  return <h3 className="mt-2 mb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: COLORS.textMuted }}>{children}</h3>
}

function Swatch({ color, round }: { color: string; round?: boolean }) {
  return <span className={`inline-block h-3 w-3 ${round ? 'rounded-full' : 'rounded-sm'}`} style={{ background: color }} />
}

/**
 * Collapsible legend of everything the canvas encodes: states, shapes, edges,
 * context segments, discovery types and runtimes. Lives in the DOM (not the canvas)
 * so it is readable at any zoom and by assistive technology (WCAG 1.4.1, 1.3.3).
 */
export function GraphLegend() {
  const [open, setOpen] = useState(false)

  // Restore the preference after mount (keeps server and first client render identical)
  useEffect(() => {
    try {
      if (window.localStorage.getItem(LEGEND_OPEN_KEY) === '1') setOpen(true)
    } catch { /* storage unavailable (private window, blocked data) */ }
  }, [])

  const toggle = () => {
    setOpen(prev => {
      const next = !prev
      try { window.localStorage.setItem(LEGEND_OPEN_KEY, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }

  return (
    <div
      className="absolute left-3 bottom-20 z-10 max-w-[calc(100vw-24px)] font-mono text-xs"
      style={{ color: COLORS.textPrimary }}
    >
      {open && (
        <div
          id="graph-legend-panel"
          role="region"
          aria-label="Graph legend"
          className="mb-1 max-h-[60vh] w-64 max-w-full overflow-y-auto rounded-md p-3"
          style={{ background: COLORS.panelBg, border: `1px solid ${COLORS.glassBorder}` }}
        >
          <Heading>States</Heading>
          <ul>
            {STATES.map(state => (
              <Row key={state} icon={<Swatch color={stateColor(state)} />}>
                <span className="font-semibold">{STATE_LABEL_SHORT[state]}</span>
                {STATE_LABEL_LONG[state] !== STATE_LABEL_SHORT[state] && <span style={{ color: COLORS.textMuted }}> ({STATE_LABEL_LONG[state]})</span>}
              </Row>
            ))}
          </ul>

          <Heading>Shapes</Heading>
          <ul>
            <Row icon={<svg width="24" height="24" viewBox="0 0 24 24"><polygon points={hexPoints(10, 12, 12)} fill="none" stroke={COLORS.holoBase} strokeWidth="1.5" /></svg>}>Large hexagon: main agent</Row>
            <Row icon={<svg width="24" height="24" viewBox="0 0 24 24"><polygon points={hexPoints(7, 12, 12)} fill="none" stroke={COLORS.holoBase} strokeWidth="1.5" /></svg>}>Small hexagon: sub-agent</Row>
            <Row icon={<svg width="24" height="14" viewBox="0 0 24 14"><rect x="1" y="2" width="22" height="10" rx="2" fill="none" stroke={COLORS.tool} strokeWidth="1.5" /></svg>}>Rounded card: tool call</Row>
            <Row icon={<svg width="24" height="14" viewBox="0 0 24 14"><rect x="1" y="2" width="22" height="10" rx="1" fill="none" stroke={COLORS.discoveryFile} strokeWidth="1" /><rect x="1" y="2" width="3" height="10" fill={COLORS.discoveryFile} /></svg>}>Card with colour bar: discovery</Row>
            <Row icon={<svg width="24" height="24" viewBox="0 0 24 24"><polygon points={hexPoints(10, 12, 12)} fill="none" stroke={COLORS.complete} strokeWidth="1.5" strokeDasharray="3 3" /></svg>}>Dashed outline: complete</Row>
          </ul>

          <Heading>Edges and particles</Heading>
          <ul>
            <Row icon={<svg width="24" height="10" viewBox="0 0 24 10"><line x1="1" y1="5" x2="23" y2="5" stroke={COLORS.holoBase} strokeWidth="3" /></svg>}>Thick line: parent to sub-agent</Row>
            <Row icon={<svg width="24" height="10" viewBox="0 0 24 10"><line x1="1" y1="5" x2="23" y2="5" stroke={COLORS.tool} strokeWidth="1.5" /></svg>}>Thin amber line: tool call</Row>
            <Row icon={<Swatch color={COLORS.dispatch} round />}>Purple dot: task dispatched</Row>
            <Row icon={<Swatch color={COLORS.return} round />}>Green dot: result returned</Row>
          </ul>

          <Heading>Context usage</Heading>
          <ul>
            {CONTEXT_SEGMENTS.map(seg => (
              <Row key={seg.label} icon={<Swatch color={seg.color} />}>{seg.label}</Row>
            ))}
          </ul>

          <Heading>Discoveries</Heading>
          <ul>
            {DISCOVERY_TYPES.map(d => (
              <Row key={d.type} icon={<Swatch color={getDiscoveryTypeColor(d.type)} />}>{d.label}</Row>
            ))}
          </ul>

          <Heading>Runtime</Heading>
          <ul>
            <Row icon={<svg width="20" height="20" viewBox="0 0 512 512"><path d={CLAUDE_SPARK_D} fill={COLORS.holoBase} /></svg>}>Spark logo: Claude</Row>
            <Row icon={<svg width="20" height="20" viewBox="0 0 24 24"><path d={OPENAI_LOGO_D} fill={COLORS.holoBase} /></svg>}>Knot logo: Codex</Row>
          </ul>
        </div>
      )}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls="graph-legend-panel"
        className="inline-flex min-h-6 min-w-6 items-center gap-1 rounded-md px-2 py-1 text-[11px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        style={{ background: COLORS.panelBg, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        Legend
      </button>
    </div>
  )
}
