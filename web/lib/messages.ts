// Message catalog (#247): translatable interface strings, French first. Pure data: no React.
// Other strings stay in ui-glossary.ts and in their components until they move here.
// The messages live in one file per domain, web/lib/messages/<domain>.ts, each with its fr and en tables side by side (#612):
// add a key to the file of your domain, with its two languages. This file only assembles the domains and keeps the public API;
// scripts/messages.test.ts checks keys and {placeholders} in every locale, and that no key is in two domain files.

import { MESSAGE_DOMAINS } from './messages/domains'

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

/** The domains merged in the order of domains.ts; scripts/messages.test.ts checks no key is in two of them. */
function assemble(locale: Locale): Record<MessageKey, string> {
  return Object.assign({}, ...Object.values(MESSAGE_DOMAINS).map(d => d[locale])) as Record<MessageKey, string>
}

const fr = assemble('fr')
const en = assemble('en')

export const MESSAGES: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = Object.freeze({ fr, en })

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
  const table = isLocale(locale) ? MESSAGES[locale] : MESSAGES[DEFAULT_LOCALE]
  const text = table[key]
  return params ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m)) : text
}
