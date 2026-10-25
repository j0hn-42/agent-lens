// #613: useChromeData itself translates the "All sessions" label with the interface language (the announcer then does not mark it lang="en").
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, cleanup, act } from '@testing-library/react'

import { useChromeData } from '@/hooks/use-chrome-data'
import { setLocaleChoice } from '@/lib/locale'
import { translate } from '@/lib/messages'

afterEach(() => { cleanup(); act(() => setLocaleChoice('auto')) })

const bridge = { allViewSessionIds: null, sessions: [], connectionStatus: 'watching', useMockData: false, isAllSelected: true, selectedSessionId: null, teams: [] }

const dataIn = (choice: 'fr' | 'en', b: object = bridge) => {
  act(() => setLocaleChoice(choice))
  const agents = new Map()
  const { result } = renderHook(() => useChromeData(agents as never, { current: agents } as never, b as never, null, false))
  return result.current
}
const labelIn = (choice: 'fr' | 'en') => dataIn(choice).selectedSessionLabel

test('fr: the label of the All selection is the French one, not the English literal', () => {
  assert.equal(labelIn('fr'), translate('fr', 'sessions.allSessions'))
  assert.notEqual(labelIn('fr'), 'All sessions')
})

test('en: the label of the All selection is the English one', () => {
  assert.equal(labelIn('en'), translate('en', 'sessions.allSessions'))
})

test('the All selection is flagged as interface text; a session named like it is not (#613)', () => {
  assert.equal(dataIn('fr').selectedSessionLabelIsInterface, true)
  const named = { ...bridge, isAllSelected: false, selectedSessionId: 's1', sessions: [{ id: 's1', label: 'Toutes les sessions' }] }
  const d = dataIn('fr', named)
  assert.equal(d.selectedSessionLabel, 'Toutes les sessions')
  assert.equal(d.selectedSessionLabelIsInterface, false)
})

test('fr: a team selection is read with the French team heading, as interface text (#613)', () => {
  const team = { ...bridge, isAllSelected: false, selectedSessionId: 'team:alpha', teams: new Map([['alpha', { kind: 'team', name: 'alpha' }]]) }
  const d = dataIn('fr', team)
  assert.equal(d.selectedSessionLabel, 'Équipe alpha')
  assert.equal(d.selectedSessionLabelIsInterface, true)
  assert.equal(dataIn('en', team).selectedSessionLabel, 'Team alpha')
})
