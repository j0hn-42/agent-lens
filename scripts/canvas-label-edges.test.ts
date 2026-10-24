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
import { readFileSync } from 'node:fs'
import { THEME_IDS } from '../web/lib/theme-tokens'
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
type Plate = Rect & { rounded: boolean }
function platesBetween(ops: DrawnOp[], from: number, to: number): Plate[] {
  const plates: Plate[] = []
  // A plate can be one path made of several rectangles, one per line: keep them all
  let pending: Plate[] = []
  for (let i = from; i < to; i++) {
    const o = ops[i]
    if (o.name === 'beginPath') pending = []
    if (o.name === 'roundRect' || o.name === 'rect') {
      const [x, y, w, h, radius] = o.args.map(Number)
      pending.push({ x, y, w, h, rounded: o.name === 'roundRect' && radius > 0 })
    }
    const opaque = o.fillStyle.toLowerCase() === SCENE.void.toLowerCase() && o.globalAlpha === 1
    if (o.name === 'fill' && opaque) plates.push(...pending)
    if (o.name === 'fillRect' && opaque) {
      const [x, y, w, h] = o.args.map(Number)
      plates.push({ x, y, w, h, rounded: false })
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
  const textBoxes: Rect[] = []
  for (const text of expected) {
    const i = rec.ops.findIndex((o, k) => k >= edgeEnd && o.name === 'fillText' && o.args[0] === text)
    assert.ok(i >= 0, `precondition: "${text}" is drawn`)
    const box = textBox(rec.ops[i])
    assert.ok(rectsOverlap(edge, box), `precondition: the edge crosses "${text}" ${JSON.stringify(box)}`)
    const plates = platesBetween(rec.ops, edgeEnd, i)
    assert.ok(plates.some(p => contains(p, box)),
      `"${text}" ${JSON.stringify(box)} has no opaque plate in SCENE.void between the edge and the text (plates: ${JSON.stringify(plates)})`)
    textBoxes.push(box)
  }
  return { rec, edgeEnd, textBoxes, plates: platesBetween(rec.ops, edgeEnd, rec.ops.length) }
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

// Review of #504: the plate was one hard-edged rectangle as wide as the widest line, starting 5 px under the
// rim, painted at the agent's fading alpha. It cut a dark band through the node's glow and ripples, hid a
// downward edge from the rim on, and let edges show through the letters while the agent faded in or out.

const subagent = (over: Record<string, unknown> = {}) =>
  agent({ id: 's1:sub', localId: 'sub', name: 'code-reviewer', displayName: 'code-reviewer', isMain: false, parentId: 's1:main', state: 'thinking', ...over })
const linesOf = (a: any) => {
  const layout = layoutAgentLabel(a, agentDrawRadius(a), t => mono(t, AGENT_DRAW.labelFontSize), false, orchestratorInfo(a))
  return { layout, texts: [...layout.nameLines, layout.statusLine] }
}

test('drawAgents: each label plate is rounded and fitted to its own line, not a block as wide as the widest line (#378)', () => {
  const a = agent({ sessionLabel: 'payments-api' })
  const { layout } = drawWithEdgeAcross(a)
  const rest = layout.groupLine!.slice(layout.badgeText!.length).trim()
  const { textBoxes, plates } = assertEveryLabelTextOnPlate(a, [...layout.nameLines, layout.statusLine, rest])
  for (const p of plates) assert.ok(p.rounded, `plate ${JSON.stringify(p)} has hard corners`)
  // The status line ("idle") is much narrower than "payments-api": its plate hugs it
  const status = textBoxes[layout.nameLines.length]
  const pad = AGENT_DRAW.labelHaloWidth
  for (const p of plates.filter(q => contains(q, status))) {
    assert.ok(p.w <= status.w + 2 * pad + 1e-6, `the plate under "${layout.statusLine}" is ${p.w} px wide for a ${status.w} px text`)
  }
})

test('drawAgents: no plate covers the gap between the node rim and the first label line, so a downward edge visibly leaves the node (#378)', () => {
  const a = subagent()
  const r = agentDrawRadius(a)
  const { textBoxes, plates } = assertEveryLabelTextOnPlate(a, linesOf(a).texts)
  const firstTop = Math.min(...textBoxes.map(b => b.y))
  assert.ok(firstTop - (a.y + r) >= AGENT_DRAW.labelYOffset - 1e-6, 'precondition: the label starts under the rim')
  for (const p of plates) {
    assert.ok(p.y >= firstTop - 1 - 1e-6,
      `plate ${JSON.stringify(p)} starts ${firstTop - p.y} px above the text: it hides the edge between the rim (${a.y + r}) and the label (${firstTop})`)
  }
})

test('drawAgents: while an agent fades in or out, its label plate stays opaque under the faded text (#378)', () => {
  const a = subagent({ opacity: 0.4 })
  const { texts } = linesOf(a)
  const { rec } = assertEveryLabelTextOnPlate(a, texts)
  const name = rec.ops.find(o => o.name === 'fillText' && o.args[0] === texts[0])!
  assert.ok(Math.abs(name.globalAlpha - 0.4) < 1e-6, `precondition: the text fades with the agent (alpha ${name.globalAlpha})`)
})

// After #526 the scene follows the active theme, but the ground stays the page background behind the canvas
// (globals.css --scene-void) in every theme. The expected colour is read from the stylesheet, not from
// scenePalette, so the test fails if the plate drifts from what the canvas is really painted on.
test('drawAgents: in every theme the label plate has the real canvas ground, read from globals.css (#378)', () => {
  const css = readFileSync(new URL('../web/app/globals.css', import.meta.url), 'utf8')
  const ground = /--scene-void:\s*(#[0-9a-fA-F]{6})/.exec(css)?.[1].toLowerCase()
  assert.ok(ground, 'precondition: globals.css declares --scene-void')
  for (const theme of THEME_IDS) {
    const a = agent({ sessionLabel: 'payments-api' })
    const rec = recordingContext(1)
    drawAgents(rec.ctx, new Map([[a.id, a]]), null, null, false, 0, { reducedMotion: true, zoom: 1, showCost: false, showStats: false, theme } as any)
    const plates = rec.ops.filter(o => o.name === 'fill' && o.fillStyle.toLowerCase() === ground && o.globalAlpha === 1)
    assert.ok(plates.length > 0, `no plate painted with the canvas ground ${ground} in theme ${theme}`)
  }
})

// Below the point where the text is legible the plate follows the label's opacity: at the very start of an
// agent's appearance an edge is not cut by an opaque block under a text that is almost invisible.
test('drawAgents: at the start of an appearance the label plate fades with the label instead of cutting the edge (#378)', () => {
  const a = subagent({ opacity: 0.05 })
  const rec = recordingContext(1)
  drawAgents(rec.ctx, new Map([[a.id, a]]), null, null, false, 0, { reducedMotion: true, zoom: 1, showCost: false, showStats: false } as any)
  const fills = rec.ops.filter(o => o.name === 'fill' && o.fillStyle.toLowerCase() === SCENE.void.toLowerCase())
  const name = rec.ops.find(o => o.name === 'fillText' && o.args[0] === linesOf(a).texts[0])!
  assert.ok(fills.length > 0 && fills.every(f => f.globalAlpha < 1), 'precondition: a plate is painted, and it is not opaque')
  const expected = Math.min(1, name.globalAlpha / AGENT_DRAW.labelPlateFullAlpha)
  assert.ok(fills.every(f => Math.abs(f.globalAlpha - expected) < 1e-6),
    `plate alpha ${fills.map(f => f.globalAlpha)} should be ${expected} for a text at ${name.globalAlpha}`)
})
