// Offline fallback of useVSCodeBridge (#67): outside relay mode the 1500 ms "disconnected" fallback must not
// override a status the VS Code bridge delivered in the meantime. Own file: the bridge singleton cannot
// leave VS Code mode once it entered it.
import { test, afterEach, beforeEach, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, cleanup, act } from '@testing-library/react'

import { useVSCodeBridge } from '@/hooks/use-vscode-bridge'

const post = (data: unknown) =>
  window.dispatchEvent(new (window as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent('message', { data }))

beforeEach(() => {
  delete process.env.AGENT_LENS_STANDALONE
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
})
afterEach(() => { cleanup(); mock.timers.reset() })

test('a connected status delivered by VS Code before 1500 ms survives the fallback', async () => {
  const { result } = renderHook(() => useVSCodeBridge())
  await act(async () => { mock.timers.tick(1000) })
  await act(async () => post({ type: '__vscode-bridge-init' }))
  await act(async () => post({ type: 'connection-status', status: 'connected', source: 'test' }))
  assert.equal(result.current.connectionStatus, 'connected')
  await act(async () => { mock.timers.tick(5000) })
  assert.equal(result.current.connectionStatus, 'connected')
})
