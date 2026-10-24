// #372: 'Show: active / all', the one visibility rule. Pure logic, node:test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVE_WINDOW_MINUTES, DEFAULT_SHOW_MODE, hidesInactiveAgents, isShowMode, showModeFromLegacy, showsFinishedSessions,
} from '../web/lib/show-mode'
import { ACTIVE_WINDOW_MS, activeSessionIds } from '../web/hooks/simulation/session-visibility'
import { TOP_BAR_LABELS } from '../web/lib/ui-glossary'
import { MESSAGES, translate } from '../web/lib/messages'

test('two modes, "active" by default', () => {
  assert.equal(DEFAULT_SHOW_MODE, 'active')
  assert.ok(isShowMode('all') && isShowMode('active'))
  for (const bad of ['ALL', '', null, true, 1]) assert.equal(isShowMode(bad), false)
})

test('"active" turns both former filters on, "all" turns both off', () => {
  assert.deepEqual([hidesInactiveAgents('active'), showsFinishedSessions('active')], [true, false])
  assert.deepEqual([hidesInactiveAgents('all'), showsFinishedSessions('all')], [false, true])
})

test('the written threshold is the one the session filter applies (10 minutes), not a copy', () => {
  assert.equal(ACTIVE_WINDOW_MINUTES * 60_000, ACTIVE_WINDOW_MS)
  assert.equal(ACTIVE_WINDOW_MINUTES, 10)
  const now = 1_000_000_000
  const finished = (minutesAgo: number) => ({ id: `s${minutesAgo}`, status: 'completed' as const, lastActivityTime: now - minutesAgo * 60_000 })
  const shown = activeSessionIds({ sessions: [finished(ACTIVE_WINDOW_MINUTES), finished(ACTIVE_WINDOW_MINUTES + 1)], now })
  assert.deepEqual([...shown], [`s${ACTIVE_WINDOW_MINUTES}`], 'a finished session silent for the threshold stays, one minute more and it is hidden')
  const open = activeSessionIds({ sessions: [{ id: 'open', status: 'active', lastActivityTime: now - 24 * 3_600_000 }], now })
  assert.ok(open.has('open'), 'a session never marked finished is not hidden however long it is silent')
})

test('migration: only the default pair of the former settings stays "active"', () => {
  assert.equal(showModeFromLegacy(true, false), 'active')
  assert.equal(showModeFromLegacy(false, false), 'all')
  assert.equal(showModeFromLegacy(true, true), 'all')
  assert.equal(showModeFromLegacy(false, true), 'all')
})

test('one name: the glossary, the top bar and Settings write the same words, in English and French', () => {
  const n = ACTIVE_WINDOW_MINUTES
  assert.equal(TOP_BAR_LABELS.filterHideInactive, 'Hide inactive')
  assert.equal(translate('en', 'show.hideInactive'), TOP_BAR_LABELS.filterHideInactive)
  assert.equal(translate('fr', 'show.hideInactive'), 'Masquer les inactifs')
  for (const locale of ['en', 'fr'] as const) {
    const label = translate(locale, 'show.hideInactive')
    // The label claims no time window: only the session filter of the All view has one, the agents have none
    assert.doesNotMatch(label, /\d|min/, `${locale}: no threshold in the label`)
    for (const view of ['all', 'one'] as const) {
      const name = translate(locale, `show.hideInactive.name.${view}`)
      // 2.5.3: the accessible name starts with the visible label; it stays short (the tooltip carries the rule)
      assert.ok(name.startsWith(label), `${locale}/${view}: name starts with the label`)
      assert.ok(name.length <= 45, `${locale}/${view}: short name (${name.length})`)
      assert.doesNotMatch(name, /minute/, `${locale}/${view}: the rule is not repeated in the name`)
    }
    // Only the All view hides sessions: only its name and tooltip mention them and their window
    assert.match(translate(locale, 'show.hideInactive.name.all'), /sessions/)
    assert.doesNotMatch(translate(locale, 'show.hideInactive.name.one'), /session/)
    assert.match(translate(locale, 'show.hideInactive.title.all', { n }), /10 minutes/)
    assert.doesNotMatch(translate(locale, 'show.hideInactive.title.one'), /session|minute/)
    assert.match(translate(locale, 'settings.show.hideInactive.help', { n }), /10 minutes/)
    // The hidden finished sessions are counted, in the language of the bar
    assert.match(translate(locale, 'show.hideInactive.count', { n: 3 }), /3/)
    const withCount = translate(locale, 'show.hideInactive.withCount', { n: 3 })
    assert.ok(withCount.startsWith(label))
    assert.match(withCount, /3/)
  }
  assert.equal(translate('en', 'show.hideInactive.count', { n: 3 }), 'Finished sessions hidden: 3')
  assert.equal(translate('en', 'show.hideInactive.withCount', { n: 3 }), TOP_BAR_LABELS.filterHideInactiveWithCount(3))
  assert.equal(MESSAGES.en['show.hideInactive.name.all'], 'Hide inactive: agents and sessions')
})
