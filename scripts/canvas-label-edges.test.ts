// Agent label against the edges passing under it (#378, group B). The edges and links are drawn before the
// nodes, but the label text only had a thin dark outline, and the session name after the MAIN pill
// ("MAIN payments-api") had none: an edge crossing the block cut the letters. Every text of the label must
// sit on an opaque plate, in the scene background token, drawn after the edges and before the text. No data
// moves nor disappears: the plate only covers what passes under the label.
import './canvas-recorder'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { recordingContext, stubDocument, type DrawnOp } from './canvas-recorder'
import { AGENT_DRAW } from '../web/lib/canvas-constants'
import { SCENE } from '../web/lib/colors'
import { drawAgents } from '../web/components/agent-visualizer/canvas/draw-agents'
import { drawTaperedBezier } from '../web/components/agent-visualizer/canvas/draw-edges'
import { rectsOverlap, type Rect } from '../web/components/agent-visualizer/canvas/label-placement'
import { layoutAgentLabel, orchestratorInfo, agentDrawRadius } from '../web/components/agent-visualizer/canvas/team-style'

stubDocument()
// The main agent's hexagon is cached as a Path2D; node has none
if (!(globalThis as { Path2D?: unknown }).Path2D) (globalThis as { Path2D?: unknown }).Path2D = class { moveTo() {} lineTo() {} closePath() {} arc() {} rect() {} roundRect() {} }

const mono = (text: string, px: number) => text.length * px * 0.6
const fontPx = (font: string) => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 10)

/* eslint-disable @typescript-eslint/no-explicit-any */
function agent(over: Record<string, unknown> = {}): any {
  const id = (over.id as string) ?? 's1:main'
  return {
    id, agentKey: id, sessionId: 's1', localId: id, displayName: 'main', name: 'main',
    state: 'idle', parentId: null, parentKey: null, tokensUsed: 0, tokensMax: 1_000_000,
    toolCalls: 0, timeAlive: 0, x: 400, y: 300, vx: 0, vy: 0, pinned: false, isMain: true,
    spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [], lastEventAt: Date.now(),
    ...over,
  }
}

/** Box of a text as the recorder drew it (monospace, 0.6 em per glyph) */
function textBox(op: DrawnOp): Rect {
  const px = fontPx(op.font)
  const w = mono(String(op.args[0]), px)
  const x = Number(op.args[1])
  const y = Number(op.args[2])
  const x0 = op.textAlign === 'center' ? x - w / 2 : op.textAlign === 'right' || op.textAlign === 'end' ? x - w : x
  const y0 = op.textBaseline === 'top' ? y : op.textBaseline === 'middle' ? y - px / 2 : y - px
  return { x: x0, y: y0, w, h: px }
}

const contains = (outer: Rect, inner: Rect) =>
  outer.x <= inner.x + 1e-6 && outer.y <= inner.y + 1e-6 &&
  outer.x + outer.w >= inner.x + inner.w - 1e-6 && outer.y + outer.h >= inner.y + inner.h - 1e-6

/** Opaque plates (scene background, full alpha) painted between `from` and `to`, as rectangles */
function platesBetween(ops: DrawnOp[], from: number, to: number): Rect[] {
  const plates: Rect[] = []
  let pending: Rect | null = null
  for (let i = from; i < to; i++) {
    const o = ops[i]
    if (o.name === 'beginPath') pending = null
    if (o.name === 'roundRect' || o.name === 'rect') {
      const [x, y, w, h] = o.args.map(Number)
      pending = { x, y, w, h }
    }
    const opaque = o.fillStyle.toLowerCase() === SCENE.void.toLowerCase() && o.globalAlpha === 1
    if (o.name === 'fill' && pending && opaque) plates.push(pending)
    if (o.name === 'fillRect' && opaque) {
      const [x, y, w, h] = o.args.map(Number)
      plates.push({ x, y, w, h })
    }
  }
  return plates
}

/** Draw an edge straight across the label block, then the agents, on one recording context */
function drawWithEdgeAcross(a: any) {
  const r = agentDrawRadius(a)
  const layout = layoutAgentLabel(a, r, t => mono(t, AGENT_DRAW.labelFontSize), false, orchestratorInfo(a))
  const top = a.y + r + AGENT_DRAW.labelYOffset
  const lines = layout.nameLines.length + 1 + (layout.badgeText ? 1 : 0)
  const midY = top + (lines * AGENT_DRAW.stateLabelGap) / 2
  const rec = recordingContext(1)
  drawTaperedBezier(rec.ctx, a.x - 200, midY, a.x - 60, midY, a.x + 60, midY, a.x + 200, midY, 40, 40, SCENE.idle, 1)
  const edgeEnd = rec.ops.length
  const edge: Rect = { x: a.x - 200, y: midY - 20, w: 400, h: 40 }
  drawAgents(rec.ctx, new Map([[a.id, a]]), null, null, false, 0, { reducedMotion: true, zoom: 1, showCost: false, showStats: false } as any)
  return { rec, edgeEnd, edge, layout }
}

function assertEveryLabelTextOnPlate(a: any, expected: string[]) {
  const { rec, edgeEnd, edge } = drawWithEdgeAcross(a)
  for (const text of expected) {
    const i = rec.ops.findIndex((o, k) => k >= edgeEnd && o.name === 'fillText' && o.args[0] === text)
    assert.ok(i >= 0, `precondition: "${text}" is drawn`)
    const box = textBox(rec.ops[i])
    assert.ok(rectsOverlap(edge, box), `precondition: the edge crosses "${text}" ${JSON.stringify(box)}`)
    const plates = platesBetween(rec.ops, edgeEnd, i)
    assert.ok(plates.some(p => contains(p, box)),
      `"${text}" ${JSON.stringify(box)} has no opaque plate in SCENE.void between the edge and the text (plates: ${JSON.stringify(plates)})`)
  }
}

test('drawAgents: an edge crossing "MAIN payments-api" passes under an opaque plate, never through the letters (#378)', () => {
  const a = agent({ sessionLabel: 'payments-api' })
  const info = orchestratorInfo(a)
  assert.equal(info?.badge, 'MAIN', 'precondition: the main agent carries the MAIN pill')
  const { layout } = drawWithEdgeAcross(a)
  const rest = layout.groupLine!.slice(layout.badgeText!.length).trim()
  assert.equal(rest, 'payments-api')
  assertEveryLabelTextOnPlate(a, [...layout.nameLines, layout.statusLine, rest])
})

test('drawAgents: a subagent label crossed by an edge keeps its name and status on an opaque plate (#378)', () => {
  const a = agent({ id: 's1:sub', localId: 'sub', name: 'code-reviewer', displayName: 'code-reviewer', isMain: false, parentId: 's1:main', state: 'thinking' })
  const r = agentDrawRadius(a)
  const layout = layoutAgentLabel(a, r, t => mono(t, AGENT_DRAW.labelFontSize), false, orchestratorInfo(a))
  assertEveryLabelTextOnPlate(a, [...layout.nameLines, layout.statusLine])
})
