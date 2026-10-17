// Levels of detail of the canvas (#378, lot 2): a text that follows the zoom is never drawn under a
// readable on-screen size. Agent labels are held at that size and thinned out by the overlay plan;
// tool cards fall back to their icon and message bubbles to their count chip, instead of an empty or
// unreadable shape. Thresholds come from LOD (web/lib/canvas-constants.ts) and do not blink when the
// zoom hovers at them. The assistive outline keeps everything the canvas hides.
import './canvas-recorder'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { recordingContext, stubDocument } from './canvas-recorder'
import { LOD, AGENT_DRAW, STATS_OVERLAY, COST_DRAW } from '../web/lib/canvas-constants'
import { lodForZoom, type LevelOfDetail } from '../web/components/agent-visualizer/canvas/draw-options'
import { drawAgents } from '../web/components/agent-visualizer/canvas/draw-agents'
import { drawToolCalls } from '../web/components/agent-visualizer/canvas/draw-tool-calls'
import { drawMessageBubblesWorld } from '../web/components/agent-visualizer/canvas/draw-bubbles'
import { drawCostLabels } from '../web/components/agent-visualizer/canvas/draw-cost'
import { drawDiscoveries } from '../web/components/agent-visualizer/canvas/draw-discoveries'
import { drawParticles } from '../web/components/agent-visualizer/canvas/draw-particles'
import { drawPhaseLabels, drawClusterHalos, drawClusterLabels } from '../web/components/agent-visualizer/canvas/draw-teams'
import { getToolCardSize } from '../web/components/agent-visualizer/canvas/render-cache'
import { planOverlays, planKey } from '../web/components/agent-visualizer/canvas/overlay-plan'
import { setOverlayHits, clearOverlayHits } from '../web/components/agent-visualizer/canvas/overlay-state'
import { computeClusters } from '../web/components/agent-visualizer/canvas/cluster-model'
import { rectsOverlap } from '../web/components/agent-visualizer/canvas/label-placement'
import { buildA11yModel, updateToolHistory } from '../web/components/agent-visualizer/canvas/a11y-model'

/** Smallest on-screen size of a canvas text (≈ 11 px in the issue) */
const MIN_PX = (LOD as { minTextPx?: number }).minTextPx ?? 11
const HYSTERESIS = (LOD as { hysteresis?: number }).hysteresis ?? 0.08

stubDocument()

/* eslint-disable @typescript-eslint/no-explicit-any */
function agent(over: Record<string, unknown> = {}): any {
  const id = (over.id as string) ?? 's1:worker'
  return {
    id, agentKey: id, sessionId: 's1', localId: id, displayName: 'worker', name: 'worker',
    state: 'idle', parentId: 's1:main', parentKey: 's1:main', tokensUsed: 0, tokensMax: 200_000,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    toolCalls: 0, timeAlive: 0, x: 300, y: 300, vx: 0, vy: 0, pinned: false, isMain: false,
    spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [], lastEventAt: Date.now(),
    ...over,
  }
}
const map = (...list: any[]): Map<string, any> => new Map(list.map(a => [a.id, a]))
function tool(over: Record<string, unknown> = {}): any {
  return {
    id: 't1', agentId: 's1:worker', toolName: 'Read', args: 'web/lib/canvas-constants.ts', state: 'running',
    x: 400, y: 300, startTime: 0, opacity: 1, ...over,
  }
}
function planInput(agents: Map<string, any>, scale: number, over: Record<string, unknown> = {}): any {
  return {
    agents, clusters: computeClusters(agents.values()), edgeBubbles: [],
    transform: { x: 0, y: 0, scale }, viewport: { w: 1600, h: 1000 }, lod: lodForZoom(scale),
    showStats: false, showCost: false, showSessionLabels: false,
    selectedAgentId: null, hoveredAgentId: null, focusedAgentId: null, simTime: 1,
    isBubbleHeld: () => false,
    ...over,
  }
}
const opts = (zoom: number, over: Record<string, unknown> = {}): any => ({ reducedMotion: true, zoom, showCost: false, showStats: false, ...over })

// ─── Thresholds and hysteresis ───────────────────────────────────────────────

test('LOD: a shown level is kept just under its threshold, a hidden one only returns at the threshold (#378)', () => {
  const shown: LevelOfDetail = lodForZoom(4)
  const hidden: LevelOfDetail = lodForZoom(0.01)
  const thresholds = { labels: LOD.labelMinZoom, details: LOD.detailMinZoom, cardText: LOD.cardTextMinZoom, detailText: (LOD as { detailTextMinZoom?: number }).detailTextMinZoom ?? NaN }
  for (const key of ['labels', 'details', 'cardText', 'detailText'] as const) {
    const threshold = thresholds[key]
    const inBand = threshold * (1 - HYSTERESIS / 2)
    assert.equal(lodForZoom(inBand, shown)[key], true, `${key}: kept in the hysteresis band`)
    assert.equal(lodForZoom(inBand, hidden)[key], false, `${key}: not shown again in the band`)
    assert.equal(lodForZoom(inBand)[key], false, `${key}: no history = plain threshold`)
    assert.equal(lodForZoom(threshold * (1 - HYSTERESIS * 1.5), shown)[key], false, `${key}: dropped under the band`)
    assert.equal(lodForZoom(threshold, hidden)[key], true, `${key}: shown again at the threshold`)
  }
})

test('LOD: a zoom wobbling around a threshold flips each level at most once (no flicker, #378)', () => {
  for (const threshold of [LOD.labelMinZoom, LOD.detailMinZoom, 1]) {
    let lod: LevelOfDetail | undefined
    const flips = { labels: 0, details: 0, cardText: 0, detailText: 0 } as Record<string, number>
    let prev: Record<string, boolean> | undefined
    for (let i = 0; i < 200; i++) {
      const zoom = threshold * (1 + 0.02 * Math.sin(i))
      lod = lodForZoom(zoom, lod)
      const now = lod as unknown as Record<string, boolean>
      if (prev) for (const k of Object.keys(flips)) if (prev[k] !== now[k]) flips[k]++
      prev = { ...now }
    }
    for (const [k, n] of Object.entries(flips)) assert.ok(n <= 1, `${k} flipped ${n} times around zoom ${threshold}`)
  }
})

// ─── Agent labels: held at a readable size, thinned out by the plan ─────────

test('drawAgents: the agent label is never drawn under the minimum on-screen size where it is shown (#378)', () => {
  for (const zoom of [LOD.labelMinZoom, 0.5, 0.65, 0.9, 1, 2]) {
    assert.equal(lodForZoom(zoom).labels, true, `precondition: labels shown at ${zoom}`)
    const rec = recordingContext(zoom)
    drawAgents(rec.ctx, map(agent()), null, null, false, 0, opts(zoom))
    assert.ok(rec.texts.some(t => t.text.includes('worker')), `name drawn at zoom ${zoom}`)
    // The one-glyph icon at the centre of the node is part of the node shape and scales with it
    for (const t of rec.texts.filter(x => [...x.text].length > 1)) assert.ok(t.screenPx >= MIN_PX - 1e-9, `"${t.text}" at ${t.screenPx.toFixed(1)} px on screen (zoom ${zoom})`)
  }
})

test('planOverlays: the label block is reserved at the size it is drawn, not shrunk with the zoom (#378)', () => {
  const zoom = 0.5
  const p = planOverlays(planInput(map(agent()), zoom)).plan.get(planKey.label('s1:worker'))!
  assert.ok(p.rect && !p.hidden, 'precondition: the lone label is placed')
  // Two lines (name, state), each at least the minimum text size on screen
  assert.ok(p.rect.h >= 2 * MIN_PX, `label block ${p.rect.h.toFixed(1)} px high on screen`)
  assert.ok(p.rect.h / 2 >= AGENT_DRAW.stateLabelGap * (MIN_PX / AGENT_DRAW.labelFontSize) - 1e-9)
})

/** 10 agents in a 5 x 2 grid, `gap` world px apart: on develop (labels shrunk with the zoom) none of their labels gave way at 100 px / 50 % */
function grid(gap: number, over: (i: number) => Record<string, unknown> = () => ({})): any[] {
  return Array.from({ length: 10 }, (_, i) => agent({
    id: `s1:w${i}`, name: `worker-${i}`, displayName: `worker-${i}`,
    x: 300 + (i % 5) * gap, y: 300 + Math.floor(i / 5) * gap, ...over(i),
  }))
}

test('planOverlays: crowded labels are thinned out (hidden or one line), never stacked, the selected one kept (#378)', () => {
  // A layout where labels shrunk with the zoom all fit: only the label block reserved at its drawn size gives way
  const list = grid(100)
  const agents = map(...list)
  const zoom = 0.5
  const { plan } = planOverlays(planInput(agents, zoom, { selectedAgentId: 's1:w3' }))
  const placed = list.map(a => plan.get(planKey.label(a.id))!)
  const shown = placed.filter(p => !p.hidden && p.rect)
  for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) {
    assert.equal(rectsOverlap(shown[i].rect!, shown[j].rect!), false, `${shown[i].id} overlaps ${shown[j].id}`)
  }
  assert.ok(placed.some(p => p.hidden || p.collapsed), 'some labels give way')
  assert.equal(plan.get(planKey.label('s1:w3'))!.hidden, false, 'the selected agent keeps its label')
})

test('planOverlays: an agent in error keeps its label when crowded labels give way (#378)', () => {
  for (const [gap, zoom] of [[100, 0.5], [120, 0.4], [80, 0.4]] as const) {
    for (const errorAt of [3, 6, 8]) {
      const list = grid(gap, i => (i < 3 ? { state: 'thinking' } : i === errorAt ? { state: 'error' } : {}))
      const { plan } = planOverlays(planInput(map(...list), zoom))
      const p = plan.get(planKey.label(`s1:w${errorAt}`))!
      assert.equal(p.hidden, false, `agent in error (w${errorAt}) loses its label at gap ${gap}, zoom ${zoom}`)
    }
  }
})

// ─── Tool cards: icon instead of an empty or unreadable card ────────────────

test('drawToolCalls: under the card-text zoom a card is its icon (square), with no text under the minimum size (#378)', () => {
  for (const zoom of [0.4, 0.7]) {
    for (const t of [tool(), tool({ id: 't2', state: 'complete', tokenCost: 1200 }), tool({ id: 't3', toolName: 'mcp__github__search', mcp: { server: 'github', tool: 'search' } })]) {
      const rec = recordingContext(zoom)
      drawToolCalls(rec.ctx, map(t), 0, null, opts(zoom))
      for (const text of rec.texts) assert.ok(text.screenPx >= MIN_PX - 1e-9, `${t.id} "${text.text}" at ${text.screenPx.toFixed(1)} px (zoom ${zoom})`)
      const size = getToolCardSize(t.id)!
      assert.equal(size.w, size.h, `${t.id} at zoom ${zoom}: icon, not a ${size.w}x${size.h} empty card`)
      assert.ok(rec.rects.length >= 1 && rec.rects.every(r => Math.abs(r.w - r.h) < 1e-9), `${t.id}: only square shapes drawn`)
    }
  }
})

test('drawToolCalls: at 100% the card keeps its text, none of it under the minimum size, MCP badge included (#378)', () => {
  for (const t of [tool(), tool({ id: 't3', toolName: 'mcp__github__search', mcp: { server: 'github', tool: 'search' } })]) {
    const rec = recordingContext(1)
    drawToolCalls(rec.ctx, map(t), 0, null, opts(1))
    assert.ok(rec.texts.some(x => x.text.startsWith(t.mcp ? 'search' : 'Read')), `${t.id}: card text drawn`)
    for (const x of rec.texts) assert.ok(x.screenPx >= MIN_PX - 1e-9, `${t.id} "${x.text}" at ${x.screenPx.toFixed(1)} px at 100%`)
    const size = getToolCardSize(t.id)!
    assert.ok(size.w > size.h, `${t.id}: full card`)
  }
})

/** Shapes drawn by a call, colours left out: method, rounded arguments, line width and dash */
function shapeTrace(rec: ReturnType<typeof recordingContext>): string {
  return rec.ops
    .filter(o => o.name !== 'measureText')
    .map(o => `${o.name}(${o.args.map(a => (typeof a === 'number' ? a.toFixed(2) : Array.isArray(a) ? `[${a}]` : String(a))).join(',')})` + (o.name === 'stroke' ? `@${o.lineWidth}/[${o.lineDash}]` : ''))
    .join(';')
}
function drawIcon(t: any, zoom = 0.7, over: Record<string, unknown> = {}) {
  const rec = recordingContext(zoom)
  drawToolCalls(rec.ctx, map(t), 0, null, opts(zoom, over))
  return rec
}

test('drawToolCalls: on the icon, running, complete and error differ by shape, not only by colour (reduced motion, #378)', () => {
  const traces = {
    running: shapeTrace(drawIcon(tool({ state: 'running' }))),
    complete: shapeTrace(drawIcon(tool({ state: 'complete' }))),
    error: shapeTrace(drawIcon(tool({ state: 'error', errorMessage: 'ENOENT' }))),
  }
  assert.notEqual(traces.running, traces.complete, 'running and complete icons draw the same shapes')
  assert.notEqual(traces.running, traces.error, 'running and error icons draw the same shapes')
  assert.notEqual(traces.complete, traces.error, 'complete and error icons draw the same shapes')
})

test('drawToolCalls: the error icon carries a mark at least 1.25 px thick on screen (#378)', () => {
  for (const zoom of [0.4, 0.7]) {
    const thickSegments = (rec: ReturnType<typeof drawIcon>) => rec.ops.filter(o => o.name === 'stroke' && o.lineWidth * o.scale >= 1.25 - 1e-9).length
    const complete = thickSegments(drawIcon(tool({ state: 'complete' }), zoom))
    const error = thickSegments(drawIcon(tool({ state: 'error' }), zoom))
    assert.ok(error > complete, `zoom ${zoom}: the error icon adds no stroke of 1.25 px or more (${error} vs ${complete})`)
  }
})

test('drawToolCalls: the icon of an MCP call is a ring, an unknown tool a dot (#378)', () => {
  const centreMark = (rec: ReturnType<typeof drawIcon>) => {
    const i = rec.ops.findIndex(o => o.name === 'arc' && o.args[0] === 400 && o.args[1] === 300)
    assert.ok(i >= 0, 'a mark is drawn at the centre of the icon')
    return rec.ops.slice(i + 1).find(o => o.name === 'fill' || o.name === 'stroke')!.name
  }
  assert.equal(centreMark(drawIcon(tool({ state: 'complete', toolName: 'mcp__github__search', mcp: { server: 'github', tool: 'search' } }))), 'stroke', 'MCP: a ring')
  assert.equal(centreMark(drawIcon(tool({ state: 'complete', toolName: 'SomeUnknownTool', args: '' }))), 'fill', 'unknown tool: a dot')
})

test('drawToolCalls: error and cancelled calls become icons too, cancelled dashed (#378)', () => {
  for (const t of [tool({ id: 't4', state: 'error', errorMessage: 'ENOENT' }), tool({ id: 't5', state: 'cancelled' }), tool({ id: 't6', state: 'expired' })]) {
    const rec = drawIcon(t)
    for (const x of rec.texts) assert.ok(x.screenPx >= MIN_PX - 1e-9, `${t.id} "${x.text}" at ${x.screenPx.toFixed(1)} px`)
    const size = getToolCardSize(t.id)!
    assert.equal(size.w, size.h, `${t.id}: icon`)
    if (t.state !== 'error') assert.ok(rec.ops.some(o => o.name === 'stroke' && o.lineDash.join(',') === '4,3'), `${t.id}: dashed outline`)
  }
})

test('drawToolCalls: the strokes of the icon glyph stay at least 1.25 px thick on screen (#378)', () => {
  for (const zoom of [0.35, 0.4, 0.7]) {
    const rec = drawIcon(tool({ state: 'complete' }), zoom)
    const start = rec.ops.findIndex(o => o.name === 'translate')
    assert.ok(start >= 0, 'the glyph is drawn')
    const end = rec.ops.findIndex((o, i) => i > start && o.name === 'restore')
    for (const o of rec.ops.slice(start, end).filter(o => o.name === 'stroke')) {
      assert.ok(o.lineWidth * o.scale >= 1.25 - 1e-9, `glyph stroke at ${(o.lineWidth * o.scale).toFixed(2)} px (zoom ${zoom})`)
    }
  }
})

// ─── Bubbles: count chip instead of unreadable text ─────────────────────────

test('bubbles: under the card-text zoom the stack folds into its count chip, no text under the minimum size (#378)', () => {
  const zoom = 0.7
  // A short stack: it ends above the label block, so only the level of detail can fold it
  const a = agent({ messageBubbles: [{ text: 'hello there', time: 0, role: 'assistant', _cachedW: 200, _cachedH: 30 }] })
  const agents = map(a)
  const result = planOverlays(planInput(agents, zoom))
  const p = result.plan.get(planKey.bubbles(a.id))!
  assert.equal(p.hidden, false)
  assert.equal(p.collapsed, true, 'count chip, not the full stack')
  setOverlayHits(result.hits)
  try {
    const rec = recordingContext(zoom)
    drawMessageBubblesWorld(rec.ctx, agents, 1, opts(zoom, { plan: result.plan, lod: lodForZoom(zoom) }))
    assert.ok(rec.texts.length > 0, 'the chip count is drawn')
    for (const t of rec.texts) assert.ok(t.screenPx >= MIN_PX - 1e-9, `"${t.text}" at ${t.screenPx.toFixed(1)} px`)
  } finally {
    clearOverlayHits()
  }
})

test('bubbles: the count chip of a lone agent is not pushed out by its enlarged label block (#378)', () => {
  for (const zoom of [0.36, 0.4, 0.46]) {
    const a = agent({ messageBubbles: [{ text: 'hello there', time: 0, role: 'assistant', _cachedW: 200, _cachedH: 30 }] })
    const p = planOverlays(planInput(map(a), zoom)).plan.get(planKey.bubbles(a.id))!
    assert.equal(p.hidden, false, `zoom ${zoom}: chip hidden`)
    assert.equal(p.collapsed, true, `zoom ${zoom}: count chip`)
  }
})

test('bubbles: at 100% the stack is drawn in full (#378)', () => {
  const a = agent({ messageBubbles: [{ text: 'hello there', time: 0, role: 'assistant', _cachedW: 200, _cachedH: 60 }] })
  const p = planOverlays(planInput(map(a), 1)).plan.get(planKey.bubbles(a.id))!
  assert.equal(p.collapsed, false)
  assert.equal(p.hidden, false)
})

// ─── Assistive technologies keep what the LOD hides ─────────────────────────

test('a11y model: names, states and tool calls hidden by the LOD stay in the outline (#378)', () => {
  const zoom = 0.2
  assert.equal(lodForZoom(zoom).labels, false, 'precondition: canvas labels hidden at this zoom')
  const agents = map(agent())
  const toolCalls = map(tool())
  const model = buildA11yModel(agents, toolCalls, [], updateToolHistory(new Map(), toolCalls))
  const item = model.agents.find(x => x.id === 's1:worker')!
  assert.equal(item.name, 'worker')
  assert.ok(item.stateText.length > 0)
  assert.deepEqual(item.tools.map(t => t.name), ['Read'])
})

// ─── Secondary text: hidden under the floor, held at it where it is shown ───
// Stats box, cost pill, context percentage, discovery text, particle labels, model caption, phase and
// team halo labels are drawn in world space: they follow the zoom. Below the zoom where their size reaches
// LOD.minTextPx on screen they are hidden (the panels and the outline keep the numbers); where they are
// shown, hysteresis band included, they are never drawn under LOD.minTextPx.

/** Zooms from the fit of a team (0.4) to 150 %, each also with a previous frame that showed everything (hysteresis band) */
const SECONDARY_ZOOMS = [0.4, 0.55, 0.6, 0.7, 0.8, 0.9, 0.93, 0.96, 1, 1.2, 1.5]
const fromAbove = (zoom: number) => lodForZoom(zoom, lodForZoom(4))
// The main agent's hexagon is cached as a Path2D; node has none
if (!(globalThis as { Path2D?: unknown }).Path2D) (globalThis as { Path2D?: unknown }).Path2D = class { moveTo() {} lineTo() {} closePath() {} arc() {} rect() {} roundRect() {} }
const tooSmall = (rec: ReturnType<typeof recordingContext>) =>
  rec.texts.filter(t => [...t.text].length > 1 && t.screenPx < MIN_PX - 1e-9).map(t => `"${t.text}" ${t.screenPx.toFixed(1)} px`)

function mainAgent(over: Record<string, unknown> = {}): any {
  return agent({
    id: 's1:main', name: 'main', displayName: 'main', isMain: true, parentId: null, parentKey: null, state: 'thinking',
    model: 'claude-opus-4-6', tokensUsed: 180_000, tokensMax: 200_000, toolCalls: 3, timeAlive: 42,
    contextBreakdown: { systemPrompt: 180_000, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    ...over,
  })
}

test('drawAgents: stats, context percentage and model caption are never drawn under the minimum on-screen size (#378)', () => {
  for (const zoom of SECONDARY_ZOOMS) {
    for (const lod of [lodForZoom(zoom), fromAbove(zoom)]) {
      const rec = recordingContext(zoom)
      drawAgents(rec.ctx, map(mainAgent(), agent({ model: 'claude-sonnet-4-5', tokensUsed: 40_000 })), null, null, true, 0, opts(zoom, { lod, showStats: true }))
      assert.deepEqual(tooSmall(rec), [], `zoom ${zoom}`)
    }
  }
})

test('drawAgents: at 150 % the stats box and the context percentage are drawn, at 40 % they are hidden (#378)', () => {
  const draw = (zoom: number) => {
    const rec = recordingContext(zoom)
    drawAgents(rec.ctx, map(mainAgent()), null, null, true, 0, opts(zoom, { lod: lodForZoom(zoom), showStats: true }))
    return rec.texts.map(t => t.text)
  }
  assert.ok(draw(1.5).some(t => t.includes('tools')), 'stats box at 150 %')
  assert.ok(draw(1.5).some(t => t.includes('%')), 'context percentage at 150 %')
  assert.ok(!draw(0.4).some(t => t.includes('tools') || t.includes('%')), 'no stats nor percentage at 40 %')
})

test('drawAgents: the model caption is drawn only where it reaches the minimum size, and then at that size or more (#378)', () => {
  const caption = (zoom: number) => {
    const rec = recordingContext(zoom)
    drawAgents(rec.ctx, map(mainAgent({ state: 'idle' })), null, null, false, 0, opts(zoom, { lod: lodForZoom(zoom) }))
    return rec.texts.filter(t => /opus/i.test(t.text))
  }
  for (const zoom of [0.6, 1]) assert.deepEqual(caption(zoom).map(t => t.screenPx), [], `no caption at zoom ${zoom}`)
  const big = caption(3)
  assert.equal(big.length, 1, 'caption drawn at 300 %')
  assert.ok(big[0].screenPx >= MIN_PX - 1e-9, `caption at ${big[0].screenPx.toFixed(1)} px`)
})

test('planOverlays: the stats box and cost pill are reserved only where drawn, at the size they are drawn (#378)', () => {
  const a = mainAgent()
  const keys = [planKey.stats(a.id), planKey.cost(a.id)]
  // Under the text floor: nothing is drawn, so nothing is reserved that would push other texts away
  const low = planOverlays(planInput(map(a), 0.8, { showStats: true, showCost: true })).plan
  for (const k of keys) assert.ok(!low.get(k) || low.get(k)!.hidden, `${k} reserved at 80 %`)
  // In the hysteresis band the text is held at the floor: the reserved rect is as high as the drawn one
  const zoom = 0.95
  const band = planOverlays(planInput(map(a), zoom, { showStats: true, showCost: true, lod: fromAbove(zoom) })).plan
  const stats = band.get(planKey.stats(a.id))!
  assert.ok(stats && stats.rect, 'stats box reserved in the band')
  assert.ok(stats.rect!.h >= STATS_OVERLAY.boxHeight * (MIN_PX / STATS_OVERLAY.fontSize) - 1e-9, `stats box ${stats.rect!.h.toFixed(2)} px high on screen`)
  const cost = band.get(planKey.cost(a.id))!
  assert.ok(cost && cost.rect, 'cost pill reserved in the band')
  assert.ok(cost.rect!.h >= COST_DRAW.pillHeight * (MIN_PX / 11) - 1e-9, `cost pill ${cost.rect!.h.toFixed(2)} px high on screen`)
})

test('drawCostLabels: the cost pill is never drawn under the minimum on-screen size (#378)', () => {
  const tools = map(tool({ agentId: 's1:main', state: 'complete', tokenCost: 1200 }))
  for (const zoom of SECONDARY_ZOOMS) {
    for (const lod of [lodForZoom(zoom), fromAbove(zoom)]) {
      const rec = recordingContext(zoom)
      drawCostLabels(rec.ctx, map(mainAgent()), tools, opts(zoom, { lod, showCost: true }))
      assert.deepEqual(tooSmall(rec), [], `zoom ${zoom}`)
    }
  }
  const rec = recordingContext(1.5)
  drawCostLabels(rec.ctx, map(mainAgent()), tools, opts(1.5, { showCost: true }))
  assert.ok(rec.texts.some(t => t.text.includes('$')), 'cost pill drawn at 150 %')
})

test('drawDiscoveries and drawParticles: their text is never drawn under the minimum on-screen size (#378)', () => {
  const disc: any = { id: 'd1', agentId: 's1:main', type: 'file', label: 'canvas-constants.ts', content: 'LOD floor\n11 px', x: 500, y: 300, targetX: 500, targetY: 300, opacity: 1, timestamp: 0 }
  const agents = map(mainAgent({ x: 100, y: 300 }), agent({ id: 's1:worker', x: 500, y: 300 }))
  const edges = new Map([['e1', { id: 'e1', from: 's1:main', to: 's1:worker', type: 'parent-child', opacity: 1 } as any]])
  const particle: any = { id: 'p1', edgeId: 'e1', progress: 0.5, type: 'dispatch', color: '#66ccff', size: 3, trailLength: 0.2, label: 'auth.ts 142 lines' }
  let drawnAt = 0
  for (const zoom of SECONDARY_ZOOMS) {
    for (const lod of [lodForZoom(zoom), fromAbove(zoom)]) {
      const rec = recordingContext(zoom)
      drawDiscoveries(rec.ctx, [disc], agents, null, opts(zoom, { lod }))
      drawParticles(rec.ctx, [particle], edges, agents, new Map(), 0, opts(zoom, { lod }))
      assert.deepEqual(tooSmall(rec), [], `zoom ${zoom}`)
      if (rec.texts.some(t => t.text.includes('auth.ts')) && rec.texts.some(t => t.text.includes('LOD floor'))) drawnAt++
    }
  }
  assert.ok(drawnAt > 0, 'discovery and particle text drawn at some zoom')
})

// drawTeamHalos is not called by the draw loop (use-canvas-draw-loop.ts draws drawClusterHalos, drawPhaseLabels
// and drawClusterLabels): the check covers the layers that are actually drawn.
test('drawPhaseLabels, drawClusterHalos and drawClusterLabels (the halo layers of the draw loop): no text under the minimum on-screen size (#378)', () => {
  const labels: any[] = [{ clusterKey: 'c1', phase: 'build', text: 'Phase Build', x: 300, y: 200, memberIds: ['a', 'b'] }]
  const agents = map(
    mainAgent({ x: 300, y: 300 }), agent({ id: 's1:worker', x: 420, y: 320 }),
    agent({ id: 's2:main', agentKey: 's2:main', sessionId: 's2', isMain: true, parentId: null, parentKey: null, x: 900, y: 300 }),
  )
  const clusters = computeClusters(agents.values())
  let phaseAt = 0
  let titlesAt = 0
  for (const zoom of SECONDARY_ZOOMS) {
    for (const lod of [lodForZoom(zoom), fromAbove(zoom)]) {
      // World space, under the camera: the phase chips and the halos (which carry no text of their own)
      const world = recordingContext(zoom)
      drawPhaseLabels(world.ctx, labels, opts(zoom, { lod }))
      drawClusterHalos(world.ctx, clusters, null, opts(zoom, { lod }))
      assert.deepEqual(tooSmall(world), [], `zoom ${zoom}: world-space halo layers`)
      if (world.texts.some(t => t.text === 'Phase Build')) phaseAt++
      // Screen space, after the camera: the halo titles placed by the overlay plan
      const { plan } = planOverlays(planInput(agents, zoom, { lod }))
      const screen = recordingContext(1)
      drawClusterLabels(screen.ctx, clusters, plan, null, null, opts(zoom, { lod, plan }))
      assert.deepEqual(tooSmall(screen), [], `zoom ${zoom}: halo titles`)
      if (screen.texts.length > 0) titlesAt++
    }
  }
  assert.ok(phaseAt > 0, 'phase labels drawn at some zoom')
  assert.ok(titlesAt > 0, 'halo titles drawn at some zoom')
})
