// The View menu of the canvas controls and the sound live in the preference blob (#372): the hooks read and write
// them there, the former standalone keys are only migrated, and 'Reset preferences' brings back their defaults.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import type { ChangeEvent } from 'react'
import { renderHook, cleanup, act } from '@testing-library/react'

import { useCanvasPreferences } from '@/hooks/use-canvas-preferences'
import { useAudioEffects } from '@/hooks/use-audio-effects'
import { resetDefaultUiPreferencesStore, useUiPreferences } from '@/hooks/use-ui-preferences'
import { UI_PREFS_STORAGE_KEY, parsePrefs } from '@/lib/ui-preferences'
import { toolExpiryConfig, TOOL_EXPIRY_S } from '@/lib/canvas-constants'

const LEGACY = ['agent-viz-pause-animations', 'agent-lens:calm-layers', 'agent-viz-never-hide', 'agent-viz-tool-expiry-s', 'agent-viz-sound']
const NO_AGENTS = new Map()
const NO_CALLS = new Map()
const select = (value: string) => ({ target: { value } }) as unknown as ChangeEvent<HTMLSelectElement>

afterEach(() => {
  cleanup()
  resetDefaultUiPreferencesStore()
  for (const k of LEGACY) window.localStorage.removeItem(k)
  toolExpiryConfig.seconds = TOOL_EXPIRY_S
})

test('the View menu writes the preference blob, never its former keys, and survives a reload', async () => {
  const { result } = renderHook(() => useCanvasPreferences())
  await act(async () => {
    result.current.toggleAnimationsPaused()
    result.current.toggleCalmLayer('links')
    result.current.toggleNeverHide()
    result.current.changeToolExpiry(select('1800'))
  })
  assert.equal(result.current.animationsPaused, true)
  assert.deepEqual(result.current.calmLayers, { background: false, links: true, agents: false, effects: false })
  assert.equal(result.current.neverHide, true)
  assert.equal(result.current.toolExpiryS, 1800)
  assert.equal(toolExpiryConfig.seconds, 1800, 'the simulation reads the new expiry')
  cleanup()
  resetDefaultUiPreferencesStore({ keepStorage: true })
  for (const k of LEGACY) assert.equal(window.localStorage.getItem(k), null, `${k} not written`)
  const stored = parsePrefs(window.localStorage.getItem(UI_PREFS_STORAGE_KEY))
  assert.deepEqual([stored.freezeMotion, stored.calmLinks, stored.pinCards, stored.toolExpiryS], [true, true, true, 1800])
  const reloaded = renderHook(() => useCanvasPreferences())
  assert.equal(reloaded.result.current.animationsPaused, true)
  assert.equal(reloaded.result.current.calmLayers.links, true)
  assert.equal(reloaded.result.current.neverHide, true)
  assert.equal(reloaded.result.current.toolExpiryS, 1800)
})

test('choices stored under the former keys are kept (migration, no loss)', () => {
  window.localStorage.setItem('agent-viz-pause-animations', '1')
  window.localStorage.setItem('agent-lens:calm-layers', '{"background":true,"effects":true}')
  window.localStorage.setItem('agent-viz-never-hide', '1')
  window.localStorage.setItem('agent-viz-tool-expiry-s', '60')
  window.localStorage.setItem('agent-viz-sound', 'on')
  const { result } = renderHook(() => ({ canvas: useCanvasPreferences(), audio: useAudioEffects(NO_AGENTS, NO_CALLS, false) }))
  assert.equal(result.current.canvas.animationsPaused, true)
  assert.deepEqual(result.current.canvas.calmLayers, { background: true, links: false, agents: false, effects: true })
  assert.equal(result.current.canvas.neverHide, true)
  assert.equal(result.current.canvas.toolExpiryS, 60)
  assert.equal(result.current.audio.isMuted, false)
})

test('the sound choice is stored in the blob, and Reset preferences resets the View menu and mutes the sound', async () => {
  const { result } = renderHook(() => ({ canvas: useCanvasPreferences(), audio: useAudioEffects(NO_AGENTS, NO_CALLS, false), ui: useUiPreferences() }))
  assert.equal(result.current.audio.isMuted, true, 'muted by default')
  await act(async () => {
    result.current.audio.handleToggleMute()
    result.current.canvas.toggleAnimationsPaused()
    result.current.canvas.toggleCalmLayer('agents')
    result.current.canvas.toggleNeverHide()
    result.current.canvas.changeToolExpiry(select('600'))
  })
  assert.equal(result.current.audio.isMuted, false)
  assert.equal(result.current.ui.prefs.soundOn, true, 'one source of truth')
  await act(async () => result.current.ui.resetPrefs())
  assert.equal(result.current.audio.isMuted, true)
  assert.equal(result.current.canvas.animationsPaused, false)
  assert.equal(result.current.canvas.calmLayers.agents, false)
  assert.equal(result.current.canvas.neverHide, false)
  assert.equal(result.current.canvas.toolExpiryS, TOOL_EXPIRY_S)
  assert.equal(toolExpiryConfig.seconds, TOOL_EXPIRY_S)
})
