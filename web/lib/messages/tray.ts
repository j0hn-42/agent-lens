// Message catalog (#247), domain “tray” (#612): Tray icon menu (app-tray).
// Keys: tray.*. Add a key here with its two languages, fr and en; web/lib/messages.ts assembles the domains.

export const fr = {
  'tray.open': 'Ouvrir l’interface',
  'tray.copyUrl': 'Copier l’URL locale',
  'tray.sessions.unknown': 'Sessions suivies : inconnu',
  'tray.sessions.one': '{n} session suivie',
  'tray.sessions.many': '{n} sessions suivies',
  'tray.skipped': 'Sessions non suivies : au moins {k}',
  'tray.quit.stopRelay': 'Quitter et arrêter le relais',
  'tray.quit.closeIcon': 'Fermer l’icône, le relais continue',
  'tray.tooltip': 'Agent Lens : {state}',
} as const

export const en: Record<keyof typeof fr, string> = {
  'tray.open': 'Open the interface',
  'tray.copyUrl': 'Copy local URL',
  'tray.sessions.unknown': 'Tracked sessions: unknown',
  'tray.sessions.one': '{n} session tracked',
  'tray.sessions.many': '{n} sessions tracked',
  'tray.skipped': 'Untracked sessions: at least {k}',
  'tray.quit.stopRelay': 'Quit and stop the relay',
  'tray.quit.closeIcon': 'Close the icon, the relay keeps running',
  'tray.tooltip': 'Agent Lens: {state}',
}
