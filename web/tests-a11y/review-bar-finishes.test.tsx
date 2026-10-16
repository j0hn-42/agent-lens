// Finitions de la barre de lecture (#383) : en revue, rien ne dit « en direct » dans la couleur du direct.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'

import { ControlBar } from '@/components/agent-visualizer/control-bar'
import { COLORS } from '@/lib/colors'
import { SelectionOverlays } from '@/components/agent-visualizer/selection-overlays'
import { SessionListPanel } from '@/components/agent-visualizer/session-list-panel'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const noop = () => {}

/** What the browser makes of a color string (jsdom normalizes rgba/hex the same way for both sides). */
function normalized(property: 'color' | 'borderColor' | 'backgroundColor', value: string): string {
  const probe = document.createElement('div')
  probe.style[property] = value
  return probe.style[property]
}

test('review: the button that resumes live is an action, not drawn in the alarming live red', () => {
  const { getByRole } = render(
    <ControlBar
      isPlaying={false} speed={1} currentTime={3} totalDuration={10} isReviewing
      onPlayPause={noop} onRestart={noop} onSpeedChange={noop} onResumeLive={noop}
      timelineEvents={[]}
    />,
  )
  const button = getByRole('button', { name: 'Resume live' })
  assert.notEqual(button.style.color, normalized('color', COLORS.liveText), 'text is not the live red')
  assert.notEqual(button.style.borderColor, normalized('borderColor', COLORS.liveResumeBorder), 'border is not the live red')
  assert.notEqual(button.style.backgroundColor, normalized('backgroundColor', COLORS.liveResumeBg), 'fill is not the live red')
})

test('live: the badge keeps the live color only while it says LIVE', () => {
  const live = render(
    <ControlBar isPlaying speed={1} currentTime={3} totalDuration={10} onPlayPause={noop} onRestart={noop} onSpeedChange={noop} timelineEvents={[]} connectionStatus="watching" />,
  )
  const label = live.container.querySelector('[data-live-badge] span:last-child') as HTMLElement
  assert.equal(label.textContent?.trim(), 'LIVE')
  assert.equal(label.style.color, normalized('color', COLORS.liveText))
})

test('canvas menu: "Zoom to fit" is spelled like everywhere else (shortcuts, palette)', () => {
  const props = {
    selection: { contextMenu: { x: 10, y: 10 }, setContextMenu: noop },
    inspector: { selectedAgent: null, selectedGone: false, goneName: null, delegation: [], toolWhy: null },
    agents: new Map(), links: new Map(), droppedMessages: new Map(),
    health: { byAgent: new Map(), bySession: new Map() },
    bridge: { relayOrigin: null, launch: null, eventLoss: null },
    selectedLinkId: null, onCloseLink: noop, onEscapeFromCard: noop,
    menuActions: { toggleStats: noop, zoomToFit: noop, toggleGrid: noop, clearHistory: noop, reloadSessionEvents: null },
  } as unknown as React.ComponentProps<typeof SelectionOverlays>
  const { getByRole, queryByRole } = render(<SelectionOverlays {...props} />)
  assert.ok(getByRole('menuitem', { name: 'Zoom to fit' }))
  assert.equal(queryByRole('menuitem', { name: 'Zoom to Fit' }), null)
})

test('session search: the placeholder fits a narrow panel and the fields searched stay readable (title)', () => {
  const { getByRole } = render(
    <SessionListPanel
      visible onClose={noop} sessions={[]} selectedSessionId="__all__" sessionsWithActivity={new Set()}
      onSelectSession={noop} onCloseSession={noop} agents={new Map()} selectedAgentId={null} onSelectAgent={noop}
      now={5000} observedSessionIds={new Set()}
    />,
  )
  const input = getByRole('searchbox', { name: 'Search sessions' }) as HTMLInputElement
  assert.ok(input.placeholder.length <= 20, `placeholder "${input.placeholder}" is cut in a narrow panel`)
  assert.ok(!input.placeholder.includes('…') && !input.placeholder.includes('..'))
  assert.match(input.title, /name, project, branch, agent/)
})
