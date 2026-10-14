// Badge de la barre de lecture (#181, #367): il suit l'état réel de la connexion avec les mêmes mots que la barre du haut.
// LIVE (pulsant) est réservé à « watching » ; une simple connexion (« connected ») ne prouve aucun flux : CONNECTED, sans pulsation.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'
import axe from 'axe-core'

import { ControlBar } from '@/components/agent-visualizer/control-bar'
import type { ConnectionStatus } from '@/lib/bridge-types'
import { connectionDisplay } from '@/lib/chrome-utils'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const noop = () => {}

function bar(connectionStatus?: ConnectionStatus, isDemo = false) {
  return render(
    <ControlBar
      isPlaying={false} speed={1} currentTime={3} totalDuration={10}
      onPlayPause={noop} onRestart={noop} onSpeedChange={noop}
      timelineEvents={[]} connectionStatus={connectionStatus} isDemo={isDemo}
    />,
  )
}

const badgeText = (c: HTMLElement) => c.querySelector('[data-live-badge]')?.textContent?.trim()
const pulses = (c: HTMLElement) => c.querySelector('[data-live-badge] [aria-hidden="true"]')?.className.includes('animate-pulse')

test('en observation : LIVE qui pulse', () => {
  const { container } = bar('watching')
  assert.equal(badgeText(container), 'LIVE')
  assert.equal(pulses(container), true)
})

test('connecté sans activité observée : CONNECTED, sans pulsation, mot de la barre du haut', () => {
  const { container } = bar('connected')
  assert.equal(badgeText(container), 'CONNECTED')
  assert.equal(pulses(container), false)
  assert.equal(badgeText(container)?.toLowerCase(), connectionDisplay('connected', false).label.toLowerCase())
})

test('relais déconnecté : OFFLINE, sans pulsation', () => {
  const { container } = bar('disconnected')
  assert.equal(badgeText(container), 'OFFLINE')
  assert.equal(pulses(container), false)
})

test('connexion en cours : CONNECTING, pas LIVE', () => {
  const { container } = bar('connecting')
  assert.equal(badgeText(container), 'CONNECTING')
  assert.equal(pulses(container), false)
})

test('la démo reste DEMO quel que soit le statut', () => {
  const { container } = bar('disconnected', true)
  assert.equal(badgeText(container), 'DEMO')
})

test('barre déconnectée sans violation axe', async () => {
  const { container } = bar('disconnected')
  const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
  assert.deepEqual(r.violations.map(v => v.id), [])
})
