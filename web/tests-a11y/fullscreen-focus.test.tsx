// #196: immersive full screen (Z) must not drop the focus on <body>, announces the change, exits on Escape without the
// Fullscreen API, and its exit button stays readable at rest.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'

import { AgentVisualizer } from '@/components/agent-visualizer'
import { SCENE } from '@/lib/colors'
import { resetDefaultUiPreferencesStore } from '@/hooks/use-ui-preferences'

const noopDeep = (): unknown => new Proxy(function () {}, { get: (_t, k) => (k === 'state' ? 'running' : k === 'currentTime' ? 0 : noopDeep()), apply: () => noopDeep(), set: () => true })
;(globalThis as Record<string, unknown>).AudioContext = function () { return noopDeep() }
;(globalThis as Record<string, unknown>).Path2D = class { addPath() {} moveTo() {} lineTo() {} closePath() {} }

afterEach(() => { cleanup(); document.body.replaceChildren(); resetDefaultUiPreferencesStore() })

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 50)) })

async function mount() {
  const r = render(<AgentVisualizer />)
  await settle()
  return r
}

const rgb = (hex: string): number[] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))

/** Contrast ratio of two #rrggbb colours */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = rgb(hex).map(c => c / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

test('Enter full screen by keyboard puts the focus on Exit full screen, and Exit gives it back', async () => {
  const r = await mount()
  const enter = r.getByRole('button', { name: 'Enter full screen' })
  enter.focus()
  assert.equal(document.activeElement, enter)
  await act(async () => { fireEvent.click(enter) })
  await settle()
  const exit = r.getByRole('button', { name: 'Exit full screen' })
  assert.equal(document.activeElement, exit, 'focus lands on the exit button, not <body>')
  await act(async () => { fireEvent.click(exit) })
  await settle()
  assert.equal(document.activeElement, r.getByRole('button', { name: 'Enter full screen' }), 'focus returns to the Enter button')
})

test('entering and leaving full screen is announced in the status region', async () => {
  const r = await mount()
  const status = () => Array.from(r.container.querySelectorAll('[role="status"]')).map(n => n.textContent ?? '').join(' | ')
  await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Enter full screen' })) })
  await settle()
  assert.match(status(), /Full screen on/)
  await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Exit full screen' })) })
  await settle()
  assert.match(status(), /Full screen off/)
})

test('Escape leaves immersive mode when the Fullscreen API is missing', async () => {
  const r = await mount()
  assert.equal(typeof document.documentElement.requestFullscreen, 'undefined', 'jsdom has no Fullscreen API')
  await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Enter full screen' })) })
  await settle()
  await act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }) })
  await settle()
  assert.equal(r.queryByRole('button', { name: 'Exit full screen' }), null)
  assert.ok(r.getByRole('button', { name: 'Enter full screen' }))
})

test('Escape does not leave immersive mode while a dialog is open', async () => {
  const r = await mount()
  await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Enter full screen' })) })
  await settle()
  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  const input = document.createElement('input')
  dialog.appendChild(input)
  document.body.appendChild(dialog)
  await act(async () => { fireEvent.keyDown(input, { key: 'Escape' }) })
  await settle()
  assert.ok(r.getByRole('button', { name: 'Exit full screen' }), 'still immersive')
})

test('the Exit full screen button is not faded and meets 3:1 (icon and outline) on the scene', async () => {
  const r = await mount()
  await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Enter full screen' })) })
  await settle()
  const exit = r.getByRole('button', { name: 'Exit full screen' }) as HTMLElement
  assert.doesNotMatch(exit.className, /opacity-/, 'no resting opacity')
  assert.ok(contrast(SCENE.textPrimary, SCENE.void) >= 3)
  const want = `rgb(${rgb(SCENE.textPrimary).join(', ')})`
  assert.equal(exit.style.color, want)
  assert.equal(exit.style.borderColor, want)
})
