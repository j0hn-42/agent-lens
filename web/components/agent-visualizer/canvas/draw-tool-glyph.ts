import type { ToolGlyph } from '@/lib/action-summary'

/** Width reserved on the left of a tool card for its glyph (world units) */
export const GLYPH_SLOT = 18

/**
 * Pictogram of an action, drawn in a `size` box centred on (cx, cy). The shape carries the meaning
 * (the label stays as text); motion only runs while the call is running and never under reduced motion.
 */
export function drawToolGlyph(
  ctx: CanvasRenderingContext2D,
  glyph: ToolGlyph,
  cx: number,
  cy: number,
  size: number,
  color: string,
  time: number,
  running: boolean,
  reducedMotion: boolean,
) {
  const s = size
  const animate = running && !reducedMotion
  ctx.save()
  ctx.translate(cx, cy)
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = 1.3
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  switch (glyph) {
    case 'read':
    case 'write': {
      // Page with a folded corner; Write adds a plus
      const w = s * 0.7
      const h = s
      ctx.moveTo(-w / 2, -h / 2)
      ctx.lineTo(w / 2 - s * 0.22, -h / 2)
      ctx.lineTo(w / 2, -h / 2 + s * 0.22)
      ctx.lineTo(w / 2, h / 2)
      ctx.lineTo(-w / 2, h / 2)
      ctx.closePath()
      if (glyph === 'read') {
        ctx.moveTo(-w / 4, -s * 0.05)
        ctx.lineTo(w / 4, -s * 0.05)
        ctx.moveTo(-w / 4, s * 0.2)
        ctx.lineTo(w / 4, s * 0.2)
      } else {
        ctx.moveTo(-s * 0.18, s * 0.1)
        ctx.lineTo(s * 0.18, s * 0.1)
        ctx.moveTo(0, -s * 0.08)
        ctx.lineTo(0, s * 0.28)
      }
      break
    }
    case 'search': {
      // Magnifier; the lens sweeps while the search runs
      const dx = animate ? Math.sin(time * 3) * s * 0.08 : 0
      ctx.arc(-s * 0.1 + dx, -s * 0.1, s * 0.3, 0, Math.PI * 2)
      ctx.moveTo(s * 0.12 + dx, s * 0.12)
      ctx.lineTo(s * 0.42, s * 0.42)
      break
    }
    case 'edit': {
      // Pencil on a diagonal with a tip
      ctx.moveTo(s * 0.4, -s * 0.4)
      ctx.lineTo(-s * 0.3, s * 0.3)
      ctx.lineTo(-s * 0.42, s * 0.42)
      ctx.lineTo(-s * 0.3, s * 0.3)
      ctx.moveTo(s * 0.2, -s * 0.5)
      ctx.lineTo(s * 0.5, -s * 0.2)
      break
    }
    case 'shell': {
      // Prompt chevron and a cursor that blinks while the command runs
      ctx.moveTo(-s * 0.45, -s * 0.3)
      ctx.lineTo(-s * 0.1, 0)
      ctx.lineTo(-s * 0.45, s * 0.3)
      if (!animate || Math.floor(time * 2) % 2 === 0) {
        ctx.moveTo(s * 0.05, s * 0.3)
        ctx.lineTo(s * 0.45, s * 0.3)
      }
      break
    }
    case 'git': {
      // Commit graph: a node on a line, the node breathes while running
      const r = s * 0.22 + (animate ? Math.sin(time * 5) * s * 0.06 : 0)
      ctx.moveTo(0, -s * 0.5)
      ctx.lineTo(0, -r)
      ctx.moveTo(0, r)
      ctx.lineTo(0, s * 0.5)
      ctx.moveTo(r, 0)
      ctx.arc(0, 0, r, 0, Math.PI * 2)
      break
    }
    case 'gh': {
      // Rounded square with a node
      ctx.roundRect(-s * 0.45, -s * 0.45, s * 0.9, s * 0.9, s * 0.25)
      ctx.moveTo(s * 0.16, 0)
      ctx.arc(0, 0, s * 0.16, 0, Math.PI * 2)
      break
    }
    case 'todo': {
      // Checklist: two rows, a ticked box and an empty one
      ctx.rect(-s * 0.45, -s * 0.42, s * 0.28, s * 0.28)
      ctx.moveTo(-s * 0.4, -s * 0.28)
      ctx.lineTo(-s * 0.32, -s * 0.2)
      ctx.lineTo(-s * 0.22, -s * 0.36)
      ctx.moveTo(0, -s * 0.28)
      ctx.lineTo(s * 0.45, -s * 0.28)
      ctx.rect(-s * 0.45, s * 0.14, s * 0.28, s * 0.28)
      ctx.moveTo(0, s * 0.28)
      ctx.lineTo(s * 0.45, s * 0.28)
      break
    }
    case 'web': {
      // Globe; the meridian turns while the request runs
      const rx = animate ? Math.abs(Math.cos(time * 2)) * s * 0.28 + s * 0.06 : s * 0.22
      ctx.arc(0, 0, s * 0.5, 0, Math.PI * 2)
      ctx.moveTo(-s * 0.5, 0)
      ctx.lineTo(s * 0.5, 0)
      ctx.moveTo(rx, 0)
      ctx.ellipse(0, 0, rx, s * 0.5, 0, 0, Math.PI * 2)
      break
    }
    case 'ask': {
      // Speech bubble with a question mark; it swells while an answer is awaited
      const k = animate ? 1 + Math.sin(time * 4) * 0.1 : 1
      ctx.scale(k, k)
      ctx.roundRect(-s * 0.5, -s * 0.5, s, s * 0.75, s * 0.2)
      ctx.moveTo(-s * 0.2, s * 0.25)
      ctx.lineTo(-s * 0.3, s * 0.5)
      ctx.lineTo(0, s * 0.25)
      ctx.moveTo(-s * 0.12, -s * 0.28)
      ctx.quadraticCurveTo(0, -s * 0.4, s * 0.12, -s * 0.28)
      ctx.quadraticCurveTo(s * 0.12, -s * 0.12, 0, -s * 0.06)
      ctx.moveTo(0, s * 0.08)
      ctx.lineTo(0, s * 0.1)
      break
    }
    case 'task': {
      // Fork: a line that splits to two nodes; a dot travels down the branch while the sub-agent runs
      ctx.moveTo(0, -s * 0.5)
      ctx.lineTo(0, -s * 0.1)
      ctx.lineTo(-s * 0.32, s * 0.2)
      ctx.moveTo(0, -s * 0.1)
      ctx.lineTo(s * 0.32, s * 0.2)
      ctx.moveTo(-s * 0.2, s * 0.35)
      ctx.arc(-s * 0.32, s * 0.35, s * 0.15, 0, Math.PI * 2)
      ctx.moveTo(s * 0.47, s * 0.35)
      ctx.arc(s * 0.32, s * 0.35, s * 0.15, 0, Math.PI * 2)
      if (animate) {
        const t = (time * 1.2) % 1
        ctx.moveTo(s * 0.06, -s * 0.5 + t * s * 0.6)
        ctx.arc(0, -s * 0.5 + t * s * 0.6, s * 0.06, 0, Math.PI * 2)
      }
      break
    }
    case 'notebook': {
      // Notebook: a page with binding rings on its left edge and ruled lines
      ctx.rect(-s * 0.4, -s * 0.5, s * 0.8, s)
      for (const y of [-0.3, 0, 0.3]) {
        ctx.moveTo(-s * 0.52, y * s)
        ctx.lineTo(-s * 0.28, y * s)
        ctx.moveTo(-s * 0.1, y * s)
        ctx.lineTo(s * 0.28, y * s)
      }
      break
    }
    case 'python': {
      // Snake: an S that crawls while the script runs
      ctx.moveTo(s * 0.4, -s * 0.35)
      ctx.bezierCurveTo(-s * 0.5, -s * 0.55, -s * 0.5, 0, 0, 0)
      ctx.bezierCurveTo(s * 0.5, 0, s * 0.5, s * 0.55, -s * 0.4, s * 0.35)
      if (animate) {
        ctx.setLineDash([s * 0.3, s * 0.15])
        ctx.lineDashOffset = -time * s * 0.8
      }
      break
    }
    case 'test': {
      // Flask; bubbles rise while the tests run
      ctx.moveTo(-s * 0.15, -s * 0.5)
      ctx.lineTo(-s * 0.15, -s * 0.1)
      ctx.lineTo(-s * 0.45, s * 0.4)
      ctx.lineTo(s * 0.45, s * 0.4)
      ctx.lineTo(s * 0.15, -s * 0.1)
      ctx.lineTo(s * 0.15, -s * 0.5)
      ctx.moveTo(-s * 0.25, -s * 0.5)
      ctx.lineTo(s * 0.25, -s * 0.5)
      if (animate) {
        const y = s * 0.3 - ((time * 0.8) % 1) * s * 0.5
        ctx.moveTo(s * 0.06, y)
        ctx.arc(0, y, s * 0.06, 0, Math.PI * 2)
      }
      break
    }
    case 'docker': {
      // Stacked containers on a hull line
      for (const [x, y] of [[-0.45, 0], [-0.15, 0], [0.15, 0], [-0.15, -0.3]]) ctx.rect(x * s, y * s - s * 0.1, s * 0.27, s * 0.25)
      ctx.moveTo(-s * 0.5, s * 0.3)
      ctx.quadraticCurveTo(0, s * 0.55, s * 0.5, s * 0.3)
      break
    }
    case 'package': {
      // Parcel: a cube seen from the front with a strap
      ctx.rect(-s * 0.45, -s * 0.4, s * 0.9, s * 0.8)
      ctx.moveTo(0, -s * 0.4)
      ctx.lineTo(0, s * 0.4)
      ctx.moveTo(-s * 0.45, -s * 0.1)
      ctx.lineTo(s * 0.45, -s * 0.1)
      break
    }
  }
  ctx.stroke()
  ctx.restore()
}
