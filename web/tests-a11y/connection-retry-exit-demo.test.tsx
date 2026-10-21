// #371: the offline state shows the reconnect detail and a "Retry now" button; the DEMO badge has a way out.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import axe from 'axe-core'

import { TopBar, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { openMore } from './topbar-more'

const noop = () => {}
afterEach(() => { cleanup(); document.body.replaceChildren() })

function topBar(extra: Partial<TopBarProps> = {}) {
  return (
    <TopBar
      sessions={[]} selectedSessionId="__all__" sessionsWithActivity={new Set()} showSessions={false} onToggleSessions={noop}
      isVSCode={false} connectionStatus="disconnected" activeAgentCount={0} doneAgentCount={0} totalTokens={0} totalCost={0}
      showFileAttention={false} showConversation={false} showCostOverlay={false} showTimeline={false} showStats={false} isMuted={false}
      onTogglePanel={noop} onToggleTimeline={noop} onToggleStats={noop} onToggleMute={noop} onOpenShortcuts={noop} {...extra}
    />
  )
}

const DETAIL = 'reconnecting (attempt 2, retry in 10s)'

test('offline: the detail is written, in the tooltip, and "Retry now" is a named button that calls back', () => {
  let retried = 0
  const { getByTestId, getByRole, getByText, container } = render(topBar({ connectionDetail: DETAIL, onRetryConnection: () => { retried++ } }))
  // One-line bar: the detail is written in More, which carries the alert mark and reads it in its description
  const more = container.querySelector('#topbar-more')!
  assert.ok(container.querySelector('[data-more-mark="alert"]'), 'More carries the alert mark')
  const described = (more.getAttribute('aria-describedby') ?? '').split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' ')
  assert.match(described, /attempt 2, retry in 10s/)
  openMore()
  assert.equal(getByTestId('connection-detail').textContent, DETAIL)
  assert.match(getByText('OFFLINE').closest('[title]')!.getAttribute('title')!, /attempt 2, retry in 10s/)
  fireEvent.click(getByRole('button', { name: 'Retry now' }))
  assert.equal(retried, 1)
})

test('no retry button or detail when connected, connecting or in demo', () => {
  for (const props of [{ connectionStatus: 'connected' }, { connectionStatus: 'connecting' }, { connectionStatus: 'disconnected', isDemo: true }] as Partial<TopBarProps>[]) {
    const { queryByRole, queryByTestId, unmount } = render(topBar({ ...props, connectionDetail: DETAIL, onRetryConnection: noop }))
    openMore()
    assert.equal(queryByRole('button', { name: 'Retry now' }), null)
    assert.equal(queryByTestId('connection-detail'), null)
    unmount()
  }
})

test('demo: "Exit demo" is offered next to DEMO only in demo and calls back', () => {
  let left = 0
  const demo = render(topBar({ isDemo: true, onExitDemo: () => { left++ } }))
  const exit = demo.getByRole('button', { name: 'Exit demo' })
  exit.focus()
  fireEvent.click(exit)
  assert.notEqual(document.activeElement, document.body, 'focus moves to the label, not lost')
  assert.equal(left, 1)
  demo.unmount()
  const live = render(topBar({ connectionStatus: 'watching', onExitDemo: () => { left++ } }))
  assert.equal(live.queryByRole('button', { name: 'Exit demo' }), null)
})

test('axe: the offline indicator with its button has no violation', async () => {
  const { container } = render(topBar({ connectionDetail: DETAIL, onRetryConnection: noop }))
  const res = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
  assert.deepEqual(res.violations.map(v => v.id), [])
})
