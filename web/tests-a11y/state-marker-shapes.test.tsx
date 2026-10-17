// #381: in the Sessions panel the marker of an agent row has one shape per state, so a state is never told apart by its
// colour alone, nor by the pulse (gone under prefers-reduced-motion). Thinking, calling a tool and waiting for permission
// used to be the same filled disc, idle and paused the same ring.
//
// The test reads what is drawn (box size, margins, corner radius, rotation, fill, border style of each edge, glyph), not a
// name the component gives its marker: the marker is found by its place in the row (the decorative span after the tree
// prefix), and Tailwind classes, which jsdom does not apply, are translated to the CSS they stand for. So the same test,
// run on the former markup, proves the shapes were the same.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'

import { SessionListPanel } from '@/components/agent-visualizer/session-list-panel'
import type { SessionInfo } from '@/lib/bridge-types'

afterEach(() => cleanup())

const T0 = Date.now()
const noop = () => {}
const STATES = ['idle', 'thinking', 'tool_calling', 'waiting_permission', 'paused', 'complete', 'error'] as const
type State = (typeof STATES)[number]
const sessions: SessionInfo[] = [{ id: 's', label: 'Session', status: 'active', startTime: 0, lastActivityTime: 1 }]
/** Width of the marker slot: the ✓ and ✕ glyphs are 12 px wide (w-3), a box marker must not take more. */
const SLOT_PX = 12

function renderPanel() {
  const agents = new Map(STATES.map((state, i) => [`s:${state}`, {
    id: `s:${state}`, sessionId: 's', parentKey: null, name: `agent-${state}`, state, tokensUsed: 1, spawnTime: i + 1, lastEventAt: T0,
  }] as const))
  return render(
    <SessionListPanel
      visible onClose={noop} sessions={sessions} selectedSessionId="s" sessionsWithActivity={new Set()}
      onSelectSession={noop} onCloseSession={noop} agents={agents} selectedAgentId={null} onSelectAgent={noop}
      now={T0} observedSessionIds={new Set(['s'])}
    />,
  )
}

function markerOf(container: HTMLElement, state: string): HTMLElement {
  const row = Array.from(container.querySelectorAll<HTMLElement>('ul[aria-label^="Agents of"] button')).find(b => b.textContent?.includes(`agent-${state}`))
  assert.ok(row, `row of the ${state} agent`)
  // The name cell starts with the tree prefix (└, decorative) then the marker (decorative)
  const marker = row.querySelectorAll<HTMLElement>(':scope > span:first-child > span[aria-hidden="true"]')[1]
  assert.ok(marker, `${state}: the row has a state marker`)
  return marker
}

/** CSS of the Tailwind utilities a marker may use (jsdom loads no stylesheet). */
const TW_PX: Record<string, Partial<Record<'width' | 'height' | 'margin', number>>> = {
  'w-2': { width: 8 }, 'h-2': { height: 8 }, 'w-2.5': { width: 10 }, 'h-2.5': { height: 10 }, 'w-3': { width: 12 },
  'mx-0.5': { margin: 2 }, 'mx-px': { margin: 1 },
}

interface Look { width: number; height: number; margin: number; radius: string; transform: string; fill: string; edges: string; glyph: string }

function lookOf(m: HTMLElement): Look {
  const cls = m.className.split(/\s+/)
  const fromClass = (key: 'width' | 'height' | 'margin') => cls.reduce((v, c) => TW_PX[c]?.[key] ?? v, 0)
  const px = (inline: string, key: 'width' | 'height' | 'margin') => (inline ? parseFloat(inline) : fromClass(key))
  const s = m.style
  const radius = s.borderRadius || (cls.includes('rounded-full') ? '50%' : '0')
  const transform = s.transform || (cls.some(c => /^-?rotate-/.test(c)) ? cls.find(c => /^-?rotate-/.test(c))! : 'none')
  const edges = (['Top', 'Right', 'Bottom', 'Left'] as const).map(e => s.getPropertyValue(`border-${e.toLowerCase()}-style`) || 'none').join(' ')
  const fill = s.background === 'transparent' || s.backgroundColor === 'transparent' ? 'hollow' : (s.background || s.backgroundColor) ? 'filled' : 'none'
  return {
    width: px(s.width, 'width'), height: px(s.height, 'height'), margin: px(s.marginLeft, 'margin'),
    radius: radius === '9999px' ? '50%' : radius, transform, fill, edges, glyph: m.textContent ?? '',
  }
}

const show = (l: Look) => `${l.glyph || `${l.width}x${l.height} r=${l.radius} t=${l.transform} ${l.fill} [${l.edges}]`}`

function looks(): Record<State, Look> {
  const { container } = renderPanel()
  return Object.fromEntries(STATES.map(s => [s, lookOf(markerOf(container, s))])) as Record<State, Look>
}

test('every agent state has its own marker, as drawn (WCAG 1.4.1)', () => {
  const all = looks()
  const drawn = Object.fromEntries(STATES.map(s => [s, show(all[s])]))
  assert.equal(new Set(Object.values(drawn)).size, STATES.length, `one drawn shape per state: ${JSON.stringify(drawn)}`)
})

test('two box markers never differ only by their corners or a rotation (low vision, 8 to 10 px marks)', () => {
  const all = looks()
  const boxes = STATES.filter(s => !all[s].glyph)
  for (const [i, a] of boxes.entries()) {
    for (const b of boxes.slice(i + 1)) {
      const la = all[a], lb = all[b]
      const clear = la.fill !== lb.fill || la.edges !== lb.edges || Math.abs(la.width - lb.width) >= 2 || Math.abs(la.height - lb.height) >= 2
      assert.ok(clear, `${a} (${show(la)}) and ${b} (${show(lb)}) must differ by fill, border or size, not only by corners or rotation`)
    }
  }
  // Explicit pairs of the issue
  assert.notEqual(all.idle.fill, all.thinking.fill, 'idle is a ring, thinking a disc')
  assert.notEqual(show(all.idle), show(all.paused))
})

test('a box marker fits its 12 px slot, unrotated, so it never spills over the name', () => {
  const all = looks()
  for (const state of STATES.filter(s => !all[s].glyph)) {
    const l = all[state]
    assert.equal(l.transform, 'none', `${state}: a rotated box overflows its own box`)
    assert.ok(l.width + 2 * l.margin <= SLOT_PX && l.height <= SLOT_PX, `${state}: ${l.width}x${l.height} + ${l.margin}px margins fits ${SLOT_PX}px`)
  }
})

test('waiting for permission is a dashed ring, as on the canvas; idle a plain ring', () => {
  const all = looks()
  assert.equal(all.waiting_permission.radius, '50%', 'round')
  assert.equal(all.waiting_permission.fill, 'hollow', 'not filled')
  assert.equal(all.waiting_permission.edges, 'dashed dashed dashed dashed', 'dashed outline')
  assert.equal(all.idle.edges, 'solid solid solid solid')
})
