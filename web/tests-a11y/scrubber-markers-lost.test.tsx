// Scrubber markers (#648): when some older markers cannot be drawn, the bar says how many instead of omitting them.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'
import axe from 'axe-core'
import { setLocaleChoice } from '@/lib/locale'
import { ControlBar } from '@/components/agent-visualizer/control-bar'

afterEach(() => { cleanup(); document.body.replaceChildren(); setLocaleChoice('en') })

const noop = () => {}
const bar = (lostMarkers: number, isReviewing = false) => render(
  <ControlBar isPlaying={false} speed={1} currentTime={0} totalDuration={10} onPlayPause={noop} onRestart={noop}
    onSpeedChange={noop} timelineEvents={[]} eventCount={3} isReviewing={isReviewing} lostMarkers={lostMarkers} />,
)

test('no lost marker: nothing is shown', () => {
  const { container } = bar(0)
  assert.equal(container.querySelector('[data-markers-lost]'), null)
})

test('lost markers are announced with their number, in both bars and both languages', async () => {
  for (const [locale, one, other] of [['en', '1 older marker not shown', '150 older markers not shown'], ['fr', '1 marqueur plus ancien non affiché', '150 marqueurs plus anciens non affichés']] as const) {
    setLocaleChoice(locale)
    for (const reviewing of [false, true]) {
      const a = bar(1, reviewing)
      assert.ok(a.container.querySelector('[data-markers-lost]')?.textContent?.includes(one), `${locale} one`)
      cleanup()
      const b = bar(150, reviewing)
      assert.ok(b.container.querySelector('[data-markers-lost]')?.textContent?.includes(other), `${locale} other`)
      const results = await axe.run(b.container, { rules: { 'color-contrast': { enabled: false } } })
      assert.deepEqual(results.violations.map(v => v.id), [])
      cleanup()
    }
  }
})
