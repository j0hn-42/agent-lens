// #245: presentation mode in the app (keyboard, accessible names, announcements, settings, masking attribute) and the
// subtitle hook (a subtitle only for a transition observed live, nothing on enabling, nothing for replayed history).
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'

import { AgentVisualizer } from '@/components/agent-visualizer'
import { PresentationSubtitle } from '@/components/agent-visualizer/presentation-subtitle'
import { usePresentationSubtitle } from '@/hooks/use-presentation'
import { PRESENTATION_STORAGE_KEY } from '@/lib/presentation'
import { resetDefaultUiPreferencesStore } from '@/hooks/use-ui-preferences'
import type { Agent } from '@/lib/agent-types'

// jsdom's storage is on window only; the app reads the bare global
Object.defineProperty(globalThis, 'localStorage', { value: window.localStorage, configurable: true })

const noopDeep = (): unknown => new Proxy(function () {}, { get: (_t, k) => (k === 'state' ? 'running' : k === 'currentTime' ? 0 : noopDeep()), apply: () => noopDeep(), set: () => true })
;(globalThis as Record<string, unknown>).AudioContext = function () { return noopDeep() }
;(globalThis as Record<string, unknown>).Path2D = class { addPath() {} moveTo() {} lineTo() {} closePath() {} }

afterEach(() => {
  cleanup(); document.body.replaceChildren(); resetDefaultUiPreferencesStore()
  try { localStorage.clear() } catch { /* storage unavailable */ }
  document.documentElement.removeAttribute('data-presentation-mask')
})

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 50)) })
async function mount() {
  const r = render(<AgentVisualizer />)
  await settle()
  return r
}
const statusText = (c: HTMLElement) => Array.from(c.querySelectorAll('[role="status"]')).map(n => n.textContent ?? '').join(' | ')
const press = async (key: string) => { await act(async () => { fireEvent.keyDown(document.body, { key }) }); await settle() }

test('V starts presentation mode: announced, with a named stop button; V stops it', async () => {
  const r = await mount()
  assert.equal(r.queryByRole('button', { name: 'Stop presentation mode' }), null, 'off at start')
  await press('v')
  assert.match(statusText(r.container), /Presentation mode on/)
  assert.ok(r.getByRole('button', { name: 'Stop presentation mode' }))
  await press('v')
  assert.match(statusText(r.container), /Presentation mode off/)
  assert.equal(r.queryByRole('button', { name: 'Stop presentation mode' }), null)
})

test('the stop button is keyboard operable and Escape also stops the mode', async () => {
  const r = await mount()
  await press('v')
  const stop = r.getByRole('button', { name: 'Stop presentation mode' })
  assert.equal(stop.tagName, 'BUTTON')
  await act(async () => { fireEvent.click(stop) })
  await settle()
  assert.equal(r.queryByRole('button', { name: 'Stop presentation mode' }), null)
  await press('v')
  await press('Escape')
  assert.equal(r.queryByRole('button', { name: 'Stop presentation mode' }), null, 'Escape leaves the mode when nothing else is open')
})

test('masking marks the document while the mode is on and clears it when it stops', async () => {
  const r = await mount()
  assert.equal(document.documentElement.hasAttribute('data-presentation-mask'), false)
  await press('v')
  assert.equal(document.documentElement.hasAttribute('data-presentation-mask'), true)
  await press('v')
  assert.equal(document.documentElement.hasAttribute('data-presentation-mask'), false)
  r.unmount()
  assert.equal(document.documentElement.hasAttribute('data-presentation-mask'), false)
})

test('with masking turned off in the options the document is not marked', async () => {
  localStorage.setItem(PRESENTATION_STORAGE_KEY, JSON.stringify({ subtitles: true, mask: false, follow: true }))
  await mount()
  await press('v')
  assert.equal(document.documentElement.hasAttribute('data-presentation-mask'), false)
})

test('the stylesheet blurs [data-sensitive] only under the mask attribute, and no text is selectable there', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'app', 'globals.css'), 'utf8')
  assert.match(css, /\[data-presentation-mask\]\s+\[data-sensitive\]/)
  assert.match(css, /user-select:\s*none/)
})

test('panels that show the content of a session carry data-sensitive (blurred under the mask)', async () => {
  const r = await mount()
  await press('f')
  const files = r.container.ownerDocument.querySelector('[data-dock-panel="files"]')
  assert.ok(files, 'Files panel is open')
  assert.equal(files!.hasAttribute('data-sensitive'), true)
  await press('c')
  const conversation = r.container.ownerDocument.querySelector('[data-dock-panel="conversation"]')
  assert.ok(conversation?.hasAttribute('data-sensitive'))
})

test('Settings has a Presentation section with named switches that persist', async () => {
  const r = await mount()
  await act(async () => { fireEvent.click(r.getByRole('button', { name: /settings/i })) })
  await settle()
  const dialog = r.getByRole('dialog')
  const section = dialog.querySelector('section[aria-label="Presentation"]') as HTMLElement
  assert.ok(section, 'Presentation section')
  for (const name of ['Subtitles of transitions', 'Mask sensitive data', 'Follow the active agent']) {
    const sw = r.getByRole('switch', { name: new RegExp(name) }) as HTMLInputElement
    assert.ok(sw, name)
    assert.equal(sw.checked, true, `${name} is on by default`)
  }
  await act(async () => { fireEvent.click(r.getByRole('switch', { name: /Mask sensitive data/ })) })
  assert.equal(JSON.parse(localStorage.getItem(PRESENTATION_STORAGE_KEY) ?? '{}').mask, false)
  await act(async () => { fireEvent.click(r.getByRole('switch', { name: /^Presentation mode/ })) })
  await settle()
  assert.ok(r.container.ownerDocument.querySelector('button[aria-label="Stop presentation mode"]'))
})

// ── Subtitle hook ─────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
function agent(over: Record<string, unknown>): Agent {
  const id = over.id as string
  return {
    id, agentKey: id, sessionId: 's1', localId: id, displayName: id, name: id, state: 'idle', parentId: null, parentKey: null,
    tokensUsed: 0, tokensMax: 1, contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    toolCalls: 0, timeAlive: 0, x: 0, y: 0, vx: 0, vy: 0, pinned: false, isMain: false, spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [],
    ...over,
  } as any
}

function Harness({ agents, enabled, mask }: { agents: Map<string, Agent>; enabled: boolean; mask: boolean }) {
  const text = usePresentationSubtitle(agents, { enabled, mask })
  return <PresentationSubtitle text={text} />
}
const mapOf = (...a: Agent[]) => new Map(a.map(x => [x.id, x]))

test('subtitle: nothing is said for the state present when the mode starts, then each live transition is', async () => {
  const start = mapOf(agent({ id: 'a', name: 'Refactor', state: 'thinking', lastEventAt: 1 }))
  const r = render(<Harness agents={start} enabled={true} mask={false} />)
  await settle()
  assert.equal(r.queryByRole('status'), null, 'no subtitle for what was already there')
  r.rerender(<Harness agents={mapOf(agent({ id: 'a', name: 'Refactor', state: 'tool_calling', currentTool: 'Read', lastEventAt: 2 }))} enabled={true} mask={false} />)
  await settle()
  assert.equal(r.getByRole('status', { name: 'Presentation subtitle' }).textContent, 'Refactor: Thinking → Calling tool Read')
})

test('subtitle: disabled, it stays empty and does not remember transitions', async () => {
  const r = render(<Harness agents={mapOf(agent({ id: 'a', state: 'thinking', lastEventAt: 1 }))} enabled={false} mask={false} />)
  r.rerender(<Harness agents={mapOf(agent({ id: 'a', state: 'complete', lastEventAt: 2 }))} enabled={false} mask={false} />)
  await settle()
  assert.equal(r.queryByRole('status'), null)
  r.rerender(<Harness agents={mapOf(agent({ id: 'a', state: 'complete', lastEventAt: 3 }))} enabled={true} mask={false} />)
  await settle()
  assert.equal(r.queryByRole('status'), null, 'enabling later says nothing about the past')
})

test('subtitle: masked, the agent is named by its role', async () => {
  const r = render(<Harness agents={mapOf(agent({ id: 'a', name: 'Secret client task', isMain: true, state: 'thinking', lastEventAt: 1 }))} enabled={true} mask={true} />)
  await settle()
  r.rerender(<Harness agents={mapOf(agent({ id: 'a', name: 'Secret client task', isMain: true, state: 'complete', lastEventAt: 2 }))} enabled={true} mask={true} />)
  await settle()
  const text = r.getByRole('status', { name: 'Presentation subtitle' }).textContent ?? ''
  assert.equal(text, 'Main agent: Thinking → Complete')
})

test('subtitle: replayed history says nothing', async () => {
  const r = render(<Harness agents={mapOf(agent({ id: 'a', state: 'thinking', lastEventAt: 1, freshnessSource: 'history' }))} enabled={true} mask={false} />)
  await settle()
  r.rerender(<Harness agents={mapOf(agent({ id: 'a', state: 'complete', lastEventAt: 2, freshnessSource: 'history' }))} enabled={true} mask={false} />)
  await settle()
  assert.equal(r.queryByRole('status'), null)
})
