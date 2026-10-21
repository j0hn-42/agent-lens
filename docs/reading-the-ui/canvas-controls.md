## Canvas controls (bottom right)

- **Zoom**: three icon buttons, **Zoom in**, **Zoom out** and **Fit to view**. Their tooltips give the graph keys (`+`, `-`, `0`, see the shortcuts dialog).
- **View**: one button that opens a small panel (Enter or Space opens it, Tab moves into it, Escape or a click outside closes it and Escape returns the focus to the button). The panel holds:
  - **Freeze motion**: stops the ambient animation. Locked on, with a tooltip saying why, when your system asks for reduced motion.
  - the per-layer motion toggles (see below);
  - **Pin cards**: never auto-hides bubbles, tool cards and discoveries;
  - **Hide unanswered calls after**: how long a running tool call with no observed end is waited for before it is treated as expired (1 to 30 min, default 5 min). Expired is neither a success nor a failure.
- **Canvas controls** (#515): when the Legend, Tour, Zoom and View controls do not fit between the top bar and the playback bar (a short window, or a page zoomed to 400 %: at 320 x 256 the two bars leave 18 px, less than one row of 44 px buttons), they fold into a single **Canvas controls** button (*Contrôles du canvas*) at the end of the playback bar, instead of being drawn under the top bar. Enter, Space or a click opens them above the playback bar, in the same order (Legend, Tour, Zoom in, Zoom out, Fit to view, View), over the top bar while they are open; Tab moves into them, Escape or a click outside closes them and Escape returns the focus to the button. When they do not fit in the window's height either, the block scrolls. The guided tour opens it when a step shows the legend; Escape or a click outside still closes it, until the next step that shows the legend. When the tour ends, the focus goes back to the **Canvas controls** button, since the Tour button exists only while the block is open (the first-launch tour offer does the same).
  - Tab order: folded, the controls come after the playback controls (the button is the last stop of the playback bar); unfolded, they come before them, as before. Within one size the order is always Legend, Tour, Zoom in, Zoom out, Fit to view, View.
  - Resizing while the focus is on one of these controls: folding sends the focus to the **Canvas controls** button, unfolding sends it to **View**. If the focus had already left the controls (a click elsewhere), it is not moved.
- These settings were called *Fit*, *Pause animations*, *Keep cards visible* and *Expire unanswered calls after* before. Their behaviour is unchanged. Every label, accessible name and tooltip of these controls comes from the message catalog, in English and in French (*Tout afficher*, *Figer les animations*, *Garder les cartes affichées*, *Masquer les appels sans réponse après*, *Affichage*, *Zoom avant*, *Zoom arrière*), and the block carries `lang`.

## Motion by layer

Besides the global **Freeze motion** setting (and your system's reduced-motion setting), the **View** panel of the canvas controls holds one toggle per layer. A pressed "Calm ..." toggle turns off the ambient motion of that layer only; the state it shows (colours, rings, labels) stays.

| Layer | Calms |
| --- | --- |
| Animated background | depth particles, grid pulse |
| Links | edge pulses, dashed flow, team halos |
| Agents | breathing, scanline, rings, tool-call pulses |
| Effects | message particles and trails, spawn / completion flashes, bloom |

With all four pressed the canvas behaves as under reduced motion. When your system asks for reduced motion, or Freeze motion is on, every toggle is pressed and locked. The choice is kept in your browser. The labels of these controls come from a message catalog (`web/lib/messages.ts`) with French first; the language follows the stored choice, then the browser language, then English.
