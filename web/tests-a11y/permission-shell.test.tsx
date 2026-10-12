// #240, PR 4: the real AgentVisualizer mounts the permission requests panel inside VS Code, declares the decision
// surface and names a request's session with the label of the session list. Fails when the wiring is removed.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act } from '@testing-library/react'
import { vscodeBridge } from '@/lib/vscode-bridge'
import { setLocaleChoice } from '@/lib/locale'

import { AgentVisualizer } from '@/components/agent-visualizer'
import { resetDefaultUiPreferencesStore } from '@/hooks/use-ui-preferences'

const noopDeep = (): unknown => new Proxy(function () {}, { get: (_t, k) => (k === 'state' ? 'running' : k === 'currentTime' ? 0 : noopDeep()), apply: () => noopDeep(), set: () => true })
;(globalThis as Record<string, unknown>).AudioContext = function () { return noopDeep() }
;(globalThis as Record<string, unknown>).Path2D = class { addPath() {} moveTo() {} lineTo() {} closePath() {} }

afterEach(() => { cleanup(); document.body.replaceChildren(); resetDefaultUiPreferencesStore() })

test('inside VS Code the shell declares the surface and shows a request with its session label', async () => {
  setLocaleChoice('en')
  const sent: Array<Record<string, unknown>> = []
  // jsdom: the page is its own parent, so what the bridge posts to the extension lands here
  window.postMessage = ((m: Record<string, unknown>) => { sent.push(m) }) as typeof window.postMessage
  const r = render(<AgentVisualizer />)
  assert.ok(!sent.some(m => m.type === 'permission-surface'), 'nothing before VS Code is known')
  await act(async () => {
    vscodeBridge!.dispatch({ type: '__vscode-bridge-init' })
    vscodeBridge!.dispatch({
      type: 'session-list',
      sessions: [{ id: 'sa', label: 'payments-api', status: 'active', startTime: 1, lastActivityTime: 2, runtime: 'claude' }],
    })
  })
  assert.deepEqual(sent.filter(m => m.type === 'permission-surface'), [{ type: 'permission-surface', ready: true }])
  await act(async () => {
    vscodeBridge!.dispatch({
      type: 'permission-request',
      request: {
        sessionId: 'sa', toolUseId: 'toolu_1', nonce: '0123456789abcdef0123456789abcdef', toolName: 'Bash',
        inputPreview: '{"command":"npm test"}', inputTruncated: false, inputSha256: 'c'.repeat(64),
        requestedAt: 1_000, expiresAt: 61_000,
      },
    })
  })
  assert.ok(r.getByRole('button', { name: 'Approve Bash: npm test, session payments-api' }))
  r.unmount()
  assert.deepEqual(sent.filter(m => m.type === 'permission-surface').at(-1), { type: 'permission-surface', ready: false })
})
