// #587, #588 (suite de #373): the playback bar and the shortcuts dialog speak the
// interface language. Pure logic, node:test. The English text is unchanged: the rest of the suite pins it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatEventCount, formatSpeed, formatTruncatedHistory, liveBadge, scrubberValueText } from '../web/lib/chrome-utils'
import { connectionText } from '../web/lib/top-bar-text'
import { SHORTCUTS, SHORTCUT_GROUPS } from '../web/lib/shortcuts'
import { shortcutDescription, shortcutGroupName, shortcutKeyCap } from '../web/lib/shortcuts-text'
import { LOCALES, MESSAGES, translate } from '../web/lib/messages'

test('playback bar: the truncated-history text agrees with the count in both languages, English by default', () => {
  assert.equal(formatTruncatedHistory(0, 'fr'), null)
  assert.equal(formatTruncatedHistory(1), 'History truncated: 1 older event dropped')
  assert.equal(formatTruncatedHistory(250, 'en'), 'History truncated: 250 older events dropped')
  assert.equal(formatTruncatedHistory(1, 'fr'), 'Historique tronqué : 1 événement plus ancien supprimé')
  assert.equal(formatTruncatedHistory(250, 'fr'), 'Historique tronqué : 250 événements plus anciens supprimés')
})

test('playback bar: the slider value is said in the language', () => {
  assert.equal(scrubberValueText(75, 3725), '1:15 of 1:02:05')
  assert.equal(scrubberValueText(75, 3725, 'fr'), '1:15 sur 1:02:05')
})

test('playback bar: the badge says what the top bar says, in each language, and only a watched relay pulses', () => {
  for (const locale of LOCALES) {
    for (const status of ['watching', 'connected', 'connecting', 'disconnected'] as const) {
      const badge = liveBadge(status, false, locale)
      assert.equal(badge.label, connectionText(locale, status, false).label, `${locale} ${status}`)
      assert.equal(badge.live, status === 'watching')
    }
    const demo = liveBadge('watching', true, locale)
    assert.equal(demo.label, connectionText(locale, 'watching', true).label)
    assert.equal(demo.live, false, 'DEMO never pulses as live')
  }
  assert.equal(liveBadge('disconnected', false, 'fr').label, 'HORS LIGNE')
  assert.equal(liveBadge('watching', false).label, 'LIVE')
})

test('shortcuts: the English description of every shortcut is the one of the table', () => {
  for (const s of SHORTCUTS) assert.equal(shortcutDescription(s, 'en'), s.description, s.key)
})

test('shortcuts: in French every description differs from the English one and carries the French panel names', () => {
  for (const s of SHORTCUTS) assert.notEqual(shortcutDescription(s, 'fr'), s.description, s.key)
  const byKey = new Map(SHORTCUTS.map(s => [s.key, s]))
  assert.equal(shortcutDescription(byKey.get('f')!, 'fr'), 'Basculer le panneau Fichiers')
  assert.equal(shortcutDescription(byKey.get('l')!, 'fr'), 'Basculer la liste Sessions et agents')
  assert.equal(shortcutDescription(byKey.get('$')!, 'fr'), 'Basculer la superposition Coût')
  assert.equal(shortcutDescription(byKey.get('2')!, 'fr'), 'Vitesse 1x')
})

test('shortcuts: key caps keep their key and only the words of them are translated', () => {
  for (const s of SHORTCUTS) assert.equal(shortcutKeyCap(s, 'en'), s.display, s.key)
  const byKey = new Map(SHORTCUTS.map(s => [s.key, s]))
  assert.equal(shortcutKeyCap(byKey.get(' ')!, 'fr'), 'Espace')
  assert.equal(shortcutKeyCap(byKey.get('Escape')!, 'fr'), 'Échap')
  assert.equal(shortcutKeyCap(byKey.get('F')!, 'fr'), 'Maj+F')
  assert.equal(shortcutKeyCap(byKey.get('m')!, 'fr'), 'M')
  assert.equal(shortcutKeyCap(byKey.get('Ctrl+K')!, 'fr'), 'Ctrl+K / Cmd+K')
})

test('shortcuts: every group has a name in each language', () => {
  for (const g of SHORTCUT_GROUPS) {
    assert.equal(shortcutGroupName(g, 'en'), g)
    assert.notEqual(shortcutGroupName(g, 'fr'), g)
  }
  assert.equal(translate('fr', 'shortcut.title'), 'Raccourcis clavier')
  assert.equal(MESSAGES.en['shortcut.title'], 'Keyboard shortcuts')
})

test('playback bar: the event count agrees in both languages (0 and 1 are singular in French)', () => {
  assert.equal(formatEventCount(0), '0 events')
  assert.equal(formatEventCount(1), '1 event')
  assert.equal(formatEventCount(2, 'en'), '2 events')
  assert.equal(formatEventCount(0, 'fr'), '0 événement')
  assert.equal(formatEventCount(1, 'fr'), '1 événement')
  assert.equal(formatEventCount(2, 'fr'), '2 événements')
})

test('playback bar: a speed is written with the decimal mark of the language, in the bar and in the shortcuts', () => {
  assert.equal(formatSpeed(0.5), '0.5')
  assert.equal(formatSpeed(0.5, 'fr'), '0,5')
  assert.equal(formatSpeed(4, 'fr'), '4')
  const speed = SHORTCUTS.find(d => d.key === '1')!
  assert.equal(shortcutDescription(speed, 'en'), 'Speed 0.5x')
  assert.equal(shortcutDescription(speed, 'fr'), 'Vitesse 0,5x')
})

test('playback bar: the Review button keeps its visible word in its accessible name (WCAG 2.5.3), in both languages', () => {
  for (const locale of LOCALES) {
    const visible = translate(locale, 'bar.review').toLowerCase()
    assert.ok(translate(locale, 'bar.review.name').toLowerCase().includes(visible), locale)
  }
})
