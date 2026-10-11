// Message catalog (#247): translatable interface strings, French first. Pure data: no React.
// Scope of this first step: the motion controls. Other strings stay in ui-glossary.ts until they move here;
// a key is added to every locale at once (scripts/messages.test.ts checks keys and {placeholders}).

export const LOCALES = ['fr', 'en'] as const
export type Locale = (typeof LOCALES)[number]

/** Shown when neither the stored choice nor the browser language is a known locale: the rest of the UI is English. */
export const DEFAULT_LOCALE: Locale = 'en'

export const LOCALE_STORAGE_KEY = 'agent-lens:locale'

const fr = {
  'motion.group': 'Mouvement par couche',
  'motion.layer.background': 'Fond animé',
  'motion.layer.links': 'Liens',
  'motion.layer.agents': 'Agents',
  'motion.layer.effects': 'Effets',
  'motion.calmCount': '{n} couche(s) au calme',
  'motion.lockedBySystem': 'Les animations sont réduites par les réglages de votre système',
} as const

export type MessageKey = keyof typeof fr

const en: Record<MessageKey, string> = {
  'motion.group': 'Motion by layer',
  'motion.layer.background': 'Animated background',
  'motion.layer.links': 'Links',
  'motion.layer.agents': 'Agents',
  'motion.layer.effects': 'Effects',
  'motion.calmCount': '{n} layer(s) calm',
  'motion.lockedBySystem': 'Animations are reduced by your system settings',
}

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
