// The theme applies to the interface only: what the canvas paints is identical in every theme.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { drawAgents } from '@/components/agent-visualizer/canvas/draw-agents'
import { refreshColors } from '@/lib/colors'
import { applyThemeToDocument } from '@/lib/theme-dom'
import { THEME_IDS, type ThemeId } from '@/lib/theme-tokens'

/* eslint-disable @typescript-eslint/no-explicit-any */
function recorder() {
  const log: string[] = []
  const props: any = { canvas: { width: 800, height: 600, offsetWidth: 800 }, font: '11px monospace' }
  const ctx: any = new Proxy(props, {
    get(t: any, k: string) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: s.length * 6.6 })
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop(o: number, c: string) { log.push(`stop:${o}:${c}`) } })
      return () => { log.push(`call:${k}`) }
    },
    set(t: any, k: string, v: unknown) { t[k] = v; if (/Style$|shadowColor$/.test(k)) log.push(`${k}=${String(v)}`); return true },
  })
  ;(globalThis as any).Path2D = class {}
  ;(globalThis as any).document = { ...(globalThis as any).document, createElement: () => ({ getContext: () => ctx, width: 0, height: 0 }) }
  return { ctx, log }
}

function sceneLog(theme: ThemeId): string[] {
  applyThemeToDocument(theme)
  refreshColors(theme)
  const { ctx, log } = recorder()
  const mk = (id: string, state: string, isMain: boolean): any => ({
    id, agentKey: id, sessionId: 's1', localId: id, displayName: id, name: id, state,
    parentId: null, parentKey: null, tokensUsed: 1000, tokensMax: 200000,
    contextBreakdown: { systemPrompt: 1, userMessages: 1, toolResults: 1, reasoning: 1, subagentResults: 1 },
    toolCalls: 0, timeAlive: 1, x: 100 + (isMain ? 0 : 200), y: 100, vx: 0, vy: 0, pinned: false, isMain, spawnTime: 0, opacity: 1, scale: 1,
    messageBubbles: [], lastEventAt: 1e12,
  })
  const agents = new Map([['a', mk('a', 'thinking', true)], ['b', mk('b', 'error', false)], ['c', mk('c', 'complete', false)]])
  const opts: any = { reducedMotion: true, zoom: 1, showCost: false, showStats: false, showSessionLabels: false, crowded: false, edgeBubbles: false }
  drawAgents(ctx, agents, null, null, false, 1, opts)
  return log
}

test('the canvas draws exactly the same colours in every theme', () => {
  sceneLog('neon') // warm-up: sprite caches (glows) are filled by the first draw
  const neon = sceneLog('neon')
  assert.ok(neon.some(l => l.startsWith('fillStyle=') || l.startsWith('strokeStyle=')), 'something is painted')
  for (const id of THEME_IDS) assert.deepEqual(sceneLog(id), neon, `${id} differs from neon`)
  applyThemeToDocument('neon')
  refreshColors('neon')
})
