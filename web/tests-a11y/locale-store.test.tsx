// #247: locale store. The choice is "auto" (browser language) or an explicit locale, kept in this browser only.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { getLocale, getLocaleChoice, setLocaleChoice, subscribeLocale } from '@/lib/locale'
import { LOCALE_STORAGE_KEY } from '@/lib/messages'

function browserLanguages(langs: string[] | null) {
  if (langs === null) delete (window.navigator as unknown as Record<string, unknown>).languages
  else Object.defineProperty(window.navigator, 'languages', { value: langs, configurable: true })
}

afterEach(() => {
  setLocaleChoice('auto')
  window.localStorage.clear()
  browserLanguages(null)
})

test('without a choice the browser language decides, English by default', () => {
  assert.equal(getLocaleChoice(), 'auto')
  assert.equal(getLocale(), 'en')
  browserLanguages(['de-DE', 'fr-CA'])
  assert.equal(getLocale(), 'fr')
})

test('an explicit choice wins over the browser and is stored under the catalog key', () => {
  browserLanguages(['fr-FR'])
  setLocaleChoice('en')
  assert.equal(getLocaleChoice(), 'en')
  assert.equal(getLocale(), 'en')
  assert.equal(window.localStorage.getItem(LOCALE_STORAGE_KEY), 'en')
})

test('"auto" forgets the stored choice', () => {
  setLocaleChoice('fr')
  setLocaleChoice('auto')
  assert.equal(window.localStorage.getItem(LOCALE_STORAGE_KEY), null)
  assert.equal(getLocaleChoice(), 'auto')
})

test('an unknown stored value is ignored, an unknown choice is refused', () => {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, 'klingon')
  assert.equal(getLocaleChoice(), 'auto')
  const seen: number[] = []
  const off = subscribeLocale(() => seen.push(1))
  setLocaleChoice('xx' as never)
  setLocaleChoice('__proto__' as never)
  off()
  assert.deepEqual(seen, [])
  assert.equal(window.localStorage.getItem(LOCALE_STORAGE_KEY), 'klingon')
})

test('subscribers are told once per change, and no longer after unsubscribing', () => {
  const seen: string[] = []
  const off = subscribeLocale(() => seen.push(getLocale()))
  setLocaleChoice('fr')
  setLocaleChoice('en')
  off()
  setLocaleChoice('fr')
  assert.deepEqual(seen, ['fr', 'en'])
})

test('blocked storage: the choice still holds for this page, nothing throws', () => {
  const proto = window.Storage.prototype
  const { setItem, removeItem, getItem } = proto
  proto.setItem = () => { throw new Error('blocked') }
  proto.removeItem = () => { throw new Error('blocked') }
  proto.getItem = () => { throw new Error('blocked') }
  try {
    setLocaleChoice('fr')
    assert.equal(getLocale(), 'fr')
    setLocaleChoice('auto')
    assert.equal(getLocaleChoice(), 'auto')
  } finally {
    Object.assign(proto, { setItem, removeItem, getItem })
  }
})
