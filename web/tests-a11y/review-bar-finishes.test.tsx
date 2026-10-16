// Finitions de la barre de lecture (#383) : en revue, rien ne dit « en direct » dans la couleur du direct.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'

import { ControlBar } from '@/components/agent-visualizer/control-bar'
import { COLORS } from '@/lib/colors'

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
