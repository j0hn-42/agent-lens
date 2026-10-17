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
import { layoutAgentLabel, orchestratorInfo, agentDrawRadius } from '../web/components/agent-visualizer/canvas/team-style'

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
