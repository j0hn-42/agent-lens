// Burrow view, mounted whole with its pictures loaded (images stubbed, the canvas context is setup.ts's no-op one):
// axe finds nothing, Tab reaches the agent list and Enter picks an agent, the controls are named, and under reduced
// motion the scene asks for no animation frame at all (a slow timer follows the agents instead).
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React, { useState } from 'react'
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react'
import axe from 'axe-core'

import { BurrowView } from '@/components/agent-visualizer/burrow-view'
import { useUiPreferences } from '@/hooks/use-ui-preferences'
import type { Agent } from '@/lib/agent-types'
import { clusterColor } from '@/components/agent-visualizer/canvas/cluster-model'
/** Palette colour of a session, as the graph gives its halo */
const sessionColor = (id: string): string => clusterColor(`session:${id}`, [{ sessionId: id }])

const RealImage = globalThis.Image
const realMatchMedia = window.matchMedia
const realRaf = window.requestAnimationFrame
const realCaf = window.cancelAnimationFrame

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  globalThis.Image = RealImage
  window.matchMedia = realMatchMedia
  window.requestAnimationFrame = realRaf
  window.cancelAnimationFrame = realCaf
  try { localStorage.clear() } catch { /* no storage */ }
})

/** Every picture "loads" at once with a small size: the scene starts as in a browser */
class LoadedImage {
  width = 16
  height = 16
  naturalWidth = 16
  naturalHeight = 16
  complete = true
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  set src(_v: string) { setTimeout(() => this.onload?.(), 0) }
}

function agent(id: string, state: string): Agent {
  return { id, name: id, displayName: id, state, opacity: 1, x: 0, y: 0, sessionId: 's1', freshnessSource: 'live', lastEventAt: Date.now() } as unknown as Agent
}

function simulation(...list: Agent[]) {
  return { current: { agents: new Map(list.map((a) => [a.id, a])), toolCalls: new Map(), links: new Map(), discoveries: [] } }
}

const wait = (ms: number) => act(() => new Promise<void>((ok) => setTimeout(ok, ms)))

/** The page around the burrow: the selection is real state, as in the visualizer */
function Page({ sim, picks }: { sim: ReturnType<typeof simulation>; picks: string[] }) {
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <main id="visualizer-main" tabIndex={-1}>
      <BurrowView
        simulationRef={sim as never}
        selectedAgentId={selected}
        onAgentClick={(id) => { picks.push(String(id)); setSelected(id) }}
        onAgentHover={() => {}}
        focusTargetId="visualizer-main"
      />
    </main>
  )
}

/** Mounts the burrow with two agents and waits until its pictures are loaded and the agent list is filled */
async function mountLoaded(picks: string[] = []) {
  globalThis.Image = LoadedImage as never
  const view = render(<Page sim={simulation(agent('alpha', 'thinking'), agent('beta', 'idle'))} picks={picks} />)
  for (let i = 0; i < 40 && !view.container.querySelector('[data-burrow-agent-list]'); i++) await wait(25)
  assert.ok(view.container.querySelector('[data-burrow-agent-list]'), 'the agent list appears once the pictures are loaded')
  return view
}

/** The elements Tab stops on, in document order (no positive tabindex is used in the burrow) */
function tabStops(root: ParentNode): HTMLElement[] {
  const sel = 'button, [href], input, select, textarea, [tabindex]'
  return Array.from(root.querySelectorAll<HTMLElement>(sel)).filter((el) =>
    el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && !el.closest('[inert], [hidden], [aria-hidden="true"]'))
}

/** Tab as a browser does it: the focus goes to the next stop after the focused element */
function pressTab(root: ParentNode): HTMLElement {
  const stops = tabStops(root)
  const at = stops.indexOf(document.activeElement as HTMLElement)
  const next = stops[at + 1]
  assert.ok(next, 'Tab has somewhere to go')
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab' })
  act(() => { next.focus() })
  return next
}

test('axe: the mounted burrow, pictures loaded and agents listed, has no violation', async () => {
  const view = await mountLoaded()
  const region = screen.getByRole('region', { name: /Burrow|Terrier/ })
  assert.ok(region.querySelector('canvas'), 'the scene draws on a canvas')
  const results = await axe.run(view.container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
  })
  assert.deepEqual(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), [])
})

test('the region, the Room titles toggle, the Legend button and the agent list have accessible names', async () => {
  await mountLoaded()
  assert.ok(screen.getByRole('region', { name: 'Burrow: one animal per agent, one room per kind of work' }))
  const titles = screen.getByRole('button', { name: 'Room titles' })
  assert.ok(['true', 'false'].includes(titles.getAttribute('aria-pressed') ?? ''), 'the titles button is a toggle')
  const legend = screen.getByRole('button', { name: 'Legend' })
  assert.equal(legend.getAttribute('aria-expanded'), 'false')
  assert.ok(screen.getByRole('list', { name: 'Burrow agents' }))
  // the canvas and the drawn overlays are pictures only: the list is their text
  assert.equal(document.querySelector('canvas')?.getAttribute('aria-hidden'), 'true')
})

test('the Back to the graph button of a burrow whose pictures failed has an accessible name', async () => {
  globalThis.Image = class { onerror: (() => void) | null = null; set src(_v: string) { setTimeout(() => this.onerror?.(), 0) } } as never
  render(<Page sim={simulation()} picks={[]} />)
  await wait(150)
  assert.ok(screen.getByRole('button', { name: 'Back to the graph' }))
})

test('Tab goes from the burrow controls into the agent list, Enter picks the agent', async () => {
  const picks: string[] = []
  const view = await mountLoaded(picks)
  const titles = screen.getByRole('button', { name: 'Room titles' })
  titles.focus()
  assert.equal(pressTab(view.container), screen.getByRole('button', { name: 'Legend' }))
  const row = pressTab(view.container)
  const list = screen.getByRole('list', { name: 'Burrow agents' })
  assert.ok(list.contains(row), 'the next Tab stop after the legend is the agent list')
  assert.equal(row.tabIndex, 0, 'the list is one Tab stop')
  const name = row.getAttribute('title') ?? ''
  assert.match(name, /alpha|beta/)
  // a browser turns Enter on a button into a click: the list must not swallow the key first
  assert.equal(fireEvent.keyDown(row, { key: 'Enter' }), true, 'Enter is not cancelled by the list')
  fireEvent.click(row)
  assert.equal(picks.length, 1)
  assert.match(picks[0], /alpha|beta/)
  assert.equal(row.getAttribute('aria-current'), 'true', 'the picked agent is marked as the current one')
  // one Tab stop: the next Tab leaves the list instead of walking every row
  const stopsInList = tabStops(list)
  assert.equal(stopsInList.length, 1)
})

/** Counts animation frames requested by the page from now on (they run on a timer, as in a background tab) */
function spyFrames(): { count: () => number } {
  let n = 0
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => { n++; return window.setTimeout(() => act(() => { cb(performance.now()) }), 16) }) as never
  window.cancelAnimationFrame = ((id: number) => window.clearTimeout(id)) as never
  return { count: () => n }
}

function prefersReducedMotion(on: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: on && query.includes('prefers-reduced-motion'), media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as never
}

test('with motion the burrow animates on animation frames (the control for the reduced motion test)', async () => {
  prefersReducedMotion(false)
  const frames = spyFrames()
  await mountLoaded()
  const before = frames.count()
  await wait(300)
  assert.ok(frames.count() - before > 3, `frames keep coming with motion (${frames.count() - before})`)
})

test('under reduced motion the burrow requests no animation frame, also when an agent changes or one is picked', async () => {
  prefersReducedMotion(true)
  const frames = spyFrames()
  const sim = simulation(agent('alpha', 'thinking'), agent('beta', 'idle'))
  globalThis.Image = LoadedImage as never
  const picks: string[] = []
  const view = render(<Page sim={sim} picks={picks} />)
  for (let i = 0; i < 40 && !view.container.querySelector('[data-burrow-agent-list]'); i++) await wait(25)
  assert.ok(view.container.querySelector('[data-burrow-agent-list]'), 'the scene follows the agents without frames')
  await wait(300)
  const alphaRow = () => view.container.querySelector<HTMLButtonElement>('[data-burrow-agent-list] button[data-burrow-row="alpha"]')?.title ?? ''
  const before = alphaRow()
  assert.ok(before.length > 0, 'alpha has a row')
  // no event index on this simulation: only the slow timer can pick the change up, and no click resyncs it here
  sim.current.agents.set('alpha', agent('alpha', 'tool_calling'))
  await wait(600)
  assert.notEqual(alphaRow(), before, `the row follows the change without frames (${alphaRow()})`)
  fireEvent.click(screen.getAllByRole('button', { name: /alpha|beta/ })[0])
  await wait(300)
  assert.equal(frames.count(), 0, 'no requestAnimationFrame under reduced motion')
})

test('under Freeze motion the burrow requests no animation frame either', async () => {
  prefersReducedMotion(false)
  function Freeze() {
    const { prefs, setPref } = useUiPreferences()
    return <button type="button" onClick={() => setPref('freezeMotion', !prefs.freezeMotion)}>freeze</button>
  }
  globalThis.Image = LoadedImage as never
  const view = render(<><Freeze /><Page sim={simulation(agent('alpha', 'thinking'))} picks={[]} /></>)
  fireEvent.click(screen.getByText('freeze'))
  const frames = spyFrames()
  for (let i = 0; i < 40 && !view.container.querySelector('[data-burrow-agent-list]'); i++) await wait(25)
  await wait(400)
  assert.equal(frames.count(), 0, 'no requestAnimationFrame under Freeze motion')
  fireEvent.click(screen.getByText('freeze'))
})

/** Records every fillStyle the scene sets on its canvases (the setup's context draws nothing either) */
function spyFills(): { fills: Set<string>; restore: () => void } {
  const fills = new Set<string>()
  const real = window.HTMLCanvasElement.prototype.getContext
  const ctx = new Proxy({}, {
    get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 0 }) : prop === 'createLinearGradient' || prop === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {}),
    set: (_t, prop, v) => { if (prop === 'fillStyle') fills.add(String(v)); return true },
  })
  window.HTMLCanvasElement.prototype.getContext = (() => ctx) as never
  return { fills, restore: () => { window.HTMLCanvasElement.prototype.getContext = real } }
}

test('two sessions and a team: each animal stands on a ring of its cluster colour, and its row names the team', async () => {
  const spy = spyFills()
  try {
    globalThis.Image = LoadedImage as never
    const member = { ...agent('alpha', 'thinking'), teamName: 'alpha-team', teamColor: '#12ab34' } as Agent
    const other = { ...agent('beta', 'idle'), sessionId: 's2' } as Agent
    const view = render(<Page sim={simulation(member, other)} picks={[]} />)
    for (let i = 0; i < 40 && !view.container.querySelector('[data-burrow-agent-list]'); i++) await wait(25)
    await wait(300)
    assert.ok(screen.getByRole('button', { name: /^alpha: .*, team alpha-team/ }), 'the row of the member names its team')
    assert.ok(spy.fills.has('#12ab34'), 'the team colour is drawn')
    assert.ok(spy.fills.has(sessionColor('s2')), 'the other session\'s colour is drawn')
  } finally { spy.restore() }
})

test('one session and no team: no ring is drawn and no row names a team', async () => {
  const spy = spyFills()
  try {
    await mountLoaded()
    await wait(300)
    assert.equal(spy.fills.has(sessionColor('s1')), false)
    assert.equal(screen.queryAllByRole('button', { name: /team|équipe/ }).length, 0)
  } finally { spy.restore() }
})

// A click on a tool bubble opens the running tool call it names (the graph's click on a tool card); other bubbles stay transparent
test('a tool bubble that names a running call is clickable and opens it; a state bubble is not', async () => {
  globalThis.Image = LoadedImage as never
  const sim = simulation(
    { ...agent('alpha', 'tool_calling'), currentTool: 'Grep' } as Agent,
    agent('beta', 'thinking'),
  )
  sim.current.toolCalls = new Map([['tc9', { id: 'tc9', agentId: 'alpha', toolName: 'Grep', state: 'running' }]]) as never
  const opened: string[] = []
  const picks: string[] = []
  const view = render(
    <BurrowView simulationRef={sim as never} selectedAgentId={null} onAgentClick={(id) => picks.push(String(id))} onAgentHover={() => {}} onToolCallClick={(id) => opened.push(id)} />,
  )
  for (let i = 0; i < 40 && !view.container.querySelector('[data-burrow-agent-list]'); i++) await wait(25)
  await wait(100)
  const bubbles = Array.from(view.container.querySelectorAll<HTMLElement>('div[aria-hidden="true"] > div[aria-hidden="true"]'))
  const tool = bubbles.find((b) => b.textContent === 'Grep')
  assert.ok(tool, 'the tool bubble is drawn')
  assert.equal(tool.style.pointerEvents, 'auto')
  assert.equal(tool.style.cursor, 'pointer')
  assert.equal(tool.getAttribute('aria-hidden'), 'true', 'still a picture: the list row is its text')
  for (const b of bubbles) if (b !== tool) assert.equal(b.style.pointerEvents, 'none', 'a bubble without a running call is not clickable')
  fireEvent.pointerDown(tool); fireEvent.pointerUp(tool); fireEvent.click(tool)
  assert.deepEqual(opened, ['tc9'])
  assert.deepEqual(picks, [], 'the press on the bubble is not a pick on the floor')
  const row = view.container.querySelector<HTMLButtonElement>('button[data-burrow-row="alpha"]')!
  fireEvent.keyDown(row, { key: 'Enter', shiftKey: true })
  assert.deepEqual(opened, ['tc9', 'tc9'], 'Shift+Enter on its row opens the same call')
})

/** Gives every element a client size (jsdom lays nothing out): the burrow's scene is then `w` x `h` */
function withClientSize(w: number, h: number): () => void {
  const proto = HTMLElement.prototype
  const saved = ['clientWidth', 'clientHeight'].map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const)
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => w })
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => h })
  return () => { for (const [k, d] of saved) if (d) Object.defineProperty(proto, k, d) }
}

const clipped = (el: Element): boolean => el.className.includes('[clip-path:inset(50%)]')

test('portrait (a phone): the stage spans the width at the top and the agent list is shown below it, without focus, one Tab stop', async () => {
  const restore = withClientSize(390, 844)
  try {
    const view = await mountLoaded()
    const list = screen.getByRole('list', { name: 'Burrow agents' })
    assert.equal(clipped(list), false, 'the list is visible without taking the focus')
    assert.equal(list.contains(document.activeElement), false)
    const panel = list.closest<HTMLElement>('[data-burrow-list-panel]')
    assert.ok(panel, 'the list sits in its own panel, not in the control column')
    const stage = view.container.querySelector('canvas')!.parentElement as HTMLElement
    assert.equal(stage.style.width, '390px', 'the stage spans the free width')
    assert.equal(stage.style.top, '0px', 'at the top of the free area')
    assert.ok(parseFloat(panel.style.top) >= parseFloat(stage.style.height), 'the panel is under the stage')
    assert.ok(list.className.includes('overflow-y-auto'), 'a long list scrolls')
    const rows = Array.from(list.querySelectorAll<HTMLButtonElement>('button[data-burrow-row]'))
    assert.deepEqual(rows.map((b) => b.tabIndex).sort(), [-1, 0], 'still one Tab stop')
    rows.find((b) => b.tabIndex === 0)!.focus()
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    assert.equal(document.activeElement, rows[rows.length - 1], 'the arrows and Home/End still move in it')
  } finally {
    restore()
  }
})

test('landscape: the agent list stays hidden until it takes the focus', async () => {
  const restore = withClientSize(1280, 800)
  try {
    await mountLoaded()
    const list = screen.getByRole('list', { name: 'Burrow agents' })
    assert.equal(clipped(list), true)
    assert.equal(list.closest('[data-burrow-list-panel]'), null)
  } finally {
    restore()
  }
})
