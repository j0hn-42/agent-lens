## Review and playback

- **Review on an empty timeline**: with no event on the timeline there is nothing to review. The Review button stays focusable but is marked unavailable (`aria-disabled`), its reason ("No events to review yet") is linked to it, and a click or the Space shortcut shows that sentence as a notice instead of opening an empty review mode. Once a review is open, Pause and Play keep working even if the timeline is later emptied by a reload.
- **Review (pause) and switching session**: Review pauses the scene; events that arrive meanwhile wait in a queue, and Resume live reports how many. If you switch session while reviewing, the queue of the session you leave is not dropped: the position it had reached is kept with that session, so the events received while paused (and those received during the switch itself) are replayed when you come back. The view you switch to is live, so the review ends with a short notice ("Review ended: session changed") and the bar shows the live controls again; it never shows Review over a scene that is playing.

### In your language

- the playback bar and the review mode (#587): the badge (*EN DIRECT*, *CONNECTÉ*, *CONNEXION*, *HORS LIGNE*, *DÉMO*, the same words as the top bar), *Revue*, the play, speed and slider names (*Position de lecture*, "1:15 sur 1:02:05"), *Reprendre en direct*, *Effacer l’historique* and its confirmation, and the mark of a truncated history with the number of events dropped.
