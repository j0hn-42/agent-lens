// Server render of useVSCodeBridge (#67): without a window the bridge singleton is null. In relay mode the
// hook must not touch it (a crash here would break the Next.js server render of the page).
// Own file: the hook module is imported while `window` is hidden, so the singleton is built as on a server.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

test('relay mode renders on the server without a window', async () => {
  const g = globalThis as unknown as Record<string, unknown>
  const savedWindow = g.window
  delete g.window
  process.env.AGENT_LENS_STANDALONE = '1'
  try {
    assert.equal(typeof window, 'undefined')
    const { useVSCodeBridge } = await import('@/hooks/use-vscode-bridge')
    function Probe() {
      const b = useVSCodeBridge()
      return createElement('p', null, `${b.connectionStatus}:${b.reconnectAttempt}`)
    }
    assert.match(renderToString(createElement(Probe)), /connecting:0/)
  } finally {
    delete process.env.AGENT_LENS_STANDALONE
    g.window = savedWindow
  }
})
