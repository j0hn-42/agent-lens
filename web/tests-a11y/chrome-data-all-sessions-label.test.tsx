// #613: useChromeData itself translates the "All sessions" label with the interface language (the announcer then does not mark it lang="en").
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, cleanup, act } from '@testing-library/react'

import { useChromeData } from '@/hooks/use-chrome-data'
import { setLocaleChoice } from '@/lib/locale'
import { translate } from '@/lib/messages'

afterEach(() => { cleanup(); act(() => setLocaleChoice('auto')) })

const bridge = { allViewSessionIds: null, sessions: [], connectionStatus: 'watching', useMockData: false, isAllSelected: true, selectedSessionId: null, teams: [] }

const labelIn = (choice: 'fr' | 'en') => {
  act(() => setLocaleChoice(choice))
  const agents = new Map()
  const { result } = renderHook(() => useChromeData(agents as never, { current: agents } as never, bridge as never, null, false))
  return result.current.selectedSessionLabel
}

test('fr: the label of the All selection is the French one, not the English literal', () => {
  assert.equal(labelIn('fr'), translate('fr', 'sessions.allSessions'))
  assert.notEqual(labelIn('fr'), 'All sessions')
})

test('en: the label of the All selection is the English one', () => {
  assert.equal(labelIn('en'), translate('en', 'sessions.allSessions'))
})
