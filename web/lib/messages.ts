// Message catalog (#247): translatable interface strings, French first. Pure data: no React.
// Other strings stay in ui-glossary.ts and in their components until they move here.
// The messages live in one file per domain, web/lib/messages/<domain>.ts, each with its fr and en tables side by side (#612):
// add a key to the file of your domain, with its two languages. This file keeps the public API; the tables of each
// language are assembled in web/lib/messages/locales/<locale>.ts (#662), the default one is in the first load and the
// other one is loaded on demand (loadLocale). scripts/messages.test.ts checks keys and {placeholders} in every locale,
// and that no key is in two domain files.

import type { MESSAGE_DOMAINS } from './messages/domains'
import { TABLE as DEFAULT_TABLE } from './messages/locales/en'

export const LOCALES = ['fr', 'en'] as const
export type Locale = (typeof LOCALES)[number]

/** Shown when neither the stored choice nor the browser language is a known locale: the rest of the UI is English. */
export const DEFAULT_LOCALE: Locale = 'en'

export const LOCALE_STORAGE_KEY = 'agent-lens:locale'

/** Every domain of domains.ts, as one type per language: a new domain is listed there only (#613) */
type Domain = (typeof MESSAGE_DOMAINS)[keyof typeof MESSAGE_DOMAINS]
type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never
type FrTable = UnionToIntersection<Domain['fr']>

export type MessageKey = keyof FrTable
export type MessageTable = Readonly<Record<MessageKey, string>>

/** The tables loaded so far: the default locale from the start, the others once loadLocale resolved (#662) */
const tables: Partial<Record<Locale, MessageTable>> = { [DEFAULT_LOCALE]: DEFAULT_TABLE }
const pending = new Map<Locale, Promise<void>>()
const loadedListeners = new Set<() => void>()

/** One chunk per language: the import is what the bundler splits on */
const LOADERS: Record<Locale, () => Promise<MessageTable>> = {
  fr: () => import('./messages/locales/fr').then(m => m.TABLE),
  en: () => Promise.resolve(DEFAULT_TABLE),
}

export function isLocaleLoaded(locale: Locale): boolean {
  return isLocale(locale) && tables[locale] !== undefined
}

/** Loads the table of a locale once; the listeners of onLocaleLoaded hear it. A failed load can be retried. */
export function loadLocale(locale: Locale): Promise<void> {
  if (!isLocale(locale) || tables[locale]) return Promise.resolve()
  let p = pending.get(locale)
  if (!p) {
    p = LOADERS[locale]().then(table => {
      tables[locale] = table
      for (const cb of Array.from(loadedListeners)) cb()
    }).finally(() => { pending.delete(locale) })
    pending.set(locale, p)
  }
  return p
}

export function onLocaleLoaded(cb: () => void): () => void {
  loadedListeners.add(cb)
  return () => { loadedListeners.delete(cb) }
}

/** The locale the interface can show now: the wanted one once its table is there, the default one until then, so the
 * `lang` of an element never names a language its text is not in (#662). */
export function effectiveLocale(wanted: Locale): Locale {
  return isLocaleLoaded(wanted) ? wanted : DEFAULT_LOCALE
}

function loadedTable(locale: Locale): MessageTable {
  const table = tables[locale]
  if (!table) throw new Error(`messages: the ${locale} table is not loaded yet (await loadLocale('${locale}'))`)
  return table
}

/** Every table by locale. Reading a locale that is not loaded throws: the interface goes through translate. */
export const MESSAGES: Readonly<Record<Locale, MessageTable>> = Object.freeze(Object.defineProperties({} as Record<Locale, MessageTable>,
  Object.fromEntries(LOCALES.map(l => [l, { get: () => loadedTable(l), enumerable: true }]))))

function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v)
}

/** Stored choice first, then the browser languages in order (primary subtag), then the default. */
export function resolveLocale(stored: string | null | undefined, browserLanguages: readonly string[] | undefined): Locale {
  if (isLocale(stored)) return stored
  for (const tag of browserLanguages ?? []) {
    const primary = String(tag).toLowerCase().split('-')[0]
    if (isLocale(primary)) return primary
  }
  return DEFAULT_LOCALE
}

export function translate(locale: Locale, key: MessageKey, params?: Readonly<Record<string, string | number>>): string {
  const table = (isLocale(locale) && tables[locale]) || DEFAULT_TABLE
  const text = table[key]
  return params ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m)) : text
}
