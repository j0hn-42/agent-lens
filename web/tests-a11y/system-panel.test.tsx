// System panel (#357): machine health gauges. Every gauge is a meter with a name, an unmeasured value is
// "Not available" (never 0), severity is stated in text and icon, and only a change of severity is announced.
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import axe from 'axe-core'

import { SystemPanel } from '@/components/agent-visualizer/system-panel'
import type { SystemSample } from '@/lib/bridge-types'
import { AgentVisualizer } from '@/components/agent-visualizer'
import { PANEL_BUTTON_IDS } from '@/components/agent-visualizer/top-bar'
import { vscodeBridge } from '@/lib/vscode-bridge'
import { resetDefaultUiPreferencesStore } from '@/hooks/use-ui-preferences'
import { clearPair } from '@/lib/pair-filter-store'

const noopDeep = (): unknown => new Proxy(function () {}, { get: (_t, k) => (k === 'state' ? 'running' : k === 'currentTime' ? 0 : noopDeep()), apply: () => noopDeep(), set: () => true })
;(globalThis as Record<string, unknown>).AudioContext = function () { return noopDeep() }
;(globalThis as Record<string, unknown>).Path2D = class { addPath() {} moveTo() {} lineTo() {} closePath() {} }

beforeEach(() => { clearPair() })
afterEach(() => { cleanup(); document.body.replaceChildren(); clearPair(); resetDefaultUiPreferencesStore() })

const noop = () => {}
const GB = 1024 ** 3

const sample = (over: Partial<SystemSample> = {}, ts = 10_000): SystemSample => ({
  ts,
  cpu: { total: 0.42, perCore: [0.4, 0.44] },
  mem: { total: 16 * GB, used: 8 * GB },
  swap: { total: 2 * GB, used: 0.5 * GB },
  disk: { total: 500 * GB, used: 200 * GB },
  load: [1.2, 0.8, 0.5],
  uptime: 5 * 3600 + 120,
  platformNote: null,
  ...over,
})

const allNull = (ts = 10_000): SystemSample => ({
  ts, cpu: { total: null, perCore: [null, null] }, mem: null, swap: null, disk: null, load: null, uptime: null, platformNote: null,
})

const memAt = (share: number, ts: number) => sample({ mem: { total: 100 * GB, used: share * 100 * GB } }, ts)

async function violations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
  })
  return results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.html).join(' | ')}`)
}

const meter = (c: HTMLElement, name: string) => c.querySelector<HTMLElement>(`[role="meter"][aria-label="${name}"]`)

test('axe: full sample, null metrics, empty buffer and unavailable states have no violations', async () => {
  for (const samples of [[sample({}, 1), sample()], [allNull()], []]) {
    const { container, unmount } = render(<SystemPanel visible samples={samples} onClose={noop} />)
    assert.deepEqual(await violations(container), [])
    unmount()
  }
  const { container } = render(<SystemPanel visible samples={[]} unavailableReason="Not available in demo mode." onClose={noop} />)
  assert.deepEqual(await violations(container), [])
})

test('the panel is a region named System; closed, it renders nothing', () => {
  const { getByRole, rerender, container } = render(<SystemPanel visible samples={[sample()]} onClose={noop} />)
  assert.ok(getByRole('region', { name: 'System' }))
  rerender(<SystemPanel visible={false} samples={[sample()]} onClose={noop} />)
  assert.equal(container.querySelector('[role="meter"]'), null)
})

test('each metric is a named meter with min, max, value and a text value stating percent and severity', () => {
  const { container } = render(<SystemPanel visible samples={[sample()]} onClose={noop} />)
  const expected: Record<string, number> = { CPU: 42, Memory: 50, Swap: 25, Disk: 40 }
  for (const [name, value] of Object.entries(expected)) {
    const m = meter(container, name)
    assert.ok(m, `${name} meter`)
    assert.equal(m.getAttribute('aria-valuemin'), '0')
    assert.equal(m.getAttribute('aria-valuemax'), '100')
    assert.equal(m.getAttribute('aria-valuenow'), String(value))
    assert.equal(m.getAttribute('aria-valuetext'), `${value} %, Normal`)
  }
  const text = container.textContent ?? ''
  assert.match(text, /8\.0 GB of 16\.0 GB/)
  assert.match(text, /Load 1 \/ 5 \/ 15/)
  assert.match(text, /1\.20 \/ 0\.80 \/ 0\.50/)
  assert.match(text, /5 h 2 min/)
})

// ARIA 1.2 requires aria-valuenow on a meter (axe: aria-required-attr): an unmeasured value is therefore no meter
// at all, only its named row saying Not available. Nothing exposes a 0, neither on screen nor to assistive tech.
const row = (c: HTMLElement, name: string) => c.querySelector<HTMLElement>(`[data-metric="${name}"]`)

test('a null metric has no meter and no aria-valuenow: its row says Not available, never 0 %', () => {
  const { container } = render(<SystemPanel visible samples={[allNull()]} onClose={noop} />)
  for (const name of ['CPU', 'Memory', 'Swap', 'Disk']) {
    const r = row(container, name)
    assert.ok(r, `${name} row`)
    assert.equal(meter(container, name), null, `${name}: no meter`)
    assert.match(r.textContent ?? '', new RegExp(`^${name}.*Not available`))
  }
  assert.equal(container.querySelector('[aria-valuenow]'), null)
  const text = container.textContent ?? ''
  assert.doesNotMatch(text, /\b0 %/)
  assert.doesNotMatch(text, /\b0(\.0)? B\b/)
  assert.match(text, /Load 1 \/ 5 \/ 15\s*Not available/)
  assert.match(text, /Uptime\s*Not available/)
  // all cores null: no per-core section at all
  assert.equal(container.querySelector('[aria-controls$="cores"]'), null)
})

test('the first CPU tick (cpu.total null) is Not available, not 0 %', () => {
  const { container } = render(<SystemPanel visible samples={[sample({ cpu: { total: null, perCore: [] } })]} onClose={noop} />)
  assert.equal(meter(container, 'CPU'), null)
  const cpu = row(container, 'CPU')!.textContent ?? ''
  assert.match(cpu, /Not available/)
  assert.doesNotMatch(cpu, /\b0 %/)
})

test('a swap of size 0 reads No swap, with no bar and no meter', () => {
  const { container } = render(<SystemPanel visible samples={[sample({ swap: { total: 0, used: 0 } })]} onClose={noop} />)
  assert.equal(meter(container, 'Swap'), null)
  assert.match(container.textContent ?? '', /Swap\s*No swap/)
})

test('warm and critical are stated in text with a distinct icon per severity', () => {
  const { container, rerender } = render(<SystemPanel visible samples={[memAt(0.86, 1)]} onClose={noop} />)
  assert.equal(meter(container, 'Memory')!.getAttribute('aria-valuetext'), '86 %, Warm')
  assert.match(row(container, 'Memory')!.textContent ?? '', /Warm/)
  const icon = (name: string) => row(container, name)!.querySelector('svg[data-severity-icon]')!
  assert.equal(icon('Memory').getAttribute('aria-hidden'), 'true')
  const warm = icon('Memory').getAttribute('data-severity-icon')
  const normal = icon('CPU').getAttribute('data-severity-icon')
  rerender(<SystemPanel visible samples={[memAt(0.96, 2)]} onClose={noop} />)
  assert.match(row(container, 'Memory')!.textContent ?? '', /Critical/)
  const critical = icon('Memory').getAttribute('data-severity-icon')
  rerender(<SystemPanel visible samples={[allNull(3)]} onClose={noop} />)
  const unknown = icon('Memory').getAttribute('data-severity-icon')
  assert.deepEqual(new Set([normal, warm, critical, unknown]).size, 4, 'four distinct icons')
})

test('each metric has a decorative sparkline and a text summary of the window', () => {
  const samples = [sample({ cpu: { total: 0.61, perCore: [] } }, 0), sample({}, 120_000)]
  const { container } = render(<SystemPanel visible samples={samples} onClose={noop} />)
  const cpu = row(container, 'CPU')!
  assert.equal(cpu.querySelector('svg[data-sparkline]')!.getAttribute('aria-hidden'), 'true')
  assert.match(cpu.textContent ?? '', /Current 42 %, max 61 % over the last 2 min/)
})

test('with a single sample the summary claims no window', () => {
  const { container } = render(<SystemPanel visible samples={[sample()]} onClose={noop} />)
  const cpu = row(container, 'CPU')!.textContent ?? ''
  assert.match(cpu, /Current 42 %/)
  assert.doesNotMatch(cpu, /over the last/)
})

test('per-core detail is closed by default and opens from its native button', () => {
  const { container, getByRole } = render(<SystemPanel visible samples={[sample()]} onClose={noop} />)
  const toggle = getByRole('button', { name: /Per-core detail/ })
  assert.equal(toggle.tagName, 'BUTTON')
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  const section = document.getElementById(toggle.getAttribute('aria-controls')!)!
  assert.ok(section.closest('[inert]'), 'closed: inert, out of the tab order')
  toggle.focus()
  assert.equal(document.activeElement, toggle)
  // Enter / Space on a native <button> fire click: the browser guarantees it, jsdom does not simulate it
  fireEvent.click(toggle)
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  assert.equal(section.closest('[inert]'), null)
  const core = meter(container, 'Core 1')!
  assert.equal(core.getAttribute('aria-valuenow'), '40')
})

test('a null core has no meter, its row says Not available', () => {
  const { container, getByRole } = render(<SystemPanel visible samples={[sample({ cpu: { total: 0.2, perCore: [0.2, null] } })]} onClose={noop} />)
  fireEvent.click(getByRole('button', { name: /Per-core detail/ }))
  assert.equal(meter(container, 'Core 2'), null)
  assert.match(row(container, 'Core 2')!.textContent ?? '', /Not available/)
})

test('no per-core section when the relay sent no core', () => {
  const { queryByRole } = render(<SystemPanel visible samples={[sample({ cpu: { total: 0.2, perCore: [] } })]} onClose={noop} />)
  assert.equal(queryByRole('button', { name: /Per-core detail/ }), null)
})

test('an empty buffer says it is waiting for the first measurement', () => {
  const { container } = render(<SystemPanel visible samples={[]} onClose={noop} />)
  assert.match(container.textContent ?? '', /Waiting for the first measurement/)
  assert.equal(container.querySelector('[role="meter"]'), null)
})

test('unavailableReason replaces the whole content', () => {
  const { container } = render(<SystemPanel visible samples={[sample()]} unavailableReason="System metrics come from the standalone relay; not available inside VS Code." onClose={noop} />)
  assert.match(container.textContent ?? '', /not available inside VS Code/)
  assert.equal(container.querySelector('[role="meter"]'), null)
  assert.doesNotMatch(container.textContent ?? '', /Waiting for the first measurement/)
})

test('platformNote is shown when present', () => {
  const { container } = render(<SystemPanel visible samples={[sample({ platformNote: 'WSL2: figures are those of the Linux VM.' })]} onClose={noop} />)
  assert.match(container.textContent ?? '', /WSL2: figures are those of the Linux VM\./)
})

test('bars do not animate under prefers-reduced-motion', () => {
  const { container } = render(<SystemPanel visible samples={[sample()]} onClose={noop} />)
  const fill = meter(container, 'CPU')!.querySelector<HTMLElement>('[data-bar-fill]')!
  assert.match(fill.className, /motion-reduce:transition-none/)
})

test('colours come from theme tokens only (no hard-coded hex)', () => {
  const src = readFileSync(join(__dirname, '../components/agent-visualizer/system-panel.tsx'), 'utf8')
  assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b/)
})

test('a polite announcement fires only when a severity changes', () => {
  const samples: SystemSample[] = []
  const { container, rerender } = render(<SystemPanel visible samples={[]} onClose={noop} />)
  const live = container.querySelector<HTMLElement>('[data-system-announcer]')!
  assert.equal(live.getAttribute('aria-live'), 'polite')
  const announced: string[] = []
  let last = live.textContent ?? ''
  const feed = (share: number) => {
    samples.push(memAt(share, samples.length * 2000))
    rerender(<SystemPanel visible samples={[...samples]} onClose={noop} />)
    const now = live.textContent ?? ''
    if (now !== last) announced.push(now)
    last = now
  }
  feed(0.10); feed(0.11); feed(0.12)
  assert.deepEqual(announced, [], 'the first normal reading is a baseline, plain samples are silent')
  feed(0.90)
  assert.deepEqual(announced, ['Memory is warm, 90 %'])
  feed(0.91)
  assert.equal(announced.length, 1, 'same severity: nothing')
  feed(0.97)
  assert.deepEqual(announced, ['Memory is warm, 90 %', 'Memory is critical, 97 %'])
  feed(0.50)
  assert.equal(announced[2], 'Memory is normal, 50 %', 'going back is announced too')
})

// ─── In the real shell: shortcut, Escape stack, focus return, non-exclusive ───

const post = (data: unknown) => vscodeBridge!.dispatch(data)
const wait = (ms = 200) => act(async () => { await new Promise(r => setTimeout(r, ms)) })
const key = (k: string) => act(async () => { fireEvent.keyDown(document.body, { key: k }) })

async function mountShell() {
  const r = render(<AgentVisualizer />)
  await act(async () => { post({ type: '__vscode-bridge-init' }) })
  await wait(100)
  return r
}

test('shell: Y opens the System panel (with the reason it is unavailable here), Escape closes it and focus returns to its button', async () => {
  const r = await mountShell()
  const button = document.getElementById(PANEL_BUTTON_IDS.system)!
  assert.equal(button.id, 'topbar-toggle-system')
  await key('y')
  await wait(50)
  const region = r.getByRole('region', { name: 'System' })
  assert.match(region.textContent ?? '', /not available/i)
  assert.equal(button.getAttribute('aria-pressed'), 'true')
  await key('Escape')
  await wait(50)
  assert.equal(r.queryByRole('region', { name: 'System' }), null)
  assert.equal(document.activeElement?.id, 'topbar-toggle-system')
})

test('shell: System is not exclusive, opening it keeps the Context panel open', async () => {
  const r = await mountShell()
  await key('p')
  await key('y')
  await wait(50)
  assert.ok(r.getByRole('region', { name: 'System' }))
  assert.equal(document.getElementById(PANEL_BUTTON_IDS.context)!.getAttribute('aria-pressed'), 'true')
})
