/**
 * The four tabs of the Settings dialog (#533) and the sections each one holds. Pure (no React).
 * The sections, their settings and their rules are those of the single scroll they replace: only the grouping is new.
 * The last tab opened is kept in memory for the page (use-dialogs-state), never in the preference blob, so
 * 'Reset preferences' has nothing to reset about it.
 */
import { LOCALES, MESSAGES, translate, type Locale, type MessageKey } from './messages'

export const SETTINGS_TABS = ['general', 'sessions', 'notifications', 'keyboard'] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]
/** The tabs the dialog shows: Notifications is left out when there is no notification channel and no announcement setting */
export function visibleSettingsTabs({ notifications, announcements }: { notifications: boolean; announcements: boolean }): SettingsTab[] {
  return SETTINGS_TABS.filter(id => id !== 'notifications' || notifications || announcements)
}
export const DEFAULT_SETTINGS_TAB: SettingsTab = 'general'

export const SETTINGS_TAB_LABEL: Readonly<Record<SettingsTab, MessageKey>> = {
  general: 'settings.tab.general',
  sessions: 'settings.tab.sessions',
  notifications: 'settings.tab.notifications',
  keyboard: 'settings.tab.keyboard',
}

/** Title keys of the sections a tab holds, in their order in the panel */
const SETTINGS_TAB_SECTIONS: Readonly<Record<SettingsTab, readonly MessageKey[]>> = {
  general: ['settings.section.appearance', 'settings.section.sound'],
  sessions: ['settings.section.sessions', 'settings.section.presentation'],
  notifications: ['settings.section.notifications', 'settings.section.announcements'],
  keyboard: ['settings.section.keyboard', 'settings.section.reset'],
}

/**
 * The palette command of a tab: named in the language of the interface, as the dialog is ("Settings: General",
 * "Réglages : Général"), and found by its name and the titles of its sections in every locale (the palette search ignores accents).
 */
export function settingsTabCommand(locale: Locale, tab: SettingsTab): { label: string; keywords: string[] } {
  const label = translate(locale, 'settings.tab.command', { tab: translate(locale, SETTINGS_TAB_LABEL[tab]) })
  const words = new Set<string>()
  for (const l of LOCALES) {
    for (const key of ['settings.title', 'settings.tab.alias', SETTINGS_TAB_LABEL[tab], ...SETTINGS_TAB_SECTIONS[tab]] as const) words.add(MESSAGES[l][key].toLowerCase())
  }
  return { label, keywords: Array.from(words) }
}
