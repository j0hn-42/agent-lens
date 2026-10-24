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
  // Drawn like the other neutral actions of the bar
  assert.equal(button.style.color, normalized('color', COLORS.textPrimary))
  assert.equal(button.style.borderColor, normalized('borderColor', COLORS.controlBorder))
  assert.equal(button.style.backgroundColor, normalized('backgroundColor', COLORS.holoBg10))
})

test('live: the badge is in the live color while it says LIVE, and says something else when not live', () => {
  const live = render(
    <ControlBar isPlaying speed={1} currentTime={3} totalDuration={10} onPlayPause={noop} onRestart={noop} onSpeedChange={noop} timelineEvents={[]} connectionStatus="watching" />,
  )
  const badgeText = (r: ReturnType<typeof render>) => r.container.querySelector('[data-live-badge] span:last-child') as HTMLElement
  const label = badgeText(live)
  assert.equal(label.textContent?.trim(), 'LIVE')
  assert.equal(label.style.color, normalized('color', COLORS.liveText))
  cleanup()
  // Demo: another word, not in the live color
  const demo = badgeText(render(
    <ControlBar isPlaying speed={1} currentTime={3} totalDuration={10} onPlayPause={noop} onRestart={noop} onSpeedChange={noop} timelineEvents={[]} isDemo connectionStatus="watching" />,
  ))
  assert.equal(demo.textContent?.trim(), 'DEMO')
  assert.notEqual(demo.style.color, normalized('color', COLORS.liveText))
  cleanup()
  // Offline: another word, in the error color (which the themes draw with the same danger red as live)
  const offline = badgeText(render(
    <ControlBar isPlaying speed={1} currentTime={3} totalDuration={10} onPlayPause={noop} onRestart={noop} onSpeedChange={noop} timelineEvents={[]} connectionStatus="disconnected" />,
  ))
  assert.notEqual(offline.textContent?.trim(), 'LIVE')
  assert.equal(offline.style.color, normalized('color', COLORS.error))
})

const menuProps = (contextMenu: { x: number; y: number; agentId?: string }) => ({
  selection: { contextMenu, setContextMenu: noop },
  inspector: { selectedAgent: null, selectedGone: false, goneName: null, delegation: [], toolWhy: null },
  agents: new Map(), links: new Map(), droppedMessages: new Map(),
  health: { byAgent: new Map(), bySession: new Map() },
  bridge: { relayOrigin: null, launch: null, eventLoss: null },
  selectedLinkId: null, onCloseLink: noop, onEscapeFromCard: noop,
  menuActions: { toggleStats: noop, zoomToFit: noop, toggleGrid: noop, clearHistory: noop, reloadSessionEvents: null },
  }) as unknown as React.ComponentProps<typeof SelectionOverlays>

test('canvas menu: "Zoom to fit" is spelled like everywhere else (shortcuts, palette)', () => {
  const { getByRole, queryByRole } = render(<SelectionOverlays {...menuProps({ x: 10, y: 10 })} />)
  assert.ok(getByRole('menuitem', { name: 'Zoom to fit' }))
  assert.equal(queryByRole('menuitem', { name: 'Zoom to Fit' }), null)
})

test('canvas and agent menus: every item is in sentence case (#383)', () => {
  const labels = (r: ReturnType<typeof render>) => r.getAllByRole('menuitem').map(i => i.textContent?.replace(/^\W+/u, '').trim())
  const canvas = labels(render(<SelectionOverlays {...menuProps({ x: 10, y: 10 })} />))
  assert.ok(canvas.includes('Toggle stats') && canvas.includes('Toggle grid'), canvas.join(', '))
  cleanup()
  const agent = labels(render(<SelectionOverlays {...menuProps({ x: 10, y: 10, agentId: 'a1' })} />))
  assert.deepEqual(agent, ['Show details', 'Zoom to fit', 'Toggle stats'])
  for (const label of [...canvas, ...agent]) {
    const rest = (label ?? '').split(' ').slice(1)
    assert.ok(rest.every(w => w === w.toLowerCase()), `"${label}" is in sentence case`)
  }
})

test('session search: the placeholder fits a narrow panel and the fields searched stay visible, as its description', () => {
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
  // A title shows only on mouse hover: the hint is visible text, tied to the input for screen readers
  assert.equal(input.title, '')
  const hintId = input.getAttribute('aria-describedby')
  assert.ok(hintId, 'the input has a description')
  const hint = document.getElementById(hintId)
  assert.equal(hint?.textContent, 'Searches name, project, branch, agent')
})
