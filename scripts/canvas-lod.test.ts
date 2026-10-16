// Levels of detail of the canvas (#378, lot 2): a text that follows the zoom is never drawn under a
// readable on-screen size. Agent labels are held at that size and thinned out by the overlay plan;
// tool cards fall back to their icon and message bubbles to their count chip, instead of an empty or
// unreadable shape. Thresholds come from LOD (web/lib/canvas-constants.ts) and do not blink when the
// zoom hovers at them. The assistive outline keeps everything the canvas hides.
import './canvas-recorder'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { recordingContext, stubDocument } from './canvas-recorder'
import { LOD, AGENT_DRAW } from '../web/lib/canvas-constants'
import { lodForZoom, type LevelOfDetail } from '../web/components/agent-visualizer/canvas/draw-options'
import { drawAgents } from '../web/components/agent-visualizer/canvas/draw-agents'
import { drawToolCalls } from '../web/components/agent-visualizer/canvas/draw-tool-calls'
import { drawMessageBubblesWorld } from '../web/components/agent-visualizer/canvas/draw-bubbles'
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
  for (const key of ['labels', 'details'] as const) {
    const threshold = key === 'labels' ? LOD.labelMinZoom : LOD.detailMinZoom
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
    const flips = { labels: 0, details: 0, cardText: 0 } as Record<string, number>
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

test('planOverlays: crowded labels are thinned out (hidden or one line), never stacked, the selected one kept (#378)', () => {
  const list = Array.from({ length: 8 }, (_, i) => agent({ id: `s1:w${i}`, name: `worker-${i}`, displayName: `worker-${i}`, x: 300 + i * 50 }))
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

test('drawToolCalls: at 100% the card keeps its text (#378)', () => {
  const rec = recordingContext(1)
  drawToolCalls(rec.ctx, map(tool()), 0, null, opts(1))
  assert.ok(rec.texts.some(t => t.text.startsWith('Read')), 'card text drawn')
  const size = getToolCardSize('t1')!
  assert.ok(size.w > size.h, 'full card')
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
