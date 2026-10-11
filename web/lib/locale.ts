/**
 * Locale store (#247): the language choice, its persistence and the re-render signal.
 *
 * The choice is `auto` (follow the browser language) or an explicit locale. It lives only in this browser
 * (LOCALE_STORAGE_KEY); blocked storage never throws, the choice then lasts for the page. Pure resolution
 * stays in messages.ts; this module only reads `window` and notifies React.
 */

import { useCallback, useSyncExternalStore } from 'react'
import { DEFAULT_LOCALE, LOCALES, LOCALE_STORAGE_KEY, resolveLocale, translate, type Locale, type MessageKey } from './messages'

export type LocaleChoice = Locale | 'auto'

const listeners = new Set<() => void>()
/** Choice made in this page when storage could not keep it (null: none, read the storage) */
let pageChoice: LocaleChoice | null = null

function isChoice(v: unknown): v is LocaleChoice {
  return v === 'auto' || (typeof v === 'string' && (LOCALES as readonly string[]).includes(v))
}

function readStored(): string | null {
  try { return window.localStorage.getItem(LOCALE_STORAGE_KEY) } catch { return null }
}

export function getLocaleChoice(): LocaleChoice {
  if (typeof window === 'undefined') return 'auto'
  if (pageChoice !== null) return pageChoice
  const stored = readStored()
  return isChoice(stored) && stored !== 'auto' ? stored : 'auto'
}

/** Language the interface shows: the explicit choice, else the browser languages, else English. */
export function getLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE
  const choice = getLocaleChoice()
  if (choice !== 'auto') return choice
  return resolveLocale(null, window.navigator.languages?.length ? window.navigator.languages : [window.navigator.language])
}

/** Unknown values are refused. `auto` forgets the stored choice. */
export function setLocaleChoice(choice: LocaleChoice): void {
  if (!isChoice(choice)) return
  pageChoice = choice
  try {
    if (choice === 'auto') window.localStorage.removeItem(LOCALE_STORAGE_KEY)
    else window.localStorage.setItem(LOCALE_STORAGE_KEY, choice)
    pageChoice = null
  } catch { /* storage blocked: the choice just lasts for this page */ }
  for (const cb of Array.from(listeners)) cb()
}

export function subscribeLocale(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** Effective locale, the stored choice and its setter; components re-render when the choice changes. */
export function useLocale(): { locale: Locale; choice: LocaleChoice; setChoice: (choice: LocaleChoice) => void } {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, () => DEFAULT_LOCALE)
  const choice = useSyncExternalStore(subscribeLocale, getLocaleChoice, () => 'auto' as LocaleChoice)
  return { locale, choice, setChoice: setLocaleChoice }
}

/** `t(key, params)` bound to the current locale. */
export function useT(): (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string {
  const { locale } = useLocale()
  return useCallback((key, params) => translate(locale, key, params), [locale])
}
