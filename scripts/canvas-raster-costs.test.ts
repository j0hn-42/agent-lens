// Raster costs of the canvas (#661): what a frame pays per agent must not grow with a blur, a gradient or a
// measurement that the picture does not need. Shadows are sprites, gradients are cached, labels that the
// overlay plan hides are not measured.
import './canvas-recorder'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { recordingContext, stubDocument } from './canvas-recorder'
import { drawAgents } from '../web/components/agent-visualizer/canvas/draw-agents'
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
