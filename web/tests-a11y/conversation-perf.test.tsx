// #657: the Conversation panel does not pay for the whole history on every render.
// Rows are memoized, the list windows from 50 rows, scroll events are coalesced per frame, measured heights of gone ids are dropped.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, renderHook, act, cleanup } from '@testing-library/react'

import { TranscriptMessage } from '@/components/agent-visualizer/transcript-message'
import { useVirtualList } from '@/hooks/use-virtual-list'
import { VIRTUALIZE_THRESHOLD, pruneMeasuredHeights } from '@/lib/feed-utils'
import type { ConversationMessage } from '@/hooks/simulation/types'

afterEach(() => { cleanup(); document.body.replaceChildren() })

test('the virtualization threshold is between 40 and 60 rows', () => {
  assert.ok(VIRTUALIZE_THRESHOLD >= 40 && VIRTUALIZE_THRESHOLD <= 60, String(VIRTUALIZE_THRESHOLD))
})

test('TranscriptMessage is memoized', () => {
  assert.equal((TranscriptMessage as unknown as { $$typeof: symbol }).$$typeof, Symbol.for('react.memo'))
})

test('a re-render with identical props keeps the same DOM node', () => {
  const m: ConversationMessage = { id: 'r', type: 'tool_result', timestamp: 0, content: '< \x1b[31mred\x1b[0m', toolName: 'Bash' }
  const v = render(<TranscriptMessage message={m} />)
  const before = v.container.firstElementChild
  v.rerender(<TranscriptMessage message={m} />)
  assert.equal(v.container.firstElementChild, before)
})

test('pruneMeasuredHeights drops the ids that are no longer in the list', () => {
  const heights = new Map([['a', 10], ['b', 20], ['gone', 30]])
  pruneMeasuredHeights(heights, [{ id: 'a' }, { id: 'b' }])
  assert.deepEqual([...heights.keys()], ['a', 'b'])
})

test('scroll events of one frame trigger one render', () => {
  const frames: FrameRequestCallback[] = []
  const g = globalThis as unknown as { requestAnimationFrame: unknown; cancelAnimationFrame: unknown }
  const saved = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame }
  g.requestAnimationFrame = (cb: FrameRequestCallback) => frames.push(cb)
  g.cancelAnimationFrame = () => {}
  try {
    const items = Array.from({ length: 120 }, (_, i) => ({ id: `m${i}` }))
    const el = document.createElement('div')
    document.body.appendChild(el)
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return useVirtualList(items, { current: el }, { gap: 4, autoScroll: false })
    })
    const base = renders
    act(() => {
      for (let i = 1; i <= 20; i++) { el.scrollTop = i * 10; result.current.handleScroll() }
    })
    assert.equal(renders, base, 'no render before the frame')
    assert.equal(frames.length, 1, 'one frame requested for 20 events')
    act(() => { frames.splice(0).forEach(cb => cb(0)) })
    assert.equal(renders - base, 1)
  } finally {
    g.requestAnimationFrame = saved.raf
    g.cancelAnimationFrame = saved.caf
  }
})

// ─── Review of PR #666 ───────────────────────────────────────────────────────

import { fireEvent } from '@testing-library/react'
import { setTheme } from '@/lib/theme'
import { COLORS, refreshColors } from '@/lib/colors'
import { applyThemeToDocument } from '@/lib/theme-dom'
import { DEFAULT_THEME } from '@/lib/theme-tokens'
import { paletteFor } from '@/lib/theme-palette'
import { buildFeedMessages } from '@/lib/feed-utils'
import { setLocaleChoice } from '@/lib/locale'
import type { Agent } from '@/lib/agent-types'
import { ConversationHarness, createPanelRegistry } from './conversation-harness'

function cssColor(c: string): string {
  const el = document.createElement('div')
  el.style.color = c
  return el.style.color
}

test('a memoized tool row repaints with the colors of the new theme', () => {
  const other = 'contrast' as const
  assert.notEqual(paletteFor(other).toolCallBg, paletteFor(DEFAULT_THEME).toolCallBg, 'the test needs a theme with another toolCallBg')
  try {
    const m: ConversationMessage = { id: 'r', type: 'tool_result', timestamp: 0, content: '< ok', toolName: 'Read' }
    const c: ConversationMessage = { id: 'c', type: 'tool_call', timestamp: 0, content: 'Read(a)', toolName: 'Read' }
    const v = render(<><TranscriptMessage message={m} /><TranscriptMessage message={c} /></>)
    const before = v.container.innerHTML
    act(() => { setTheme(other) })
    assert.notEqual(v.container.innerHTML, before, 'inline colors changed')
    const callRow = v.container.children[1] as HTMLElement
    assert.equal(callRow.style.background, cssColor(COLORS.toolCallBg))
    assert.equal(COLORS.toolCallBg, paletteFor(other).toolCallBg)
  } finally {
    act(() => { setTheme(DEFAULT_THEME) })
    applyThemeToDocument(DEFAULT_THEME); refreshColors(DEFAULT_THEME)
  }
})

test('buildFeedMessages hands back the same row object for an unchanged message', () => {
  const a: ConversationMessage = { id: 'a', type: 'assistant', timestamp: 1, content: 'x' }
  const b: ConversationMessage = { id: 'b', type: 'assistant', timestamp: 2, content: 'y' }
  const first = buildFeedMessages(new Map([['o', [a]]]))
  const second = buildFeedMessages(new Map([['o', [a, b]]]))
  assert.equal(second[0], first[0], 'row of a kept its identity when b arrived')
  const changed = buildFeedMessages(new Map([['o', [{ ...a, content: 'z' }, b]]]))
  assert.notEqual(changed[0], first[0])
  assert.equal(changed[0].content, 'z')
  const moved = buildFeedMessages(new Map([['p', [a]]]))
  assert.equal(moved[0].agentId, 'p')
})

test('heights survive a filter: pruning follows the source history', () => {
  const history = Array.from({ length: 120 }, (_, i) => ({ id: `m${i}` }))
  const filtered = history.slice(0, 5)
  const el = document.createElement('div')
  document.body.appendChild(el)
  const { result, rerender } = renderHook(
    ({ items }) => useVirtualList(items, { current: el }, { gap: 4, autoScroll: false, pruneAgainst: history }),
    { initialProps: { items: history } },
  )
  const node = document.createElement('div')
  Object.defineProperty(node, 'offsetHeight', { value: 30 })
  act(() => { result.current.measureRef('m100', node as HTMLDivElement) })
  rerender({ items: filtered })
  rerender({ items: history })
  assert.ok(result.current.totalHeight >= 34, 'the height of m100 was kept while it was filtered out')
})

// ─── Windowed panel (jsdom has no layout: heights are stubbed) ───────────────

const agentOf = (id: string, name: string) =>
  ({ id, agentKey: id, sessionId: 's', localId: id, displayName: name, name, parentKey: null, state: 'idle', isMain: true } as unknown as Agent)

test('windowed panel: posinset continuous, setsize total, focused button stays mounted', () => {
  setLocaleChoice('en')
  const proto = HTMLElement.prototype
  const descs = {
    offsetHeight: Object.getOwnPropertyDescriptor(proto, 'offsetHeight'),
    clientHeight: Object.getOwnPropertyDescriptor(proto, 'clientHeight'),
    scrollHeight: Object.getOwnPropertyDescriptor(proto, 'scrollHeight'),
  }
  Object.defineProperty(proto, 'offsetHeight', { configurable: true, get() { return 40 } })
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get() { return 300 } })
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get() { return 6000 } })
  const g = globalThis as unknown as { requestAnimationFrame: unknown }
  const savedRaf = g.requestAnimationFrame
  const frames: FrameRequestCallback[] = []
  g.requestAnimationFrame = (cb: FrameRequestCallback) => frames.push(cb)
  try {
    const N = 120
    const msgs: ConversationMessage[] = Array.from({ length: N }, (_, i) => ({
      id: `m${i}`, type: i === 0 ? 'dispatch' : 'assistant', timestamp: i + 1,
      content: i === 0 ? 'abcdefghij'.repeat(60) : `message ${i}`,
      ...(i === 0 ? { from: 'o', to: 'o' } : {}),
    }))
    const registry = createPanelRegistry()
    const v = render(
      <ConversationHarness
        registry={registry} initialOpen conversations={new Map([['o', msgs]])}
        agents={new Map([['o', agentOf('o', 'orchestrator')]])} selectedAgentId={null} onAgentClick={() => {}}
      />,
    )
    const log = v.container.querySelector('[role="log"]') as HTMLElement
    const rows = () => [...v.container.querySelectorAll('[role="listitem"]')] as HTMLElement[]
    const pos = () => rows().map(r => Number(r.getAttribute('aria-posinset')))
    const check = (label: string) => {
      const p = pos()
      assert.ok(p.length > 0 && (label === 'bottom' || p.length < N), `${label}: windowed (${p.length} of ${N})`)
      p.forEach((n, i) => { if (i > 0) assert.equal(n, p[i - 1] + 1, `${label}: posinset continuous`) })
      rows().forEach(r => assert.equal(r.getAttribute('aria-setsize'), String(N)))
    }
    const setScroll = (top: number) => act(() => { log.scrollTop = top; fireEvent.scroll(log); frames.splice(0).forEach(cb => cb(0)) })

    act(() => { frames.splice(0).forEach(cb => cb(0)) }) // the panel's own open-time focus
    setScroll(0)
    check('top')
    assert.equal(pos()[0], 1, 'first message reachable at the top')
    const showAll = rows()[0].querySelector('button[aria-expanded]') as HTMLButtonElement | null
    assert.ok(showAll, 'the first row has a Show all button')
    act(() => showAll!.focus())
    assert.equal(document.activeElement, showAll)

    setScroll(2400)
    check('middle')
    setScroll(6000)
    check('bottom')
    assert.equal(pos()[pos().length - 1], N, 'last message reachable at the bottom')
    assert.ok(showAll!.isConnected, 'the focused button stays mounted after scrolling away')
    assert.equal(document.activeElement, showAll, 'and keeps focus')
  } finally {
    for (const [k, d] of Object.entries(descs)) {
      if (d) Object.defineProperty(proto, k, d); else delete (proto as unknown as Record<string, unknown>)[k]
    }
    g.requestAnimationFrame = savedRaf
  }
})
