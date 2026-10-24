// Message catalog (#247), domain “playback” (#612): Playback bar: live, review, speed, clearing and truncated history.
// Keys: bar.*. Add a key here with its two languages, fr and en; web/lib/messages.ts assembles the domains.

import { PLAYBACK_LABELS } from '../ui-glossary'

export const fr = {
  // Barre de lecture et mode revue (#587). Le badge reprend les mots de la barre du haut (topbar.connection.*).
  'bar.toolbar': 'Contrôles de lecture',
  'bar.review': 'Revue',
  'bar.review.name': 'Revue : mettre en pause et revoir l’historique',
  'bar.event.one': '{n} événement',
  'bar.event.other': '{n} événements',
  'bar.play': 'Lecture',
  'bar.pause': 'Pause',
  'bar.position': 'Position de lecture',
  'bar.position.value': '{current} sur {total}',
  'bar.duration': 'Durée totale',
  'bar.speed.group': 'Vitesse de lecture',
  'bar.speed': 'Vitesse {s}x',
  'bar.resumeLive': 'Reprendre en direct',
  'bar.clear': 'Effacer l’historique',
  'bar.clear.title': 'Effacer l’historique (garde les agents actifs)',
  'bar.confirmGroup': 'Confirmer l’effacement de l’historique',
  'bar.confirmClear': 'Confirmer l’effacement',
  'bar.cancel': 'Annuler',
  'bar.truncated': 'tronqué',
  'bar.truncated.one': 'Historique tronqué : {n} événement plus ancien supprimé',
  'bar.truncated.other': 'Historique tronqué : {n} événements plus anciens supprimés',
  'bar.review.empty': 'Aucun événement à revoir pour l’instant',
  'bar.markersLost': 'marqueurs manquants',
  'bar.markersLost.one': '{n} marqueur plus ancien non affiché sur la barre (message coupé avant d’être vu)',
  'bar.markersLost.other': '{n} marqueurs plus anciens non affichés sur la barre (messages coupés avant d’être vus)',
} as const

export const en: Record<keyof typeof fr, string> = {
  // Playback bar and review mode (#587). The badge takes the words of the top bar (topbar.connection.*).
  'bar.toolbar': 'Playback controls',
  'bar.review': 'Review',
  'bar.review.name': 'Pause and review history',
  'bar.event.one': '{n} event',
  'bar.event.other': '{n} events',
  'bar.play': 'Play',
  'bar.pause': 'Pause',
  'bar.position': PLAYBACK_LABELS.position,
  'bar.position.value': '{current} of {total}',
  'bar.duration': 'Total duration',
  'bar.speed.group': 'Playback speed',
  'bar.speed': 'Speed {s}x',
  'bar.resumeLive': 'Resume live',
  'bar.clear': 'Clear history',
  'bar.clear.title': 'Clear history (keeps active agents)',
  'bar.confirmGroup': 'Confirm clearing history',
  'bar.confirmClear': 'Confirm clear',
  'bar.cancel': 'Cancel',
  'bar.truncated': 'truncated',
  'bar.truncated.one': 'History truncated: {n} older event dropped',
  'bar.truncated.other': 'History truncated: {n} older events dropped',
  'bar.review.empty': 'No events to review yet',
  'bar.markersLost': 'markers missing',
  'bar.markersLost.one': '{n} older marker not shown on the bar (message cut before it was seen)',
  'bar.markersLost.other': '{n} older markers not shown on the bar (messages cut before they were seen)',
}
