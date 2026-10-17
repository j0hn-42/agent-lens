// #247: message catalog, French first. Pure logic, node:test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LOCALES, DEFAULT_LOCALE, MESSAGES, resolveLocale, translate, type MessageKey } from '../web/lib/messages'

test('French comes first in the catalog', () => {
  assert.deepEqual([...LOCALES], ['fr', 'en'])
})

test('every locale has exactly the same keys, none empty', () => {
  const ref = Object.keys(MESSAGES.fr).sort()
  for (const l of LOCALES) {
    assert.deepEqual(Object.keys(MESSAGES[l]).sort(), ref, `keys of ${l}`)
    for (const k of ref) assert.ok(MESSAGES[l][k as MessageKey].trim().length > 0, `${l}.${k}`)
  }
})

test('every locale keeps the same {placeholders} as French', () => {
  const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join()
  for (const k of Object.keys(MESSAGES.fr) as MessageKey[]) {
    for (const l of LOCALES) assert.equal(ph(MESSAGES[l][k]), ph(MESSAGES.fr[k]), `${l}.${k}`)
  }
})

test('locale resolution: stored choice, then browser languages, then the default', () => {
  assert.equal(resolveLocale('en', ['fr-FR']), 'en')
  assert.equal(resolveLocale(null, ['de-DE', 'fr-CA', 'en']), 'fr')
  assert.equal(resolveLocale(null, ['en-US']), 'en')
  assert.equal(resolveLocale(null, ['de']), DEFAULT_LOCALE)
  assert.equal(resolveLocale('xx', []), DEFAULT_LOCALE)
  assert.equal(resolveLocale('__proto__', undefined), DEFAULT_LOCALE)
})

test('translate fills placeholders and falls back to the default locale for an unknown one', () => {
  assert.equal(translate('en', 'motion.layer.background'), MESSAGES.en['motion.layer.background'])
  assert.match(translate('fr', 'motion.calmCount', { n: 2 }), /2/)
  assert.equal(translate('xx' as never, 'motion.layer.agents'), MESSAGES[DEFAULT_LOCALE]['motion.layer.agents'])
})

// Step 2: the catalog covers the canvas controls and the settings dialog
// units and a word that is the same in both languages
const SAME_IN_BOTH = new Set<string>(['controls.seconds', 'controls.minutes', 'controls.zoomGroup', 'settings.section.notifications', 'settings.language.fr', 'settings.language.en', 'permission.rowTitle', 'permission.session', 'permission.withSubject', 'permission.actionNameShort', 'permission.deadlineMin', 'permission.deadlineSec', 'topbar.notify', 'quota.window.fiveHour', 'count.agent.one', 'count.agent.other', 'legend.disc-code'])

test('a French message is not a copy of the English one', () => {
  for (const k of Object.keys(MESSAGES.fr) as MessageKey[]) {
    if (SAME_IN_BOTH.has(k)) continue
    assert.notEqual(MESSAGES.fr[k], MESSAGES.en[k], `fr.${k} is still English`)
  }
})

test('the controls and settings keys exist in every locale', () => {
  const wanted = [
    'controls.zoomIn', 'controls.zoomOut', 'controls.fit', 'controls.zoomGroup', 'controls.view', 'controls.viewSettings', 'controls.pause', 'controls.keepCards',
    'controls.expireAfter', 'controls.seconds', 'controls.minutes',
    'common.close', 'settings.title', 'settings.language', 'settings.language.auto', 'settings.theme',
    'settings.notify.cost.help', 'settings.notify.invalid',
  ]
  for (const k of wanted) for (const l of LOCALES) assert.ok(k in MESSAGES[l], `${l}.${k}`)
})

test('a figure keeps its qualification in French (at least, estimated)', () => {
  assert.match(MESSAGES.fr['settings.notify.cost.help'], /au moins/)
  assert.match(MESSAGES.fr['settings.notify.cost.help'], /estim/)
})

test('the canvas control labels are the ones the owner validated, in both locales', () => {
  const expected = {
    fr: { fit: 'Tout afficher', pause: 'Figer les animations', keepCards: 'Garder les cartes affichées', expireAfter: 'Masquer les appels sans réponse après', view: 'Affichage', viewSettings: 'Réglages d’affichage', zoomIn: 'Zoom avant', zoomOut: 'Zoom arrière' },
    en: { fit: 'Fit to view', pause: 'Freeze motion', keepCards: 'Pin cards', expireAfter: 'Hide unanswered calls after', view: 'View', viewSettings: 'View settings', zoomIn: 'Zoom in', zoomOut: 'Zoom out' },
  } as const
  for (const l of LOCALES) for (const [k, v] of Object.entries(expected[l])) assert.equal(MESSAGES[l][`controls.${k}` as MessageKey], v, `${l}.controls.${k}`)
})
