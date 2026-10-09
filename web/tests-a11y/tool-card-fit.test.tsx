// #111: the text of a card must be truncated with the font it is drawn in (the MCP badge uses a smaller one).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { drawToolCalls } from '@/components/agent-visualizer/canvas/draw-tool-calls'

/* eslint-disable @typescript-eslint/no-explicit-any */
function fontAwareCtx() {
  const drawn: Array<{ text: string; width: number }> = []
  const widthOf = (font: string, s: string) => s.length * parseFloat(font) * 0.6
  const ctx: any = new Proxy({ canvas: { width: 1, height: 1, offsetWidth: 1 }, font: '10px monospace' }, {
    get(t: any, k: string) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: widthOf(t.font, s) })
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} })
      if (k === 'fillText') return (s: string) => { drawn.push({ text: s, width: widthOf(t.font, s) }) }
      return () => undefined
    },
    set(t: any, k: string, v: unknown) { t[k] = v; return true },
  })
  return { ctx, drawn }
}

const opts: any = { reducedMotion: true, zoom: 1, showCost: false, showStats: false, showSessionLabels: false, crowded: false, edgeBubbles: false }

test('MCP card label fits inside its frame', () => {
  const { ctx, drawn } = fontAwareCtx()
  const tool: any = {
    id: 't1', agentId: 'a', toolName: 'mcp__github__list_issues', mcp: { server: 'github', tool: 'list_issues' },
    state: 'completed', args: 'repo: j0hn-42/agent-lens, state: open, labels: bug', x: 0, y: 0, startTime: 0, opacity: 1,
  }
  drawToolCalls(ctx, new Map([['t1', tool]]), 1, null, opts)
  const label = drawn.find(d => d.text.startsWith('list_issues'))
  assert.ok(label, 'label drawn')
  assert.ok(label.width <= 200 - 8, `label width ${label.width} must fit the 200px card`)
})
