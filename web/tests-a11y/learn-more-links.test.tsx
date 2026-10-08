// #129: the empty state and the graph legend point to the "Reading the UI" documentation.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'

import { AgentVisualizer } from '@/components/agent-visualizer'
import { GraphLegend } from '@/components/agent-visualizer/graph-legend'
import { DOCS_READING_THE_UI_URL } from '@/lib/docs-links'

const noopDeep = (): unknown => new Proxy(function () {}, { get: (_t, k) => (k === 'state' ? 'running' : k === 'currentTime' ? 0 : noopDeep()), apply: () => noopDeep(), set: () => true })
;(globalThis as Record<string, unknown>).AudioContext = function () { return noopDeep() }
;(globalThis as Record<string, unknown>).Path2D = class { addPath() {} moveTo() {} lineTo() {} closePath() {} }

afterEach(() => { cleanup(); document.body.replaceChildren(); try { window.localStorage.clear() } catch { /* ignore */ } })

test('the docs URL targets the fork and the reading guide', () => {
  assert.match(DOCS_READING_THE_UI_URL, /^https:\/\/github\.com\/j0hn-42\/agent-lens\/blob\/[^/]+\/docs\/reading-the-ui\.md$/)
})

test('the open legend links to the reading guide', async () => {
  const { container, getByRole } = render(<GraphLegend />)
  const toggle = container.querySelector('button')!
  await act(async () => { fireEvent.click(toggle) })
  const link = getByRole('link', { name: /learn more/i }) as HTMLAnchorElement
  assert.equal(link.getAttribute('href'), DOCS_READING_THE_UI_URL)
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer')
})

test('the empty state links to the reading guide', async () => {
  const previous = process.env.NEXT_PUBLIC_DEMO
  process.env.NEXT_PUBLIC_DEMO = '0' // live mode, no mock data: the empty state
  let r: ReturnType<typeof render>
  try {
    r = render(<AgentVisualizer />)
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_DEMO
    else process.env.NEXT_PUBLIC_DEMO = previous
  }
  await act(async () => { await new Promise(res => setTimeout(res, 100)) })
  assert.ok(r.container.textContent?.includes('Waiting for an agent session'), 'harness shows the empty state')
  const link = r.getByRole('link', { name: /learn more/i }) as HTMLAnchorElement
  assert.equal(link.getAttribute('href'), DOCS_READING_THE_UI_URL)
})
