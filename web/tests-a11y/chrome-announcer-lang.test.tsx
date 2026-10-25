// #613: the rendered ChromeAnnouncer (not only buildAnnouncementParts) declares the language of each piece: the region is in the
// interface language, a session name is data (lang="en"), and the "all sessions" label is interface text, so it is NOT marked en.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act } from '@testing-library/react'

import { ChromeAnnouncer } from '@/components/agent-visualizer/chrome-announcer'
import { connectionDisplay } from '@/lib/chrome-utils'
import { setLocaleChoice } from '@/lib/locale'
import { translate } from '@/lib/messages'

afterEach(() => { cleanup(); document.body.replaceChildren(); act(() => setLocaleChoice('auto')) })

const view = (sessionLabel: string | null, sessionLabelIsInterface = false) => (
  <ChromeAnnouncer connection={connectionDisplay('watching', false)} sessionLabel={sessionLabel} sessionLabelIsInterface={sessionLabelIsInterface} isReviewing={false} isEmpty={false} sessions={[]} sessionsWithActivity={new Set()} />
)

test('fr region: the session name sits in a lang="en" span inside the lang="fr" region', () => {
  act(() => setLocaleChoice('fr'))
  const { getByRole } = render(view('refactor-auth'))
  const region = getByRole('status')
  assert.equal(region.getAttribute('lang'), 'fr')
  const en = Array.from(region.querySelectorAll('span[lang="en"]'))
  assert.deepEqual(en.map(e => e.textContent), ['refactor-auth'])
  assert.ok(region.textContent!.includes('Session : refactor-auth'), region.textContent!)
})

test('fr region: the "all sessions" label is translated and not marked lang="en"', () => {
  act(() => setLocaleChoice('fr'))
  const { getByRole } = render(view(translate('fr', 'sessions.allSessions'), true))
  const region = getByRole('status')
  assert.equal(region.querySelectorAll('span[lang="en"]').length, 0)
  assert.ok(region.textContent!.includes('Toutes les sessions'), region.textContent!)
})

test('fr region: a real session named like the "all sessions" label stays data (lang="en")', () => {
  act(() => setLocaleChoice('fr'))
  const { getByRole } = render(view(translate('fr', 'sessions.allSessions')))
  const en = Array.from(getByRole('status').querySelectorAll('span[lang="en"]'))
  assert.deepEqual(en.map(e => e.textContent), ['Toutes les sessions'])
})
