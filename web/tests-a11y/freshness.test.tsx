// Freshness (issue #48) and listed-but-unobserved sessions (issue #52): rendering, re-render counting, axe, canvas.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act } from '@testing-library/react'
import axe from 'axe-core'

import { SessionListPanel } from '@/components/agent-visualizer/session-list-panel'
import { FreshnessAnnouncer } from '@/components/agent-visualizer/freshness-announcer'
import { drawAgents } from '@/components/agent-visualizer/canvas/draw-agents'
import { useFreshnessValue, type FreshnessClock } from '@/hooks/use-freshness-clock'
import { freshnessKey } from '@/hooks/simulation/freshness'
import { STALE_AFTER_MS, FRESHNESS_DRAW } from '@/lib/canvas-constants'
import { SESSION_NOT_OBSERVED_TEXT, SESSION_NOT_OBSERVED_HELP } from '@/lib/session-model'
import type { SessionInfo } from '@/lib/bridge-types'

afterEach(() => cleanup())

const T0 = 1_000_000_000_000
const noop = () => {}

/** A controllable clock: advance() moves time and notifies, exactly like one shared tick. */
function fakeClock(): FreshnessClock & { advance(ms: number): void } {
  let now = T0
  const listeners = new Set<() => void>()
  return {
    getNow: () => now,
    subscribe(l) { listeners.add(l); return () => { listeners.delete(l) } },
    advance(ms) { now += ms; act(() => { for (const l of [...listeners]) l() }) },
  }
}

async function axeViolations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: {
      'color-contrast': { enabled: false },
      region: { enabled: false },
      'landmark-one-main': { enabled: false },
      'page-has-heading-one': { enabled: false },
    },
  })
  return results.violations.map(v => v.id)
}

// ─── Clock: no re-render on a plain tick ─────────────────────────────────────

test('clock tick: a subscriber re-renders only when its derived value changes, not on every tick', () => {
  const clock = fakeClock()
  const agents = new Map([['a', { id: 'a', name: 'a', state: 'thinking', lastEventAt: T0 }]])
  let renders = 0
  function Probe() {
    renders++
    const key = useFreshnessValue(now => freshnessKey(agents.values(), now), clock)
    return <p data-testid="key">{key || 'all fresh'}</p>
  }
  const { getByTestId } = render(<Probe />)
  const base = renders
  for (let i = 0; i < 20; i++) clock.advance(1000) // 20 ticks, still within 30 s of T0
  assert.equal(renders, base, 'twenty ticks without a threshold crossing: zero re-renders')
  assert.equal(getByTestId('key').textContent, 'all fresh')
  clock.advance(11_000) // 31 s: crosses the stale threshold
  assert.equal(renders, base + 1, 'one re-render when the agent turns stale')
  assert.equal(getByTestId('key').textContent, 'a=stale')
  clock.advance(1000)
  assert.equal(renders, base + 1, 'stale stays stale: no further render')
})

// ─── Sessions panel ──────────────────────────────────────────────────────────

const sessions: SessionInfo[] = [
  { id: 'seen', label: 'Seen session', status: 'active', startTime: 0, lastActivityTime: 1 },
  { id: 'ghost', label: 'Ghost session', status: 'active', startTime: 0, lastActivityTime: 2 },
  { id: 'done', label: 'Done session', status: 'completed', startTime: 0, lastActivityTime: 3 },
]

function panel(extra: Partial<React.ComponentProps<typeof SessionListPanel>> = {}) {
  return (
    <SessionListPanel
      visible onClose={noop} sessions={sessions} selectedSessionId="seen" sessionsWithActivity={new Set()}
      onSelectSession={noop} onCloseSession={noop} agents={new Map()} selectedAgentId={null} onSelectAgent={noop}
      now={10_000} observedSessionIds={new Set(['seen'])} {...extra}
    />
  )
}

function rowOf(container: HTMLElement, label: string): HTMLElement {
  const btn = Array.from(container.querySelectorAll<HTMLElement>('button[data-row-main]')).find(b => b.textContent?.includes(label))
  assert.ok(btn, `row ${label}`)
  return btn
}

test('unobserved session: "listed - activity not observed", explanatory text, no activity marker', () => {
  const { container } = render(panel())
  const ghost = rowOf(container, 'Ghost session')
  assert.ok(ghost.textContent!.includes(SESSION_NOT_OBSERVED_TEXT), 'visible status text')
  assert.ok(ghost.textContent!.includes(SESSION_NOT_OBSERVED_HELP), 'accessible explanation in the accessible name')
  assert.equal(ghost.querySelector('.rounded-full'), null, 'no activity marker (dot) on an unobserved session')
  assert.equal(ghost.textContent!.includes('active,'), false, 'never announced as active')
  const seen = rowOf(container, 'Seen session')
  assert.ok(seen.querySelector('.rounded-full'), 'an observed active session keeps its marker')
  assert.equal(seen.textContent!.includes(SESSION_NOT_OBSERVED_TEXT), false)
  assert.equal(rowOf(container, 'Done session').textContent!.includes(SESSION_NOT_OBSERVED_TEXT), false, 'completed sessions are facts from disk')
})

test('unobserved session: not counted as active in the header, a live hook flag makes it observed', () => {
  const { container, rerender } = render(panel())
  assert.ok(container.textContent!.includes('1 active / 3'))
  rerender(panel({ sessionsWithActivity: new Set(['ghost']) }))
  assert.ok(container.textContent!.includes('2 active / 3'))
  assert.equal(rowOf(container, 'Ghost session').textContent!.includes(SESSION_NOT_OBSERVED_TEXT), false)
})

test('axe: sessions panel with an unobserved session and a stale agent', async () => {
  const clock = fakeClock()
  const agents = new Map([
    ['seen:main', { id: 'seen:main', sessionId: 'seen', parentKey: null, name: 'main', state: 'thinking', kind: 'main' as const, tokensUsed: 10, spawnTime: 1, lastEventAt: T0 }],
  ])
  const { container } = render(panel({ agents, freshnessClock: clock }))
  clock.advance(STALE_AFTER_MS + 1)
  assert.deepEqual(await axeViolations(container), [])
})

test('stale agent in the panel says "last known state" in words; a fresh one does not', () => {
  const clock = fakeClock()
  const agents = new Map([
    ['seen:old', { id: 'seen:old', sessionId: 'seen', parentKey: null, name: 'old', state: 'tool_calling', currentTool: 'Grep', tokensUsed: 1, spawnTime: 1, lastEventAt: T0 }],
    ['seen:new', { id: 'seen:new', sessionId: 'seen', parentKey: null, name: 'new', state: 'thinking', tokensUsed: 1, spawnTime: 2, lastEventAt: T0 + STALE_AFTER_MS }],
  ])
  const { container } = render(panel({ agents, freshnessClock: clock }))
  assert.equal(container.textContent!.includes('last known state'), false)
  clock.advance(STALE_AFTER_MS + 1)
  const text = container.textContent!
  assert.ok(text.includes('last known state: Calling tool'), 'old agent is labelled')
  assert.equal(text.includes('last known state: Thinking'), false, 'the fresh agent is not')
})

// ─── Announcer ───────────────────────────────────────────────────────────────

test('announcer: ONE polite aggregated message when agents turn stale, silent otherwise', () => {
  const clock = fakeClock()
  const mk = (id: string, at: number) => [id, { id, name: id, state: 'thinking', lastEventAt: at }] as const
  const agents = new Map([mk('alpha', T0), mk('beta', T0), mk('gamma', T0 + 20_000)])
  const { getByRole } = render(<FreshnessAnnouncer agents={agents} clock={clock} />)
  const region = getByRole('status')
  assert.equal(region.getAttribute('aria-live'), 'polite')
  assert.equal(region.textContent, '', 'baseline reading is not announced')
  clock.advance(10_000)
  assert.equal(region.textContent, '', 'nothing crossed a threshold')
  clock.advance(STALE_AFTER_MS - 9_000) // alpha and beta stale, gamma still fresh
  assert.equal(region.textContent, 'alpha, beta are no longer reporting, showing the last known state.')
  const before = region.textContent
  clock.advance(1000)
  assert.equal(region.textContent, before, 'no repeat while nothing changes')
})

// ─── Canvas ──────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Call { fn: string; text?: string; alpha: number }

function recordingContext(calls: Call[]): any {
  const alphaStack: number[] = []
  const props: Record<string, unknown> = { canvas: { width: 1, height: 1, offsetWidth: 1 }, globalAlpha: 1 }
  return new Proxy(props, {
    get(t: any, k: string) {
      if (k in t) return t[k]
      if (k === 'save') return () => { alphaStack.push(t.globalAlpha) }
      if (k === 'restore') return () => { t.globalAlpha = alphaStack.pop() ?? 1 }
      if (k === 'measureText') return (s: string) => ({ width: s.length * 6.6 })
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} })
      if (k === 'fillText') return (text: string) => { calls.push({ fn: k, text, alpha: t.globalAlpha }) }
      return (..._a: unknown[]) => { calls.push({ fn: k, alpha: t.globalAlpha }); return undefined }
    },
    set(t: any, k: string, v: unknown) { t[k] = v; return true },
  })
}

function canvasAgent(id: string, over: Record<string, unknown> = {}): any {
  return {
    id, agentKey: id, sessionId: 's1', localId: id, displayName: id, name: id, state: 'thinking', parentId: null, parentKey: null,
    tokensUsed: 1000, tokensMax: 200000,
    contextBreakdown: { systemPrompt: 1, userMessages: 1, toolResults: 1, reasoning: 1, subagentResults: 1 },
    toolCalls: 1, timeAlive: 1, x: 0, y: 0, vx: 0, vy: 0, pinned: false, isMain: false, spawnTime: 0, opacity: 1, scale: 1,
    messageBubbles: [], ...over,
  }
}

function drawOne(over: Record<string, unknown>, now: number): Call[] {
  const calls: Call[] = []
  const ctx = recordingContext(calls)
  ;(globalThis as any).Path2D = class {}
  ;(globalThis as any).document = { createElement: () => ({ getContext: () => ctx, width: 0, height: 0 }) }
  drawAgents(ctx, new Map([['s1:a', canvasAgent('s1:a', over)]]), null, null, false, 0, undefined, now)
  return calls
}

test('canvas: a stale node is dimmed and labelled "last known state: Thinking" at full opacity', () => {
  const calls = drawOne({ lastEventAt: T0 }, T0 + STALE_AFTER_MS + 1)
  const label = calls.find(c => c.fn === 'fillText' && c.text === 'last known state: Thinking')
  assert.ok(label, 'the stale text is drawn')
  assert.equal(label.alpha, 1, 'the text itself is not dimmed')
  const strokes = calls.filter(c => c.fn === 'stroke')
  assert.ok(strokes.length > 0)
  assert.ok(strokes.every(c => Math.abs(c.alpha - FRESHNESS_DRAW.staleAlpha) < 1e-9), 'node strokes use the stale alpha')
})

test('canvas: a fresh node (and a never-observed one) is neither dimmed nor labelled stale', () => {
  for (const [over, now] of [[{ lastEventAt: T0 }, T0 + STALE_AFTER_MS], [{}, T0 + 10 * STALE_AFTER_MS]] as const) {
    const calls = drawOne(over, now)
    assert.equal(calls.some(c => c.fn === 'fillText' && c.text?.startsWith('last known state')), false)
    const strokes = calls.filter(c => c.fn === 'stroke')
    assert.ok(strokes.length > 0)
    assert.ok(strokes.every(c => c.alpha === 1), 'full alpha')
  }
})
