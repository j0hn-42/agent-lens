// Raster costs of the canvas (#661): what a frame pays per agent must not grow with a blur, a gradient or a
// measurement that the picture does not need. Shadows are sprites, gradients are cached, labels that the
// overlay plan hides are not measured.
import './canvas-recorder'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { recordingContext, stubDocument } from './canvas-recorder'
import { drawAgents } from '../web/components/agent-visualizer/canvas/draw-agents'
import { planOverlays, planKey, resolvePlacement } from '../web/components/agent-visualizer/canvas/overlay-plan'
import { computeClusters } from '../web/components/agent-visualizer/canvas/cluster-model'
import { layoutAgentLabel, agentDrawRadius } from '../web/components/agent-visualizer/canvas/team-style'
import { lodForZoom } from '../web/components/agent-visualizer/canvas/draw-options'

stubDocument()

/* eslint-disable @typescript-eslint/no-explicit-any */
function agent(i: number, over: Record<string, unknown> = {}): any {
  const id = `s1:w${i}`
  return {
    id, agentKey: id, sessionId: 's1', localId: id, displayName: `w${i}`, name: `w${i}`,
    state: 'thinking', parentId: 's1:main', parentKey: 's1:main', tokensUsed: 0, tokensMax: 200_000,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    toolCalls: 0, timeAlive: 0, x: 100 + i * 60, y: 200, vx: 0, vy: 0, pinned: false, isMain: false,
    spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [], lastEventAt: Date.now(), ...over,
  }
}
const map = (list: any[]): Map<string, any> => new Map(list.map(a => [a.id, a]))
const opts = (zoom: number, over: Record<string, unknown> = {}): any => ({ reducedMotion: false, zoom, showCost: false, showStats: false, lod: lodForZoom(zoom), ...over })

/** The recording context, with a log of the properties the draw code assigns */
function watched() {
  const rec = recordingContext(1)
  const sets: Array<[string, unknown]> = []
  const ctx = new Proxy(rec.ctx as any, {
    set(t, p, v) { if (typeof p === 'string') sets.push([p, v]); t[p] = v; return true },
  }) as CanvasRenderingContext2D
  return { rec, ctx, sets }
}

test('drawAgents: a hidden label costs no text measure of its status line (#661)', () => {
  const stale = agent(0, { state: 'working', lastEventAt: 0 })
  const { rec, ctx } = watched()
  drawAgents(ctx, map([stale]), null, null, false, 1e9, opts(1, { plan: new Map() }))
  const measured = rec.ops.filter(o => o.name === 'measureText').map(o => String(o.args[0]))
  assert.ok(!measured.some(t => /last known/i.test(t)), `measured: ${measured.join(' | ')}`)
})

test('drawAgents: a label the plan hides is not laid out again, its line count comes from the plan (#613)', () => {
  // Stacked on one spot: the plan hides some labels. Teammates wrap their name on two lines, so extraLines is 1.
  const list = Array.from({ length: 6 }, (_, i) => agent(i, { kind: 'teammate', name: `hiddenprobe-${i}-aaaa-bbbb-cccc-dddd`, x: 400 + i * 4 }))
  const agents = map(list)
  const result = planOverlays({
    agents, clusters: computeClusters(agents.values()), edgeBubbles: [], transform: { x: 0, y: 0, scale: 1 },
    viewport: { w: 1200, h: 800 }, lod: lodForZoom(1), showStats: false, showCost: false, showSessionLabels: false,
    selectedAgentId: null, hoveredAgentId: null, focusedAgentId: null, simTime: 1, isBubbleHeld: () => false,
  } as any)
  const hidden = list.filter(a => result.plan.get(planKey.label(a.id))?.hidden)
  assert.ok(hidden.length >= 1, 'precondition: the plan hides a label')
  for (const a of hidden) {
    const lines = resolvePlacement(result.plan, planKey.label(a.id), 1).extraLines
    // Teammates wrap their name on two lines: one extra line, and the very count the label would have when drawn
    const measure = (t: string) => t.length * 11 * 0.6
    assert.equal(lines, layoutAgentLabel(a, agentDrawRadius(a), measure, false, null).extraLines, 'the plan carries the line count of a label it hides')
    assert.equal(lines, 1)
  }
  const { rec, ctx } = watched()
  drawAgents(ctx, agents, null, null, false, 0, opts(1, { plan: result.plan }))
  const measured = rec.ops.filter(o => o.name === 'measureText').map(o => String(o.args[0]))
  for (const a of hidden) {
    assert.ok(!measured.some(t => t.includes(a.name.slice(0, 14))), `the hidden label of ${a.name} was measured`)
  }
})

test('drawAgents: the depth shadow is a sprite, no agent pays a shadowBlur per frame (#661)', () => {
  const { rec, ctx, sets } = watched()
  const agents = map(Array.from({ length: 20 }, (_, i) => agent(i)))
  drawAgents(ctx, agents, null, null, false, 0, opts(1))
  const blurs = sets.filter(([p, v]) => p === 'shadowBlur' && Number(v) > 0)
  assert.equal(blurs.length, 0, 'no shadowBlur set')
  assert.ok(rec.ops.filter(o => o.name === 'drawImage').length >= 20, 'sprites drawn')
})

test('drawAgents: the scanline gradient is cached by colour, not created per agent per frame (#661)', () => {
  const { rec, ctx } = watched()
  const agents = map(Array.from({ length: 20 }, (_, i) => agent(i)))
  for (let f = 0; f < 3; f++) drawAgents(ctx, agents, null, null, false, f * 0.1, opts(1))
  const gradients = rec.ops.filter(o => o.name === 'createLinearGradient').length
  assert.ok(gradients <= 2, `${gradients} gradients created for 60 agent draws of one colour`)
})

/** Canvases created while `run` draws: the size of the sprites that were painted */
function spriteWidths(run: () => void): number[] {
  const doc = (globalThis as any).document
  const made: any[] = []
  const original = doc.createElement
  doc.createElement = (...a: unknown[]) => { const c = original(...a); made.push(c); return c }
  try { run() } finally { doc.createElement = original }
  return made.map(c => c.width)
}

test('drawAgents: no depth-shadow sprite is painted below the detail zoom, whatever its size would be (#661)', () => {
  const widths = spriteWidths(() => {
    for (const zoom of [0.04, 0.1, 0.3]) {
      const { ctx } = watched()
      drawAgents(ctx, map([agent(0, { scale: 0.77 }), agent(1, { scale: 0.41 })]), null, null, false, 0, opts(zoom))
    }
  })
  assert.ok(Math.max(0, ...widths) < 200, `a sprite of ${Math.max(0, ...widths)} px was painted under the detail zoom`)
})

test('drawAgents: the depth shadow sprite stays small from the detail zoom up (#661)', () => {
  const widths = spriteWidths(() => {
    const { ctx } = watched()
    drawAgents(ctx, map([agent(0, { scale: 0.63 })]), null, null, false, 0, opts(0.6))
  })
  const widest = Math.max(0, ...widths)
  assert.ok(widest > 0 && widest < 300, `sprite width ${widest}`)
})

/** The shadow properties each sprite canvas was painted with while `run` draws */
function spriteShadows(run: () => void): Array<{ blur: number; ox: number; oy: number }> {
  const doc = (globalThis as any).document
  const painted: Array<{ blur: number; ox: number; oy: number }> = []
  const original = doc.createElement
  doc.createElement = (...a: unknown[]) => {
    const c = original(...a)
    const seen = { blur: 0, ox: 0, oy: 0 }
    painted.push(seen)
    const real = c.getContext
    c.getContext = (...b: unknown[]) => new Proxy(real.apply(c, b), {
      set(t, p, v) {
        if (p === 'shadowBlur') seen.blur = Number(v)
        if (p === 'shadowOffsetX') seen.ox = Number(v)
        if (p === 'shadowOffsetY') seen.oy = Number(v)
        t[p] = v
        return true
      },
    })
    return c
  }
  try { run() } finally { doc.createElement = original }
  return painted.filter(p => p.blur > 0)
}

test('drawAgents: the depth shadow keeps its screen size on a 2x display (#613)', () => {
  // shadowBlur and the offsets are in sprite pixels, then scaled by zoom * dpr: the sprite is painted with the
  // shadow divided by that device scale, so blur * zoom * dpr stays the on-screen blur (within the half-octave step, ~20 %)
  const zoom = 1
  const paintAt = (dpr: number) => {
    const found = spriteShadows(() => {
      const { ctx } = watched()
      drawAgents(ctx, map([agent(0, { scale: 1.37 })]), null, null, false, 0, opts(zoom, { dpr }))
    })
    assert.equal(found.length, 1, `one sprite painted at dpr ${dpr}`)
    return found[0]
  }
  const dpr1 = paintAt(1)
  const dpr2 = paintAt(2)
  assert.ok(Math.abs(dpr1.blur / dpr2.blur - 2) < 1e-9, `blur ${dpr1.blur} at dpr 1, ${dpr2.blur} at dpr 2: not halved`)
  assert.ok(Math.abs(dpr1.ox / dpr2.ox - 2) < 1e-9 && Math.abs(dpr1.oy / dpr2.oy - 2) < 1e-9, 'offsets are not halved')
  for (const [dpr, shadow] of [[1, dpr1], [2, dpr2]] as const) {
    const screen = shadow.blur * zoom * dpr
    assert.ok(screen > 15 * 0.8 && screen < 15 * 1.25, `on-screen blur ${screen} px at dpr ${dpr}, expected about 15`)
    assert.ok(shadow.ox * zoom * dpr > 3 * 0.8 && shadow.ox * zoom * dpr < 3 * 1.25, `on-screen x offset ${shadow.ox * zoom * dpr}`)
    assert.ok(shadow.oy * zoom * dpr > 5 * 0.8 && shadow.oy * zoom * dpr < 5 * 1.25, `on-screen y offset ${shadow.oy * zoom * dpr}`)
  }
})

test('planOverlays: the label blocks are measured by the measure the canvas gives, not by 0.6 em per character (#613)', () => {
  // A name that wraps at 0.6 em per character but fits on one line with a narrower font (Consolas, CJK, emoji)
  const r = agentDrawRadius(agent(0, { kind: 'teammate' }))
  const narrow = (t: string) => t.length * 11 * 0.3
  const wide = (t: string) => t.length * 11 * 0.6
  let name = ''
  for (let n = 4; n < 80 && !name; n++) {
    const probe = agent(0, { kind: 'teammate', name: 'x'.repeat(n) })
    if (layoutAgentLabel(probe, r, wide, false, null).extraLines !== layoutAgentLabel(probe, r, narrow, false, null).extraLines) name = probe.name
  }
  assert.ok(name, 'precondition: a name the two measures wrap differently')
  const lone = agent(0, { kind: 'teammate', name, x: 400 })
  const linesOf = (measureLabel?: (t: string) => number) => {
    const agents = map([lone])
    const { plan } = planOverlays({
      agents, clusters: computeClusters(agents.values()), edgeBubbles: [], transform: { x: 0, y: 0, scale: 1 },
      viewport: { w: 1200, h: 800 }, lod: lodForZoom(1), showStats: false, showCost: false, showSessionLabels: false,
      selectedAgentId: null, hoveredAgentId: null, focusedAgentId: null, simTime: 1, isBubbleHeld: () => false, measureLabel,
    } as any)
    return resolvePlacement(plan, planKey.label(lone.id), 1).extraLines
  }
  assert.equal(linesOf(wide), layoutAgentLabel(lone, r, wide, false, null).extraLines)
  assert.equal(linesOf(narrow), layoutAgentLabel(lone, r, narrow, false, null).extraLines)
  assert.notEqual(linesOf(narrow), linesOf(wide))
})
