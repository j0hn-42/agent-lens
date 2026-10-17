/**
 * Fixed scene drawn family by family (#381): labels, links, halos, cards, grid. Shared by the tests that pin the neon
 * look (scene-neon.test.ts) and the ones that check the scene follows the theme (scene-theme.test.ts).
 * Every draw function runs on the recording context of canvas-recorder, with reduced motion (no time-based alpha).
 */
import './canvas-recorder'
import { recordingContext, stubDocument, type DrawnOp } from './canvas-recorder'
import type { ThemeId } from '../web/lib/theme-tokens'
import { drawAgents } from '../web/components/agent-visualizer/canvas/draw-agents'
import { drawLinks, drawEdgeBubbles } from '../web/components/agent-visualizer/canvas/draw-links'
import {
  drawClusterHalos, drawTeamHalos, drawWorkspaceZones, drawPhaseLabels, drawClusterLabels, drawSessionLinks,
} from '../web/components/agent-visualizer/canvas/draw-teams'
import { drawDiscoveries, drawDiscoveryConnections } from '../web/components/agent-visualizer/canvas/draw-discoveries'
import { drawBackground } from '../web/components/agent-visualizer/background-layer'
import { computeClusters } from '../web/components/agent-visualizer/canvas/cluster-model'
import { planKey, edgeBubblePlanId } from '../web/components/agent-visualizer/canvas/overlay-plan'

stubDocument()
// The main agent's hexagon and brand mark are cached as Path2D; node has none
if (!(globalThis as { Path2D?: unknown }).Path2D) (globalThis as { Path2D?: unknown }).Path2D = class { moveTo() {} lineTo() {} closePath() {} arc() {} rect() {} roundRect() {} }

export const FAMILIES = ['labels', 'links', 'halos', 'cards', 'grid'] as const
export type Family = (typeof FAMILIES)[number]

/* eslint-disable @typescript-eslint/no-explicit-any */
function agent(over: Record<string, unknown>): any {
  const id = over.id as string
  return {
    id, agentKey: id, sessionId: 's1', localId: id, displayName: id, name: id,
    state: 'idle', parentId: null, parentKey: null, tokensUsed: 0, tokensMax: 200_000,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    toolCalls: 3, timeAlive: 12, x: 300, y: 300, vx: 0, vy: 0, pinned: false, isMain: false,
    spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [], lastEventAt: 1_000_000,
    ...over,
  }
}

const breakdown = { systemPrompt: 2000, userMessages: 3000, toolResults: 4000, reasoning: 1000, subagentResults: 500 }

export function fixtureAgents(): Map<string, any> {
  const list = [
    agent({ id: 's1:main', isMain: true, x: 300, y: 300, state: 'thinking', tokensUsed: 190_000, contextBreakdown: breakdown, model: 'claude-opus-4' }),
    agent({ id: 's1:worker', parentId: 's1:main', parentKey: 's1:main', x: 520, y: 300, state: 'tool_calling', tokensUsed: 10_500, contextBreakdown: breakdown }),
    agent({ id: 's1:mate', kind: 'teammate', teamName: 'payments', teamColor: '#eab308', x: 300, y: 520, state: 'idle', tokensUsed: 10_500, contextBreakdown: breakdown }),
    agent({ id: 's2:main', sessionId: 's2', isMain: true, x: 900, y: 300, state: 'complete', tokensUsed: 10_500, contextBreakdown: breakdown }),
  ]
  return new Map(list.map(a => [a.id, a]))
}

const opts = (theme: ThemeId | undefined, over: Record<string, unknown> = {}): any => ({
  reducedMotion: true, zoom: 1, showCost: false, showStats: true, showSessionLabels: true, ...(theme ? { theme } : {}), ...over,
})

const place = (id: string, rect: { x: number; y: number; w: number; h: number }, collapsed = false) =>
  [id, { id, dx: 0, dy: 0, rect, hidden: false, collapsed }] as const

function drawLabels(ctx: CanvasRenderingContext2D, theme?: ThemeId) {
  drawAgents(ctx, fixtureAgents(), null, 's1:worker', true, 0, opts(theme), 1_000_000)
}

function drawLinkFamily(ctx: CanvasRenderingContext2D, theme?: ThemeId) {
  const agents = fixtureAgents()
  const link = { id: 'l', from: 'main', to: 'worker', sessionId: 's1', messages: [] } as any
  const links = (['in_flight', 'recent', 'error', 'idle'] as const).map((state, i) => ({
    id: `l${i}`, link, fromKey: 's1:main', toKey: i % 2 ? 's1:worker' : 's2:main', count: 3, state, lastBackward: i === 1,
  }))
  drawLinks(ctx, links, agents, 'l0', null, 0, opts(theme))
  const bubbles = (['dispatch', 'return', 'message', 'error'] as const).map((type, i) => ({
    linkId: `l${i}`, messageId: `m${i}`, type: type === 'error' ? 'return' : type, isError: type === 'error', fromSender: true,
    lines: ['→ hello'], truncated: false, anchor: { x: 400 + i * 40, y: 300 }, w: 80, h: 24, key: `b${i}`, groupCount: 2,
  }))
  const plan = new Map(bubbles.map((b, i) => place(planKey.edgeBubble(edgeBubblePlanId(b as any)), { x: 0, y: 0, w: 80, h: 24 }, i === 3)))
  drawEdgeBubbles(ctx, bubbles as any, 'l0', null, opts(theme, { plan }))
  drawSessionLinks(ctx, [
    { key: 'sl:a>b', kind: 'task', parentClusterKey: 'a', childClusterKey: 'b', x1: 0, y1: 0, x2: 100, y2: 0 },
    { key: 'sl:a>c', kind: 'worktree', parentClusterKey: 'a', childClusterKey: 'c', x1: 0, y1: 0, x2: 0, y2: 100 },
  ] as any, opts(theme))
}

function drawHaloFamily(ctx: CanvasRenderingContext2D, theme?: ThemeId) {
  const agents = fixtureAgents()
  const clusters = computeClusters(agents.values())
  drawWorkspaceZones(ctx, [{ projectId: 'p', name: 'agent-lens', x: 0, y: 0, w: 1200, h: 800, clusterKeys: clusters.map(c => c.key), sessionCount: 2, teamCount: 0 }], opts(theme))
  drawClusterHalos(ctx, clusters, clusters[0]?.key, opts(theme))
  drawTeamHalos(ctx, [{ name: 'payments', color: '#eab308', cx: 300, cy: 400, r: 200, memberIds: ['s1:main', 's1:mate'] }], opts(theme))
  drawPhaseLabels(ctx, [{ clusterKey: clusters[0].key, phase: 'p1', text: 'Phase 1', x: 300, y: 200, memberIds: ['s1:main'] }], opts(theme))
  const plan = new Map(clusters.map((c, i) => place(planKey.cluster(c.key), { x: 10, y: 10 + i * 50, w: 240, h: 40 })))
  drawClusterLabels(ctx, clusters, plan, clusters[0]?.key, null, opts(theme))
}

function drawCardFamily(ctx: CanvasRenderingContext2D, theme?: ThemeId) {
  const agents = fixtureAgents()
  const discoveries = (['file', 'pattern', 'finding', 'code'] as const).map((type, i) => ({
    id: `d${i}`, agentId: 's1:worker', type, label: `${type} label`, content: 'web/lib/colors.ts\nline two',
    x: 600 + i * 10, y: 500 + i * 80, targetX: 600, targetY: 500, opacity: 0.9, timestamp: 0,
  }))
  drawDiscoveryConnections(ctx, discoveries, agents)
  drawDiscoveries(ctx, discoveries, agents, 'd1', opts(theme))
}

function drawGridFamily(ctx: CanvasRenderingContext2D, theme?: ThemeId) {
  drawBackground(ctx, 800, 600, [{ x: 10, y: 10, size: 1, brightness: 0.2, speed: 0, depth: 0.5 }], { x: 0, y: 0, scale: 1 }, true, 0, undefined, false)
}

const DRAW: Record<Family, (ctx: CanvasRenderingContext2D, theme?: ThemeId) => void> = {
  labels: drawLabels, links: drawLinkFamily, halos: drawHaloFamily, cards: drawCardFamily, grid: drawGridFamily,
}

/** Every call the family makes on the context, with the paint state in effect. `theme` absent: the call an old caller makes. */
export function drawFamily(family: Family, theme?: ThemeId): DrawnOp[] {
  const rec = recordingContext(1)
  DRAW[family](rec.ctx, theme)
  return rec.ops
}

/** The paint of a family as a compact list: one line per painting call (`fillText`, `stroke`, `fill`, ...) with its colour and alpha. */
export function paintOf(family: Family, theme?: ThemeId): string[] {
  const out: string[] = []
  for (const op of drawFamily(family, theme)) {
    const a = op.globalAlpha === 1 ? '' : ` a=${Number(op.globalAlpha.toFixed(4))}`
    if (op.name === 'fillText' || op.name === 'fill' || op.name === 'fillRect') out.push(`${op.name} ${op.fillStyle}${a}`)
    else if (op.name === 'stroke' || op.name === 'strokeRect' || op.name === 'strokeText') out.push(`${op.name} ${op.strokeStyle}${a}`)
  }
  return out
}
