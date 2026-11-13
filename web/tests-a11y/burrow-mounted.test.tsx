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
  sim.current.agents.set('alpha', agent('alpha', 'tool_calling'))
  fireEvent.click(screen.getAllByRole('button', { name: /alpha|beta/ })[0])
  await wait(600)
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
