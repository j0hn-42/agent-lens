// Agent label block against tool cards (#378, lot 4). The overlay plan reserved the label block at the
// width of its name / status / group lines only, while the context bar hangs under it a token line
// ("4.3k estimated / 1M tokens, window assumed") that is often wider, and the LEAD / MAIN pill line is drawn
// wider than its text. A card next to the block then covered that text and the plan never saw it.
import './canvas-recorder'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { recordingContext, stubDocument } from './canvas-recorder'
import { AGENT_DRAW, CONTEXT_BAR, ORCHESTRATOR_DRAW } from '../web/lib/canvas-constants'
import { lodForZoom } from '../web/components/agent-visualizer/canvas/draw-options'
import { drawAgents } from '../web/components/agent-visualizer/canvas/draw-agents'
import { planOverlays, planKey } from '../web/components/agent-visualizer/canvas/overlay-plan'
import { computeClusters } from '../web/components/agent-visualizer/canvas/cluster-model'
import { rectsOverlap, type Rect } from '../web/components/agent-visualizer/canvas/label-placement'
import { formatTokensOfWindow } from '../web/lib/context-window'
import { formatTokenUsage, usageFromAgent } from '../web/lib/usage'
import { layoutAgentLabel, orchestratorInfo, agentDrawRadius, hasSeveralSessions } from '../web/components/agent-visualizer/canvas/team-style'
import { computeWorkspaceZones, workspaceHeaderRect } from '../web/components/agent-visualizer/canvas/workspace-zones'
import { drawWorkspaceZones } from '../web/components/agent-visualizer/canvas/draw-teams'
import { computeFitBounds, fitContent, fitInsets, safeRect } from '../web/components/agent-visualizer/canvas/camera-fit'
import { agentLabelBlock } from '../web/components/agent-visualizer/canvas/overlay-plan'
import { estimateTextWidth } from '../web/components/agent-visualizer/canvas/edge-bubbles'
import { LOD } from '../web/lib/canvas-constants'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import { computeNextFrame } from '../web/hooks/simulation/animate'
import { createForceLayout } from '../web/hooks/simulation/force-layout'
import type { SimulationEvent } from '../web/lib/agent-types'

stubDocument()
// The main agent's hexagon is cached as a Path2D; node has none
if (!(globalThis as { Path2D?: unknown }).Path2D) (globalThis as { Path2D?: unknown }).Path2D = class { moveTo() {} lineTo() {} closePath() {} arc() {} rect() {} roundRect() {} }

/** Monospace: every glyph is 0.6 em wide, as estimateTextWidth assumes */
const mono = (text: string, px = AGENT_DRAW.labelFontSize) => text.length * px * 0.6

/* eslint-disable @typescript-eslint/no-explicit-any */
function agent(over: Record<string, unknown> = {}): any {
  const id = (over.id as string) ?? 's1:main'
  return {
    id, agentKey: id, sessionId: 's1', localId: id, displayName: 'main', name: 'main',
    state: 'idle', parentId: null, parentKey: null, tokensUsed: 4300, tokensMax: 1_000_000, tokensMaxAssumed: true,
    tokensEstimated: true,
    contextBreakdown: { systemPrompt: 4300, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    toolCalls: 0, timeAlive: 0, x: 400, y: 300, vx: 0, vy: 0, pinned: false, isMain: true,
    spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [], lastEventAt: Date.now(),
    ...over,
  }
}
const map = (...list: any[]): Map<string, any> => new Map(list.map(a => [a.id, a]))
function input(agents: Map<string, any>, over: Record<string, unknown> = {}): any {
  return {
    agents, clusters: computeClusters(agents.values()), edgeBubbles: [],
    transform: { x: 0, y: 0, scale: 1 }, viewport: { w: 1200, h: 800 }, lod: lodForZoom(1),
    showStats: false, showCost: false, showSessionLabels: false,
    selectedAgentId: null, hoveredAgentId: null, focusedAgentId: null, simTime: 1,
    isBubbleHeld: () => false,
    ...over,
  }
}

/** Screen rectangle of the token line under the context bar, as drawAContextComposition draws it (scale 1, no pan) */
function tokenLineRect(a: any, dx: number, dy: number): Rect {
  const r = agentDrawRadius(a)
  const layout = layoutAgentLabel(a, r, t => mono(t), false, orchestratorInfo(a))
  const barY = a.y + r + CONTEXT_BAR.yOffset + layout.extraLines * AGENT_DRAW.stateLabelGap
  const baseline = barY + CONTEXT_BAR.barHeight + CONTEXT_BAR.labelPadding
  const text = formatTokensOfWindow(formatTokenUsage(usageFromAgent(a)), a)
  const w = mono(text, CONTEXT_BAR.fontSize)
  return { x: a.x - w / 2 + dx, y: baseline - CONTEXT_BAR.fontSize + dy, w, h: CONTEXT_BAR.fontSize }
}

test('planOverlays: a tool card over the token line under the context bar moves, shortens or hides the label (#378)', () => {
  const a = agent()
  const agents = map(a)
  const free = planOverlays(input(agents)).plan.get(planKey.label(a.id))!
  assert.ok(free.rect && !free.hidden, 'precondition: the label is placed')
  const line = tokenLineRect(a, 0, 0)
  // A card that covers the right end of the token line, well right of the short name / status / MAIN lines
  const card: Rect = { x: line.x + line.w - 20, y: line.y - 4, w: 120, h: 28 }
  assert.ok(card.x > a.x + 60, 'precondition: the card is clear of the name, status and MAIN lines')
  const p = planOverlays(input(agents, { toolCards: [card] })).plan.get(planKey.label(a.id))!
  if (p.hidden) return
  const moved = tokenLineRect(a, p.dx, p.dy)
  assert.equal(rectsOverlap(moved, card), false, `token line ${JSON.stringify(moved)} under card ${JSON.stringify(card)} (placement ${JSON.stringify(p)})`)
})

test('planOverlays: the LEAD / MAIN pill line is reserved at its drawn width (#378)', () => {
  // A long session name makes the pill line the widest line of the block; no context bar
  const a = agent({ tokensUsed: 0, sessionLabel: 'payments-api · refactor' })
  const agents = map(a)
  const free = planOverlays(input(agents)).plan.get(planKey.label(a.id))!
  assert.ok(free.rect && !free.hidden, 'precondition: the label is placed')
  const r = agentDrawRadius(a)
  const layout = layoutAgentLabel(a, r, t => mono(t), false, orchestratorInfo(a))
  assert.ok(layout.badgeText && layout.groupLine, 'precondition: the main agent has its MAIN line')
  const rest = layout.groupLine!.slice(layout.badgeText!.length).trim()
  const drawnW = mono(layout.badgeText!, ORCHESTRATOR_DRAW.badgeFontSize) + 10 + mono(rest) + 6
  const lineY = a.y + r + AGENT_DRAW.labelYOffset + 2 * AGENT_DRAW.stateLabelGap
  const pill: Rect = { x: a.x - drawnW / 2, y: lineY - 1, w: drawnW, h: AGENT_DRAW.stateLabelGap + 1 }
  // Covers only the last 2 px of the pill line, which the text measure alone leaves out
  const card: Rect = { x: pill.x + pill.w - 2, y: lineY - 4, w: 120, h: 28 }
  assert.ok(rectsOverlap(pill, card), 'precondition: the card covers the end of the pill line')
  const p = planOverlays(input(agents, { toolCards: [card] })).plan.get(planKey.label(a.id))!
  if (p.hidden) return
  const moved = { ...pill, x: pill.x + p.dx, y: pill.y + p.dy }
  assert.ok(p.collapsed || !rectsOverlap(moved, card), `MAIN line ${JSON.stringify(moved)} under card (placement ${JSON.stringify(p)})`)
})

test('drawAgents: when the plan hides a label, its token line is not drawn alone under the card (#378)', () => {
  const a = agent()
  const plan = new Map([[planKey.label(a.id), { id: planKey.label(a.id), rect: null, hidden: true, collapsed: false, dx: 0, dy: 0 }]])
  const rec = recordingContext(1)
  drawAgents(rec.ctx, map(a), null, null, false, 0, { reducedMotion: true, zoom: 1, showCost: false, showStats: false, plan } as any)
  const token = formatTokensOfWindow(formatTokenUsage(usageFromAgent(a)), a)
  assert.equal(rec.texts.some(t => t.text === token), false, 'token line drawn without its label')
  // Without a plan the same agent draws it (the check above is not vacuous)
  const free = recordingContext(1)
  drawAgents(free.ctx, map(a), null, null, false, 0, { reducedMotion: true, zoom: 1, showCost: false, showStats: false } as any)
  assert.ok(free.texts.some(t => t.text === token), 'precondition: the token line is drawn with its label')
})

// ─── Halo titles against the workspace headers and the collapsed Conversation pill (#378, 768 px) ───
// On develop @ f2cfe19 at 768 x 1024 the title of the payments-api session (screen space) sat on the
// "Workspace payments-api" header drawn in world space just under it, and the plan did not know about the
// collapsed Conversation pill (DOM over the canvas, under the top bar): a title could land under it.

/** Two sessions of two projects, one cluster each, with the header of each workspace zone above them */
function twoProjects(): { clusters: any[]; zones: ReturnType<typeof computeWorkspaceZones> } {
  const base = computeClusters(map(agent({ id: 's1:main' })).values())[0]
  const clusters = [
    { ...base, key: 'session:s1', title: 'payments-api · refactor', cx: 400, cy: 400, r: 110, projectId: 'p1', projectName: 'payments-api', memberIds: ['s1:main'] },
    { ...base, key: 'session:s2', title: 'docs-site · Codex', cx: 400, cy: 900, r: 110, projectId: 'p2', projectName: 'docs-site', memberIds: ['s2:main'] },
  ]
  return { clusters, zones: computeWorkspaceZones(clusters) }
}
const VIEW_768 = { w: 768, h: 1024 }
const SAFE_768: Rect = { x: 0, y: 181, w: 768, h: 1024 - 181 - 110 }
/** Camera that centres the world point (400, 600) at `scale`, as a fit would */
const centred = (scale: number) => ({ x: 384 - 400 * scale, y: 560 - 600 * scale, scale })
const screenOf = (t: { x: number; y: number; scale: number }, r: Rect): Rect => ({ x: r.x * t.scale + t.x, y: r.y * t.scale + t.y, w: r.w * t.scale, h: r.h * t.scale })

/** The recording context with a font measure that differs from the plan's estimate (a real font is never exactly 0.6 em) */
function wideFontContext(zoom: number, emPerChar: number) {
  const rec = recordingContext(zoom)
  const font = () => Number(/(\d+(?:\.\d+)?)px/.exec(String(rec.ctx.font))?.[1] ?? 10)
  const ctx = new Proxy(rec.ctx as unknown as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop === 'measureText') return (s: string) => ({ width: String(s).length * font() * emPerChar })
      return target[prop]
    },
    set(target, prop, value) { target[prop] = value; return true },
  }) as unknown as CanvasRenderingContext2D
  return { ...rec, ctx }
}

test('workspaceHeaderRect: the header chip is drawn where the overlay plan reserves it, whatever the font measures (#378)', () => {
  const { zones } = twoProjects()
  for (const zoom of [0.4, 1, 1.5]) {
    for (const em of [0.5, 0.6, 0.7]) {
      const rec = wideFontContext(zoom, em)
      drawWorkspaceZones(rec.ctx, zones.slice(0, 1), { reducedMotion: true, zoom, showCost: false, showStats: false })
      // The rect the overlay plan reserves (planOverlays calls workspaceHeaderRect the same way)
      const header = workspaceHeaderRect(zones[0], zoom)
      const chip = rec.rects.find(r => Math.abs(r.y - header.y) < 1e-6 && Math.abs(r.x - header.x) < 1e-6)
      assert.ok(chip, `zoom ${zoom}, ${em} em: a chip at the reserved spot ${JSON.stringify(header)} (drawn: ${JSON.stringify(rec.rects)})`)
      assert.ok(Math.abs(chip!.w - header.w) < 1e-6 && Math.abs(chip!.h - header.h) < 1e-6, `zoom ${zoom}, ${em} em: same size`)
      // The text stays inside the chip: fillText gets the inner width as its maxWidth
      const fill = rec.ops.find(o => o.name === 'fillText')!
      assert.ok(typeof fill.args[3] === 'number' && (fill.args[3] as number) <= header.w - 2 * header.pad + 1e-6,
        `zoom ${zoom}, ${em} em: text bounded to the chip (maxWidth ${String(fill.args[3])})`)
    }
  }
})

test('planOverlays: a halo title never covers the header of a workspace zone (#378)', () => {
  const { clusters, zones } = twoProjects()
  for (const scale of [0.3, 0.4, 0.5, 0.6, 0.7]) {
    const transform = centred(scale)
    const plain = planOverlays(input(new Map(), { clusters, transform, viewport: VIEW_768, safeArea: SAFE_768, lod: lodForZoom(scale) })).plan
    const headers = zones.map(z => screenOf(transform, workspaceHeaderRect(z, scale)))
    const before = clusters.some(c => { const p = plain.get(planKey.cluster(c.key)); return p?.rect && headers.some(h => rectsOverlap(p.rect!, h)) })
    if (scale <= 0.5) assert.ok(before, `precondition at ${scale}: without the headers a title lands on one`)
    const { plan } = planOverlays(input(new Map(), { clusters, transform, viewport: VIEW_768, safeArea: SAFE_768, lod: lodForZoom(scale), workspaceZones: zones }))
    for (const c of clusters) {
      const p = plan.get(planKey.cluster(c.key))
      if (!p?.rect) continue
      for (const h of headers) assert.equal(rectsOverlap(p.rect, h), false, `zoom ${scale}: ${c.key} title ${JSON.stringify(p.rect)} on header ${JSON.stringify(h)}`)
      assert.ok(p.rect.y >= SAFE_768.y - 1e-6, `zoom ${scale}: ${c.key} title moved under the top bar (${p.rect.y})`)
    }
  }
})

test('planOverlays: a halo title never lands under the collapsed Conversation pill (#378)', () => {
  const { clusters } = twoProjects()
  // The pill as measured at 768 x 1024: left 12, top 189, 320 x 50 (canvas coordinates)
  const pill: Rect = { x: 12, y: 189, w: 320, h: 50 }
  for (const scale of [0.3, 0.4, 0.5, 0.6, 0.7]) {
    // Panned so the first title is clamped to the top of the safe area, under the pill
    const transform = { x: 300 - 400 * scale, y: 181 - 290 * scale, scale }
    const plain = planOverlays(input(new Map(), { clusters, transform, viewport: VIEW_768, safeArea: SAFE_768, lod: lodForZoom(scale) })).plan.get(planKey.cluster('session:s1'))
    assert.ok(plain?.rect && rectsOverlap(plain.rect, pill), `precondition at ${scale}: without the pill the title is under it`)
    const { plan } = planOverlays(input(new Map(), { clusters, transform, viewport: VIEW_768, safeArea: SAFE_768, lod: lodForZoom(scale), covers: [pill] }))
    const p = plan.get(planKey.cluster('session:s1'))!
    assert.ok(p.rect, 'the title is still drawn (essential)')
    assert.equal(rectsOverlap(p.rect!, pill), false, `zoom ${scale}: title ${JSON.stringify(p.rect)} under the pill`)
    assert.ok(p.rect!.y >= SAFE_768.y - 1e-6, `zoom ${scale}: title moved under the top bar`)
  }
})

test('planOverlays: a halo title never covers the Workspace header chip as drawn (#378)', () => {
  // The chip is read from what drawWorkspaceZones really draws (a font a little wider than the estimate),
  // not recomputed with workspaceHeaderRect: a plan that reserves another box than the drawn one fails here.
  const { clusters, zones } = twoProjects()
  for (const scale of [0.3, 0.4, 0.5]) {
    const transform = centred(scale)
    const rec = wideFontContext(scale, 0.65)
    drawWorkspaceZones(rec.ctx, zones, { reducedMotion: true, zoom: scale, showCost: false, showStats: false })
    const k = Math.max(1, 1 / scale)
    const drawn = zones.map(z => rec.rects.find(r => Math.abs(r.y - (z.y + 12 * k)) < 1e-6 && r.x > z.x)!)
    assert.ok(drawn.every(Boolean), `zoom ${scale}: one chip drawn per zone`)
    const headers = drawn.map(r => screenOf(transform, r))
    const plain = planOverlays(input(new Map(), { clusters, transform, viewport: VIEW_768, safeArea: SAFE_768, lod: lodForZoom(scale) })).plan
    assert.ok(clusters.some(c => { const p = plain.get(planKey.cluster(c.key)); return p?.rect && headers.some(h => rectsOverlap(p.rect!, h)) }),
      `precondition at ${scale}: without the headers a title lands on a drawn chip`)
    const { plan } = planOverlays(input(new Map(), { clusters, transform, viewport: VIEW_768, safeArea: SAFE_768, lod: lodForZoom(scale), workspaceZones: zones }))
    for (const c of clusters) {
      const p = plan.get(planKey.cluster(c.key))
      if (!p?.rect) continue
      for (const h of headers) assert.equal(rectsOverlap(p.rect, h), false, `zoom ${scale}: ${c.key} title ${JSON.stringify(p.rect)} on drawn chip ${JSON.stringify(h)}`)
    }
  }
})

test('drawWorkspaceZones: a wide-glyph (CJK) name is not squeezed by fillText maxWidth (#378)', () => {
  // Full-width glyphs are 1 em wide, not the 0.6 em the plan estimates for a Latin monospace
  const name = '支払いサービス基盤'
  const two = twoProjects()
  const zones = computeWorkspaceZones(two.clusters.map((c, i) => (i === 0 ? { ...c, projectName: name } : c)))
  const glyph = (ch: string) => (/[　-鿿]/.test(ch) ? 1 : 0.6)
  for (const zoom of [0.5, 1]) {
    const rec = recordingContext(zoom)
    const font = () => Number(/(\d+(?:\.\d+)?)px/.exec(String(rec.ctx.font))?.[1] ?? 10)
    const ctx = new Proxy(rec.ctx as unknown as Record<string | symbol, unknown>, {
      get(target, prop) {
        if (prop === 'measureText') return (s: string) => ({ width: [...String(s)].reduce((w, ch) => w + glyph(ch) * font(), 0) })
        return target[prop]
      },
      set(target, prop, value) { target[prop] = value; return true },
    }) as unknown as CanvasRenderingContext2D
    drawWorkspaceZones(ctx, zones.slice(0, 1), { reducedMotion: true, zoom, showCost: false, showStats: false })
    const fill = rec.ops.find(o => o.name === 'fillText')!
    const k = Math.max(1, 1 / zoom)
    const natural = [...String(fill.args[0])].reduce((w, ch) => w + glyph(ch) * 13 * k, 0)
    assert.ok(natural <= (fill.args[3] as number) + 1e-6, `zoom ${zoom}: "${String(fill.args[0])}" needs ${natural} px, chip gives ${String(fill.args[3])} (text squeezed)`)
  }
})

// ─── A team of 10 agents at the zoom of the automatic framing (#378) ───
// Audit of 2026-10-12: at the fit zoom the names of a 10-agent team were drawn at ~7-8 px, wrapped and covering each
// other. Lots 2 and 4 hold the labels at 11 px and thin them out; this proves it on the real chain: the events of a team,
// the force layout settled, the fit the camera computes, the overlay plan and what drawAgents draws. Every text drawn is
// read back as a screen box (affine transform tracked) and none may cover another, nor the node of another agent.
// The proof is made under the plan's width model (0.6 em per glyph); wider glyphs are checked on this layout below.

/** A 2D context that tracks the full affine transform and records the screen box of every text drawn */
function boxContext(emPerChar = 0.6) {
  type M = [number, number, number, number, number, number]
  let m: M = [1, 0, 0, 1, 0, 0]
  const stack: Array<{ m: M; values: Record<string, unknown> }> = []
  const saved = ['font', 'textAlign', 'textBaseline', 'globalAlpha', 'fillStyle'] as const
  const state: Record<string | symbol, unknown> = { font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', globalAlpha: 1, fillStyle: '#000' }
  const texts: Array<Rect & { text: string; px: number }> = []
  const mul = (n: M) => {
    const [a, b, c, d, e, f] = m
    m = [a * n[0] + c * n[1], b * n[0] + d * n[1], a * n[2] + c * n[3], b * n[2] + d * n[3], a * n[4] + c * n[5] + e, b * n[4] + d * n[5] + f]
  }
  const pt = (x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
  const fontPx = () => Number(/(\d+(?:\.\d+)?)px/.exec(String(state.font))?.[1] ?? 10)
  const methods: Record<string, (...a: any[]) => unknown> = {
    save: () => { stack.push({ m: [...m] as M, values: Object.fromEntries(saved.map(k => [k, state[k]])) }) },
    restore: () => { const top = stack.pop(); if (top) { m = top.m; Object.assign(state, top.values) } },
    translate: (x: number, y: number) => mul([1, 0, 0, 1, x, y]),
    scale: (sx: number, sy?: number) => mul([sx, 0, 0, sy ?? sx, 0, 0]),
    rotate: (r: number) => mul([Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]),
    transform: (a: number, b: number, c: number, d: number, e: number, f: number) => mul([a, b, c, d, e, f]),
    setTransform: (a: unknown, b: number, c: number, d: number, e: number, f: number) => { m = typeof a === 'number' ? [a, b, c, d, e, f] : [1, 0, 0, 1, 0, 0] },
    resetTransform: () => { m = [1, 0, 0, 1, 0, 0] },
    getTransform: () => ({ a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] }),
    measureText: (s: string) => ({ width: String(s).length * fontPx() * emPerChar }),
    fillText: (s: string, x: number, y: number) => {
      if (!(Number(state.globalAlpha) > 0.05) || !String(s).trim()) return
      const fs = fontPx(), w = String(s).length * fs * emPerChar
      const al = String(state.textAlign), bl = String(state.textBaseline)
      const x0 = al === 'center' ? x - w / 2 : al === 'right' || al === 'end' ? x - w : x
      const y0 = bl === 'top' ? y : bl === 'middle' ? y - fs / 2 : bl === 'bottom' ? y - fs : y - fs * 0.8
      const [ax, ay] = pt(x0, y0), [bx, by] = pt(x0 + w, y0 + fs)
      texts.push({ text: String(s), px: fs * Math.hypot(m[0], m[1]), x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) })
    },
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    createRadialGradient: () => ({ addColorStop: () => undefined }),
    getLineDash: () => [],
  }
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in methods) return methods[prop]
      if (prop in target) return target[prop]
      return typeof prop === 'string' ? () => undefined : undefined
    },
    set(target, prop, value) { target[prop] = value; return true },
  }) as unknown as CanvasRenderingContext2D
  return { ctx, texts }
}

/** The events of one session hosting a team of 10 (its lead and nine teammates), the force layout run until it settles */
function settledTeamOf10() {
  const layout = createForceLayout()
  let frame: SimulationState = createEmptyState()
  let t = 1
  const ctx: ProcessEventContext = {
    syncForceSimulation: () => { frame = layout.syncState(frame) },
    findToolSlot: () => ({ x: 0, y: 0 }), getContextWindowSize: () => 1_000_000, blockIdCounter: { current: 0 }, skipForceSync: false,
  }
  const names = ['api-dev', 'qa-dev', 'frontend-engineer', 'docs-writer', 'security-reviewer', 'db-migrations', 'perf-analyst', 'release-manager', 'ux-researcher']
  const events = [
    { type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true, task: 'Refactor the payments API' } },
    ...names.map(name => ({ type: 'agent_spawn', payload: { name, parent: 'orchestrator', kind: 'teammate', teamName: 'payments-squad', task: `${name} step` } })),
  ]
  for (const e of events) {
    frame = processEvent({ time: t, type: e.type, payload: e.payload, sessionId: 's1' } as SimulationEvent, { ...frame, currentTime: t }, ctx)
    t += 0.01
  }
  for (let i = 0; i < 2000 && (i < 60 || layout.active); i++) {
    const dt = 1 / 60
    const next = computeNextFrame(frame, dt, frame.currentTime + dt, Math.max(frame.maxTimeReached, frame.currentTime + dt), frame,
      { useMockData: false, mockScenarioLength: 0, mockScenarioEndTime: 0 })
    frame = layout.stepState(next)
  }
  layout.destroy()
  // The widest token line of the canvas on every agent ("4.3k estimated / 1M tokens, window assumed")
  const agents = new Map<string, any>()
  let k = 0
  for (const [id, a] of frame.agents) {
    const used = 4300 + 9000 * k++
    agents.set(id, {
      ...a, opacity: 1, scale: 1, tokensUsed: used, tokensMax: 1_000_000, tokensMaxAssumed: true, tokensEstimated: true,
      contextBreakdown: { systemPrompt: used, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    })
  }
  return { agents, teams: frame.teams }
}

/** The transform the camera's automatic framing lands on (computeFitTransform in use-canvas-camera, no focus scope) */
function autoFit(agents: Map<string, any>, clusters: any[], viewport: { width: number; height: number }, measured: { top: number; bottom: number }) {
  const measure = (text: string) => estimateTextWidth(text, AGENT_DRAW.labelFontSize)
  const showSession = hasSeveralSessions(agents.values())
  const labelBlock = (a: any) => agentLabelBlock(a, agentDrawRadius(a), measure, { showSession, orchestrator: orchestratorInfo(a), details: true })
  const input = { agents: [...agents.values()], toolCalls: [], discoveries: [], clusters, focusScope: null, zones: computeWorkspaceZones(clusters), simTime: 1 }
  const insets = fitInsets({ top: measured.top, bottom: measured.bottom, left: 0, right: 0 }, clusters.length > 0)
  const t = fitContent(s => computeFitBounds(s === null ? input : { ...input, labelBlock, labelScale: s }), viewport, insets)!
  return { t, safe: safeRect(viewport, { top: measured.top, bottom: measured.bottom, left: 0, right: 0 }) }
}

for (const [w, h, top, bottom] of [[1024, 768, 60, 110], [1440, 900, 60, 110], [768, 1024, 181, 110]] as const) {
  test(`a team of 10 at the fit zoom (${w} x ${h}): no drawn text covers another, nor another agent's node (#378)`, () => {
    const { agents, teams } = settledTeamOf10()
    assert.equal(agents.size, 10, 'precondition: ten agents')
    const clusters = computeClusters(agents.values(), teams)
    const { t, safe } = autoFit(agents, clusters, { width: w, height: h }, { top, bottom })
    const lod = lodForZoom(t.scale)
    assert.ok(lod.labels, `precondition: labels are drawn at the fit zoom ${t.scale.toFixed(3)}`)
    const { plan, hiddenAgentNames } = planOverlays({
      agents, clusters, edgeBubbles: [], transform: t, viewport: { w, h }, safeArea: safe, lod,
      showStats: false, showCost: false, showSessionLabels: false, selectedAgentId: null, hoveredAgentId: null, focusedAgentId: null,
      simTime: 1, teams, toolCards: [], workspaceZones: computeWorkspaceZones(clusters), isBubbleHeld: () => false,
    } as any)
    const draw = (withPlan: boolean, em = 0.6) => {
      const rec = boxContext(em)
      rec.ctx.translate(t.x, t.y)
      rec.ctx.scale(t.scale, t.scale)
      drawAgents(rec.ctx, agents, null, null, false, 0, { reducedMotion: true, zoom: t.scale, lod, plan: withPlan ? plan : undefined, teams, showCost: false, showStats: false, showSessionLabels: false } as any)
      // The glyph at the centre of a node is part of its shape; every other text is a label line, a pill or a token line
      return rec.texts.filter(x => [...x.text].length > 1)
    }
    const show = (r: Rect & { text?: string }) => `${r.text ? `"${r.text}" ` : ''}${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}`
    const overlaps = (texts: Array<Rect & { text: string }>) => {
      const bad: string[] = []
      for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
        if (rectsOverlap(texts[i], texts[j])) bad.push(`${show(texts[i])} covers ${show(texts[j])}`)
      }
      // A text on the disc of a node (the label of a node hangs under its disc, never on it)
      for (const a of agents.values()) {
        const r = agentDrawRadius(a) * t.scale
        const disc: Rect = { x: a.x * t.scale + t.x - r, y: a.y * t.scale + t.y - r, w: 2 * r, h: 2 * r }
        for (const x of texts) if (rectsOverlap(x, disc)) bad.push(`${show(x)} on the node of ${a.name} ${show(disc)}`)
      }
      return bad
    }
    // The check is not vacuous: without the overlay plan, the same frame draws covered texts
    assert.ok(overlaps(draw(false)).length > 0, 'precondition: without the plan the labels of the team overlap')
    const texts = draw(true)
    const names = texts.filter(x => [...agents.values()].some(a => x.text.includes(a.name)))
    // The lead and at least one teammate keep a name (the plan thins the others out, see canvas-lod.test.ts)
    assert.ok(names.length >= 2, `precondition: names are drawn at the fit zoom ${t.scale.toFixed(3)} (${names.map(n => n.text).join(', ')})`)
    for (const x of texts) assert.ok(x.px >= LOD.minTextPx - 1e-6, `"${x.text}" drawn at ${x.px.toFixed(1)} px`)
    // #594: the "N names hidden" count is the agents drawn in the safe area whose name this drawing lacks
    const inSafe = [...agents.values()].filter(a => {
      const sx = a.x * t.scale + t.x, sy = a.y * t.scale + t.y
      return sx >= safe.x && sx <= safe.x + safe.w && sy >= safe.y && sy <= safe.y + safe.h
    })
    assert.equal(inSafe.length, agents.size, 'precondition: the fit frames every agent in the safe area')
    const unnamed = inSafe.filter(a => !texts.some(x => x.text.includes(a.name))).map(a => a.name)
    assert.ok(unnamed.length > 0, 'precondition: the plan hides names at the fit zoom')
    assert.equal(hiddenAgentNames, unnamed.length, `names not drawn: ${unnamed.join(', ')}`)
    assert.deepEqual(overlaps(texts), [], `zoom ${t.scale.toFixed(3)}: drawn texts overlap`)
    // The plan reserves the texts at its estimate (0.6 em per glyph, a Latin monospace). With the glyphs measured and
    // drawn wider than that (0.7 em, then 1 em as full-width CJK), the texts of this layout still cover nothing. This
    // margin comes from the spacing of this settled layout, not from a guarantee of the plan.
    for (const em of [0.7, 1]) assert.deepEqual(overlaps(draw(true, em)), [], `glyphs drawn at ${em} em: drawn texts overlap`)
    const labels = [...agents.keys()].map(id => plan.get(planKey.label(id)))
    console.log(`  ${w} x ${h}: zoom ${t.scale.toFixed(3)}, ${texts.length} texts drawn, names: ${names.map(n => n.text).join(', ')}; `
      + `labels hidden ${labels.filter(p => p?.hidden).length}, one line ${labels.filter(p => p && !p.hidden && p.collapsed).length}`)
  })
}
