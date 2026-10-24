// #247: locale store. The choice is "auto" (browser language) or an explicit locale, kept in this browser only.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { applyLocaleChoice, getLocale, getLocaleChoice, setLocaleChoice, subscribeLocale } from '@/lib/locale'
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

// #613: the choice shown by the language select is the language the interface is in. When the table of the chosen
// language does not load, the choice goes back to the previous one (and to the storage), instead of showing "Français"
// over an English interface.
test('a language whose table does not load: the choice goes back to the previous one', async () => {
  setLocaleChoice('en')
  const seen: string[] = []
  const off = subscribeLocale(() => seen.push(getLocaleChoice()))
  const failing = (l: string) => (l === 'fr' ? Promise.reject(new Error('chunk 404')) : Promise.resolve())
  applyLocaleChoice('fr', failing)
  assert.equal(getLocaleChoice(), 'fr', 'the choice shows at once while the table loads')
  await new Promise(res => setTimeout(res, 0))
  off()
  assert.equal(getLocaleChoice(), 'en', 'the select shows the language the interface stays in')
  assert.equal(window.localStorage.getItem(LOCALE_STORAGE_KEY), 'en', 'and the storage does not keep the failed choice')
  assert.deepEqual(seen, ['fr', 'en'])
})

test('a language that loads keeps the choice, and the failure of an older choice leaves a newer one alone', async () => {
  setLocaleChoice('en')
  let fail: (e: Error) => void = () => {}
  const slowFailing = (l: string) => (l === 'fr' ? new Promise<void>((_, rej) => { fail = rej }) : Promise.resolve())
  applyLocaleChoice('fr', slowFailing)
  applyLocaleChoice('auto', () => Promise.resolve())
  fail(new Error('late 404'))
  await new Promise(res => setTimeout(res, 0))
  assert.equal(getLocaleChoice(), 'auto')
  applyLocaleChoice('fr', () => Promise.resolve())
  await new Promise(res => setTimeout(res, 0))
  assert.equal(getLocaleChoice(), 'fr')
})
