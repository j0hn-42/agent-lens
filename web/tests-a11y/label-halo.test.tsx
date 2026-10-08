// #145: node labels get a dark outline drawn before the fill, so an edge crossing a label does not cut the letters.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { drawAgents } from '@/components/agent-visualizer/canvas/draw-agents'
import { COLORS } from '@/lib/colors'
import { ORCHESTRATOR_DRAW } from '@/lib/canvas-constants'

/* eslint-disable @typescript-eslint/no-explicit-any */
function recordingCtx() {
  const ops: Array<{ op: 'stroke' | 'fill'; text: string }> = []
  const ctx: any = new Proxy({ canvas: { width: 1, height: 1, offsetWidth: 1 }, font: '11px monospace' }, {
    get(t: any, k: string) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: s.length * 6.6 })
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} })
      if (k === 'strokeText') return (s: string) => { ops.push({ op: 'stroke', text: s }) }
      if (k === 'fillText') return (s: string) => { ops.push({ op: 'fill', text: s }) }
      return () => undefined
    },
    set(t: any, k: string, v: unknown) { t[k] = v; return true },
  })
  ;(globalThis as any).Path2D = class {}
  ;(globalThis as any).document = { createElement: () => ({ getContext: () => ctx, width: 0, height: 0 }) }
  return { ctx, ops }
}

test('the name and status lines of a node are outlined before they are filled', () => {
  const { ctx, ops } = recordingCtx()
  const agent: any = {
    id: 's1:m', agentKey: 's1:m', sessionId: 's1', localId: 'm', displayName: 'worker', name: 'worker', state: 'thinking',
    parentId: null, parentKey: null, tokensUsed: 1000, tokensMax: 200000,
    contextBreakdown: { systemPrompt: 1, userMessages: 1, toolResults: 1, reasoning: 1, subagentResults: 1 },
    toolCalls: 0, timeAlive: 1, x: 100, y: 100, vx: 0, vy: 0, pinned: false, isMain: false, spawnTime: 0, opacity: 1, scale: 1,
    messageBubbles: [], lastEventAt: Date.now(),
  }
  const opts: any = { reducedMotion: true, zoom: 1, showCost: false, showStats: false, showSessionLabels: false, crowded: false, edgeBubbles: false }
  drawAgents(ctx, new Map([['s1:m', agent]]), null, null, false, 1, opts)
  const nameFill = ops.findIndex(o => o.op === 'fill' && o.text === 'worker')
  assert.ok(nameFill >= 0, 'name drawn')
  assert.deepEqual(ops[nameFill - 1], { op: 'stroke', text: 'worker' })
})

test('the MAIN / LEAD pill of an orchestrator has a dark contour drawn before its fill (edges do not cut it)', () => {
  const log: string[] = []
  const props: any = { canvas: { width: 1, height: 1, offsetWidth: 1 }, font: '11px monospace', fillStyle: '#000', strokeStyle: '#000', lineWidth: 1 }
  const ctx: any = new Proxy(props, {
    get(t: any, k: string) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: s.length * 6.6 })
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} })
      if (k === 'roundRect') return () => { log.push('pill') }
      if (k === 'stroke') return () => { log.push(`stroke:${t.strokeStyle}`) }
      if (k === 'fill') return () => { log.push(`fill:${t.fillStyle}`) }
      return () => undefined
    },
    set(t: any, k: string, v: unknown) { t[k] = v; return true },
  })
  ;(globalThis as any).Path2D = class {}
  ;(globalThis as any).document = { createElement: () => ({ getContext: () => ctx, width: 0, height: 0 }) }
  const agent: any = {
    id: 's1:m', agentKey: 's1:m', sessionId: 's1', localId: 'm', displayName: 'main', name: 'main', state: 'thinking',
    parentId: null, parentKey: null, tokensUsed: 1000, tokensMax: 200000,
    contextBreakdown: { systemPrompt: 1, userMessages: 1, toolResults: 1, reasoning: 1, subagentResults: 1 },
    toolCalls: 0, timeAlive: 1, x: 100, y: 100, vx: 0, vy: 0, pinned: false, isMain: true, spawnTime: 0, opacity: 1, scale: 1,
    messageBubbles: [], lastEventAt: Date.now(),
  }
  const opts: any = { reducedMotion: true, zoom: 1, showCost: false, showStats: false, showSessionLabels: false, crowded: false, edgeBubbles: false }
  drawAgents(ctx, new Map([['s1:m', agent]]), null, null, false, 1, opts)
  const i = log.indexOf('pill')
  assert.ok(i >= 0, 'the pill is drawn')
  assert.match(log[i + 1], /^stroke:/, `contour first, got ${log.slice(i, i + 3).join(' ')}`)
  assert.equal(log[i + 1], `stroke:${COLORS.void}`, 'dark (void) contour')
  assert.equal(log[i + 2], `fill:${ORCHESTRATOR_DRAW.accent}`, 'then the accent fill')
})
