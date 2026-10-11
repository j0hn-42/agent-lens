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
