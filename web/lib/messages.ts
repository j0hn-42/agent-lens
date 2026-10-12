// Message catalog (#247): translatable interface strings, French first. Pure data: no React.
// Scope so far: the motion controls, the canvas controls and the settings dialog. Other strings stay in
// ui-glossary.ts and in their components until they move here; a key is added to every locale at once (scripts/messages.test.ts checks keys and {placeholders}).

export const LOCALES = ['fr', 'en'] as const
export type Locale = (typeof LOCALES)[number]

/** Shown when neither the stored choice nor the browser language is a known locale: the rest of the UI is English. */
export const DEFAULT_LOCALE: Locale = 'en'

export const LOCALE_STORAGE_KEY = 'agent-lens:locale'

const fr = {
  'motion.group': 'Calmer par couche',
  'motion.layer.background': 'Calmer le fond',
  'motion.layer.links': 'Calmer les liens',
  'motion.layer.agents': 'Calmer les agents',
  'motion.layer.effects': 'Calmer les effets',
  'motion.calmCount': '{n} couche(s) au calme',
  'motion.lockedBySystem': 'Les animations sont réduites par les réglages de votre système',
  'motion.lockedByPause': 'Les animations sont en pause (bouton Pause des animations)',
  'common.close': 'Fermer',
  'controls.zoomIn': 'Zoom avant',
  'controls.zoomOut': 'Zoom arrière',
  'controls.fit': 'Ajuster',
  'controls.fitLabel': 'Ajuster le graphe à la vue',
  'controls.pause': 'Pause des animations',
  'controls.keepCards': 'Garder les cartes visibles',
  'controls.expireAfter': 'Expirer les appels sans réponse après',
  'controls.seconds': '{n} s',
  'controls.minutes': '{n} min',
  'settings.title': 'Réglages',
  'settings.section.appearance': 'Apparence',
  'settings.theme': 'Thème',
  'settings.theme.title': 'Thème : Catppuccin, minuit, graphite, néon, braise, Anthropic ou contraste élevé',
  'settings.language': 'Langue',
  'settings.language.auto': 'Automatique (langue du navigateur)',
  'settings.language.fr': 'Français',
  'settings.language.en': 'English',
  'settings.hexGrid': 'Grille hexagonale',
  'settings.hexGrid.help': 'Afficher la grille hexagonale derrière le graphe (G).',
  'settings.section.sound': 'Son',
  'settings.sound': 'Effets sonores',
  'settings.sound.help': 'Jouer des sons pour l’activité des agents et des outils (M).',
  'settings.section.sessions': 'Sessions et agents',
  'settings.showFinished': 'Afficher les sessions terminées',
  'settings.showFinished.help': 'La vue « All » liste aussi les sessions terminées depuis plus de 10 minutes.',
  'settings.hideInactive': 'Masquer les agents inactifs',
  'settings.hideInactive.help': 'Les agents inactifs et terminés sont retirés du canevas.',
  'settings.section.notifications': 'Notifications',
  'settings.notify.enable': 'Activer les notifications',
  'settings.notify.unsupported': 'Les notifications ne sont pas disponibles dans cet environnement.',
  'settings.notify.denied': 'Les notifications sont bloquées dans les réglages du navigateur.',
  'settings.notify.note': 'Navigateur : affichées quand cet onglet est masqué. VS Code : affichées sauf si ce panneau a le focus.',
  'settings.notify.permission': 'Agent en attente d’une autorisation',
  'settings.notify.permission.help': 'Un agent se met à attendre que vous autorisiez un outil.',
  'settings.notify.error': 'Agent en erreur',
  'settings.notify.error.help': 'Un agent signale une erreur.',
  'settings.notify.complete': 'Session terminée',
  'settings.notify.complete.help': 'Une session que vous suiviez se termine. Les sessions déjà terminées au chargement ne sont pas annoncées.',
  'settings.notify.cost': 'Seuil de coût atteint',
  'settings.notify.cost.help': 'Le coût de la session franchit le montant ci-dessous, une seule fois. Le message garde la qualification du chiffre (au moins, estimé).',
  'settings.notify.threshold': 'Seuil de coût (USD)',
  'settings.notify.invalid': 'Montant invalide : saisissez un nombre supérieur à 0.',
  'settings.notify.rulesPending': 'Les règles s’appliquent une fois les notifications activées.',
  'settings.section.keyboard': 'Clavier',
  'settings.singleKey': 'Activer les raccourcis à une touche',
  'settings.singleKey.help': 'Désactivez si les touches lettres gênent une technologie d’assistance. Échap et ? fonctionnent toujours.',
  'settings.shortcuts': 'Voir les raccourcis clavier',
} as const

export type MessageKey = keyof typeof fr

const en: Record<MessageKey, string> = {
  'motion.group': 'Calm by layer',
  'motion.layer.background': 'Calm background',
  'motion.layer.links': 'Calm links',
  'motion.layer.agents': 'Calm agents',
  'motion.layer.effects': 'Calm effects',
  'motion.calmCount': '{n} layer(s) calm',
  'motion.lockedBySystem': 'Animations are reduced by your system settings',
  'motion.lockedByPause': 'Animations are paused (Pause animations button)',
  'common.close': 'Close',
  'controls.zoomIn': 'Zoom in',
  'controls.zoomOut': 'Zoom out',
  'controls.fit': 'Fit',
  'controls.fitLabel': 'Fit graph to view',
  'controls.pause': 'Pause animations',
  'controls.keepCards': 'Keep cards visible',
  'controls.expireAfter': 'Expire unanswered calls after',
  'controls.seconds': '{n} s',
  'controls.minutes': '{n} min',
  'settings.title': 'Settings',
  'settings.section.appearance': 'Appearance',
  'settings.theme': 'Theme',
  'settings.theme.title': 'Theme: Catppuccin, midnight, graphite, neon, ember, Anthropic or high contrast',
  'settings.language': 'Language',
  'settings.language.auto': 'Automatic (browser language)',
  'settings.language.fr': 'Français',
  'settings.language.en': 'English',
  'settings.hexGrid': 'Hex grid',
  'settings.hexGrid.help': 'Show the hexagonal grid behind the graph (G).',
  'settings.section.sound': 'Sound',
  'settings.sound': 'Sound effects',
  'settings.sound.help': 'Play sounds for agent and tool activity (M).',
  'settings.section.sessions': 'Sessions and agents',
  'settings.showFinished': 'Show finished sessions',
  'settings.showFinished.help': 'The \'All\' view also lists sessions that finished more than 10 minutes ago.',
  'settings.hideInactive': 'Hide inactive agents',
  'settings.hideInactive.help': 'Idle and complete agents are removed from the canvas.',
  'settings.section.notifications': 'Notifications',
  'settings.notify.enable': 'Enable notifications',
  'settings.notify.unsupported': 'Notifications are not available in this environment.',
  'settings.notify.denied': 'Notifications are blocked in the browser settings.',
  'settings.notify.note': 'Browser: shown while this tab is hidden. VS Code: shown unless this panel has the focus.',
  'settings.notify.permission': 'Agent waiting for a permission',
  'settings.notify.permission.help': 'An agent starts waiting for you to allow a tool.',
  'settings.notify.error': 'Agent in error',
  'settings.notify.error.help': 'An agent reports an error.',
  'settings.notify.complete': 'Session finished',
  'settings.notify.complete.help': 'A session you were watching ends. Sessions already finished when loaded are not announced.',
  'settings.notify.cost': 'Cost threshold reached',
  'settings.notify.cost.help': 'The session cost crosses the amount below, once. The message keeps the qualification of the figure (at least, estimated).',
  'settings.notify.threshold': 'Cost threshold (USD)',
  'settings.notify.invalid': 'Invalid amount: enter a number above 0.',
  'settings.notify.rulesPending': 'The rules apply once notifications are enabled.',
  'settings.section.keyboard': 'Keyboard',
  'settings.singleKey': 'Enable single-key shortcuts',
  'settings.singleKey.help': 'Turn off if letter keys conflict with assistive technology. Esc and ? always work.',
  'settings.shortcuts': 'View keyboard shortcuts',
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
