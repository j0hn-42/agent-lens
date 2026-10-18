// 'Show finished sessions', now the 'all' value of the Show mode, lives in the preference blob (#372): the bridge reads and writes it there, the former
// standalone key is only migrated, and a change made through the preferences (Settings, reset) reaches the 'All' view.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, cleanup, act } from '@testing-library/react'

import { useVSCodeBridge } from '@/hooks/use-vscode-bridge'
import { resetDefaultUiPreferencesStore, useUiPreferences } from '@/hooks/use-ui-preferences'
import { UI_PREFS_STORAGE_KEY, parsePrefs } from '@/lib/ui-preferences'

const LEGACY_FINISHED = 'agent-lens:show-finished-sessions'

afterEach(() => {
  cleanup()
  resetDefaultUiPreferencesStore()
  window.localStorage.removeItem(LEGACY_FINISHED)
})

test('setShowFinished writes the preference blob, never the former key', async () => {
  const { result } = renderHook(() => useVSCodeBridge())
  assert.equal(result.current.showFinished, false)
  await act(async () => result.current.setShowFinished(true))
  assert.equal(result.current.showFinished, true)
  cleanup()
  resetDefaultUiPreferencesStore({ keepStorage: true }) // flushes the pending write, like a reload
  assert.equal(window.localStorage.getItem(LEGACY_FINISHED), null)
  assert.equal(parsePrefs(window.localStorage.getItem(UI_PREFS_STORAGE_KEY)).show, 'all', 'stored as the one Show mode (#372)')
  const reloaded = renderHook(() => useVSCodeBridge())
  assert.equal(reloaded.result.current.showFinished, true, 'the choice survives a reload')
})

test('a choice stored under the former key is kept (migration, no loss)', () => {
  window.localStorage.setItem(LEGACY_FINISHED, 'true')
  const { result } = renderHook(() => useVSCodeBridge())
  assert.equal(result.current.showFinished, true)
})

test('a change made through the preferences (Settings reset) reaches the bridge', async () => {
  const { result } = renderHook(() => ({ bridge: useVSCodeBridge(), ui: useUiPreferences() }))
  await act(async () => result.current.bridge.setShowFinished(true))
  assert.equal(result.current.ui.prefs.show, 'all', 'one source of truth: the Show mode')
  await act(async () => result.current.ui.resetPrefs())
  assert.equal(result.current.bridge.showFinished, false)
})
