// Message catalog (#247), domain “announcements” (#612): Spoken announcements, native notifications and presentation mode.
// Keys: announce.*, notify.*, presentation.*. Add a key here with its two languages, fr and en; web/lib/messages.ts assembles the domains.

export const fr = {
  'notify.complete.one': 'Session terminée : {label}',
  'notify.complete.other': '{n} sessions terminées',
  'notify.cost': '{name} atteinte : {value} (seuil {threshold})',

  // #383 : annonce du mode revue, avec le nom du bouton tel qu’affiché dans la barre
  'announce.reviewMode': 'Mode revue, utilisez « {button} » pour revenir',
  // Région polie du chrome (ChromeAnnouncer), toute la phrase dans la langue (#613)
  'announce.connection': 'Connexion : {state}',
  'announce.session': 'Session : {name}',
  'announce.liveMode': 'Mode direct',
  'announce.waiting': 'En attente d’une session d’agent',
  'announce.unobserved.one': '{n} session listée, activité non observée',
  'announce.unobserved.other': '{n} sessions listées, activité non observée',
  'announce.fullscreen.on': 'Plein écran activé',
  'announce.fullscreen.off': 'Plein écran désactivé',
  'announce.presentation.on': 'Mode présentation activé',
  'announce.presentation.off': 'Mode présentation désactivé',
  // Mode présentation : badge (#613)
  'presentation.badge': 'Mode présentation · V pour arrêter',
  'presentation.badge.title': 'Arrêter le mode présentation (V)',
} as const

export const en: Record<keyof typeof fr, string> = {
  'notify.complete.one': 'Session finished: {label}',
  'notify.complete.other': '{n} sessions finished',
  'notify.cost': '{name} reached {value} (threshold {threshold})',

  // #383: announcement of review mode, naming the button as the bar shows it
  'announce.reviewMode': 'Review mode, use {button} to return',
  // Polite live region of the chrome (ChromeAnnouncer), the whole sentence in the locale (#613)
  'announce.connection': 'Connection: {state}',
  'announce.session': 'Session: {name}',
  'announce.liveMode': 'Live mode',
  'announce.waiting': 'Waiting for an agent session',
  'announce.unobserved.one': '{n} session listed, activity not observed',
  'announce.unobserved.other': '{n} sessions listed, activity not observed',
  'announce.fullscreen.on': 'Full screen on',
  'announce.fullscreen.off': 'Full screen off',
  'announce.presentation.on': 'Presentation mode on',
  'announce.presentation.off': 'Presentation mode off',
  // Presentation mode: badge (#613)
  'presentation.badge': 'Presentation mode · V to stop',
  'presentation.badge.title': 'Stop presentation mode (V)',
}
