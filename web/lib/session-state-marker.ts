import type { CSSProperties } from 'react'

/**
 * Shape of the agent state marker in the Sessions panel (#381): one shape per state, so the marker never relies on its
 * colour, or on the pulse (gone under prefers-reduced-motion), to tell two states apart (WCAG 1.4.1). The row also says
 * the state in words. Waiting for permission is a dashed ring, as on the canvas (docs/reading-the-ui.md).
 */
const STATE_MARKER_SHAPE = {
  idle: 'ring',
  thinking: 'disc',
  tool_calling: 'square',
  waiting_permission: 'dashed-ring',
  paused: 'bars',
  complete: 'check',
  error: 'cross',
} as const satisfies Readonly<Record<string, string>>

type StateMarkerShape = (typeof STATE_MARKER_SHAPE)[keyof typeof STATE_MARKER_SHAPE]

export function stateMarkerShape(state: string): StateMarkerShape {
  return STATE_MARKER_SHAPE[state as keyof typeof STATE_MARKER_SHAPE] ?? STATE_MARKER_SHAPE.idle
}

/**
 * Box of a non-glyph marker, inside the 12 px slot of the ✓ / ✕ glyphs, never rotated (a rotated box spills over).
 * Two shapes never differ only by their corners: the 8 px ring and disc differ by fill, the square is 10 px and filled,
 * the dashed ring is 10 px and hollow, the pause bars have only a left and a right edge. Size and margins are classes,
 * the colour and the outline inline.
 */
export function stateMarkerBox(shape: Exclude<StateMarkerShape, 'check' | 'cross'>, color: string): { className: string; style: CSSProperties } {
  const className = shape === 'square' || shape === 'dashed-ring' ? 'w-2.5 h-2.5 mx-px' : 'w-2 h-2 mx-0.5'
  switch (shape) {
    case 'bars': return { className, style: { borderLeft: `3px solid ${color}`, borderRight: `3px solid ${color}` } }
    case 'ring': return { className, style: { borderRadius: '50%', background: 'transparent', border: `2px solid ${color}` } }
    case 'disc': return { className, style: { borderRadius: '50%', background: color, border: `2px solid ${color}` } }
    case 'square': return { className, style: { background: color, border: `2px solid ${color}` } }
    case 'dashed-ring': return { className, style: { borderRadius: '50%', background: 'transparent', border: `2px dashed ${color}` } }
  }
}
