# Démo guidée pas à pas : spécification de conception

Date : 2026-10-09
Statut : validée en conversation, en attente de relecture écrite.

## 1. Objectif

Ajouter une 2ᵉ démo, pédagogique, pilotée par l'utilisateur. Chaque étape explique un élément de l'interface. L'utilisateur comprend ainsi comment elle fonctionne et voit **tous** les éléments de la légende.

### Critères de succès

- Chaque entrée de la légende (`graph-legend.tsx`) est montrée à l'écran, en situation réelle, et expliquée par au moins une étape.
- L'utilisateur avance à son rythme : Suivant, Précédent, accès direct à une étape, Quitter.
- Un test échoue si une entrée de la légende n'est couverte par aucune étape.
- La démo existante (`tour`, `workflow`, classique) reste inchangée.

### Contraintes du dépôt

- Textes en anglais (pas d'i18n), vocabulaire de `web/lib/ui-glossary.ts`.
- Compatible avec tous les thèmes : uniquement des tokens CSS existants.
- Principe de `CONTRIBUTING.md` : ne jamais afficher un état ou un nombre non prouvé. Chaque texte d'étape décrit ce que le scénario produit réellement.
- Tests d'abord ; vérifications CI : `pnpm test`, `pnpm run test:a11y`, `pnpm --dir web exec tsc --noEmit`, lint a11y, e2e si le rendu change.

## 2. Existant utile

- `web/lib/mock-scenario.ts` choisit le scénario (`?scenario=` prioritaire sur `NEXT_PUBLIC_DEMO_SCENARIO`) et exporte `MOCK_SCENARIO`, `MOCK_SESSIONS`, `MOCK_DURATION`.
- `web/lib/tour-scenario.ts` : modèle d'écriture d'un scénario (helpers `at()` et `tool()`, événements triés).
- `web/hooks/use-agent-simulation.ts` expose `play`, `pause`, `restart` et `seekToTime(t)`. `seekToTime` rejoue le scénario depuis zéro jusqu'à `t` : on peut donc avancer et reculer à coût borné, sans modifier le lecteur.
- `web/components/agent-visualizer/graph-legend.tsx` : légende en DOM, 8 sections (états, formes, liens et particules, équipes, liens de messages, contexte, découvertes, runtime). Ouverture mémorisée sous `agent-viz-legend-open`.
- Briques UI réutilisables : `GlassCard`, `shared-ui.tsx`, `use-focus-return`, `lib/clamp-popup-position.ts`, `use-ui-preferences`.
- Il n'existe aucun mécanisme de visite guidée : il est créé ici.

## 3. Conception

### 3.1 Données

**Scénario `guided`** : `web/lib/guided-scenario.ts`, branché dans `mock-scenario.ts` (`?scenario=guided`). Durée visée : 2 à 3 minutes au maximum, pour borner le coût de `seekToTime`. Il fait apparaître au moins une fois chaque entrée de la légende, y compris les cas absents du tour : états `error`, `waiting_permission` et `paused`, lien de message en erreur, branche repliée avec badge `+N`, équipe, les deux runtimes (Claude et Codex), les 4 types de découvertes.

**Étapes** : `web/lib/guided-steps.ts`, en données pures. Chaque étape contient :

| Champ    | Rôle |
|----------|------|
| `id`     | identifiant stable |
| `time`   | instant du scénario où se placer (passé à `seekToTime`) |
| `target` | élément à mettre en surbrillance : agent, panneau ou section de légende |
| `title`, `body` | texte en anglais |
| `covers` | entrées de légende expliquées par l'étape |

Parcours provisoire : bienvenue ; agents et états ; formes ; liens et particules ; outils ; découvertes ; équipes ; messages ; contexte ; runtime ; panneaux (timeline, inspecteur) ; récapitulatif.

**Liste des entrées de légende** : extraite de `graph-legend.tsx` vers une structure de données partagée (ex. `web/lib/legend-entries.ts`) que le composant consomme et que le test de couverture lit. Ajouter une entrée sans l'expliquer fait échouer le test. L'extraction est un refactor sans changement visible.

### 3.2 Contrôleur

`web/hooks/use-guided-tour.ts` : état `{ active, stepIndex }`, reçoit `seekToTime` et `pause`.

- À chaque changement d'étape : `pause()` puis `seekToTime(step.time)`.
- Suivant, Précédent, Aller à l'étape N : changent seulement `stepIndex`.
- Quitter : `play()`, l'interface reste en lecture libre.
- Clavier : `←` et `→` naviguent, `Esc` quitte.
- La logique de navigation est une fonction pure, testable sans rendu.

### 3.3 Interface

- **`GuidedTourCard`** (`guided-tour-card.tsx`), style `GlassCard` : titre, texte, indicateur « Step N / M », Précédent, Suivant, Quitter, liste des étapes. `role="dialog"` **sans** piège de focus : la page reste explorable (zoom, clic sur un agent). Zone `aria-live="polite"` pour annoncer l'étape. À la fermeture, le focus retourne à l'élément précédent (`use-focus-return`).
- **Surbrillance** : anneau DOM positionné sur la cible, via `clamp-popup-position`. Les panneaux et la légende sont ciblés par `data-tour-target`. Les agents du canevas le sont par conversion coordonnées monde vers écran. Le canevas n'est pas modifié.
- **Légende** : une étape ciblant une section ouvre le panneau via l'état existant, **sans** persister `agent-viz-legend-open`, pour ne pas modifier la préférence de l'utilisateur.
- **Points d'entrée** : `?scenario=guided` (démarre directement la visite), `pnpm run dev:demo:guided`, et un bouton « Guided tour » visible uniquement en mode démo.
- **Composition** : montage dans `index.tsx` ; le bouton d'entrée est voisin de la légende (`canvas-controls.tsx`).

## 4. Tests

- `scripts/guided-scenario.test.ts` (modèle : `tour-scenario.test.ts`) : événements triés, types attendus présents, durée cohérente.
- `scripts/guided-steps.test.ts` : union des `covers` égale à la liste complète des entrées de légende ; `time` croissants et dans la durée du scénario ; cibles valides ; titre et texte non vides.
- Test de la navigation pure du hook : avancer, reculer, bornes, quitter.
- `web/tests-a11y/guided-tour.test.tsx` (jsdom + axe) : aucune violation, navigation clavier, `aria-live`, `Esc` et retour du focus.
- `web/tests-a11y/e2e/guided.e2e.ts` (Playwright) : parcours complet par Suivant, cible visible et texte affiché à chaque étape.
- Test sur la conversion monde vers écran, écrit en premier (partie la plus délicate).

## 5. Documentation

- `docs/demo.md` : section « Visite guidée » (lancement, étapes, contrôles).
- `docs/reading-the-ui.md` : renvoi vers la visite depuis chaque section de légende.
- `README.md` : ligne pour `pnpm run dev:demo:guided`.

## 6. Découpage en incréments

1. Extraire les entrées de légende en données partagées (refactor + test de non-régression).
2. Scénario `guided` + son test.
3. Étapes en données + test de couverture.
4. Hook `use-guided-tour` + carte, avec tests a11y.
5. Surbrillance, points d'entrée, e2e.
6. Documentation.

## 7. Hors périmètre

i18n ; mémorisation de la progression entre visites ; modification du tour existant ou de sa documentation ; vidéo ou export.

## 8. Risques

- Conversion monde vers écran pour les agents du canevas : test écrit en premier.
- Coût de `seekToTime` sur un scénario long : durée plafonnée à 2 à 3 minutes.
- Divergence texte/scénario : les exemples chiffrés viennent des événements, jamais écrits en dur.

## 9. Livraison

Branche dédiée du fork, PR vers `jobailla/agent-lens` (jamais vers l'upstream). Branche de base : `develop` (`docs/demo.md`, `docs/reading-the-ui.md` et les derniers thèmes ne sont pas dans `origin/main`).

## 10. Corrections issues de la lecture du code (2026-10-09, avant le plan)

La lecture du code de `develop` a corrigé cinq points de cette spec ; le plan fait foi.

- **Reculer** : `seekToTime` sait déjà rejouer depuis zéro. Précédent est donc instantané, et le lecteur n'est pas modifié. La visite réutilise la séquence du `onSeek` de la barre de lecture (pause, seek, zoom-to-fit), extraite en `handleSeek` dans `index.tsx`.
- **Entrées non démontrables** : aucun événement de la simulation ne produit l'état `paused`, et le repli de branche (`+N`), le lien de message en erreur, l'agent archivé, le lien parent non vérifié et le halo de session dépendent d'actions ou de conditions réelles. Ces entrées sont **expliquées en texte seulement** (`DESCRIBED_ONLY`) ; le texte de l'étape dit qu'elles ne sont pas montrées dans la démo. La section 1 (« voir **tous** les éléments ») se lit donc : tous les éléments sont soit montrés, soit explicitement signalés comme non démontrables.
- **Clavier** : `←`, `→` et `Échap` ne valent que lorsque le focus est dans la carte, pour ne pas détourner la navigation clavier du graphe.
- **Plomberie** : `GraphLegend` est monté par `canvas.tsx`, pas par `index.tsx`. Un contexte React (`TourBridge`) porte l'ouverture de la légende et la conversion monde vers écran (`canvasToScreen`, déjà fournie par `use-canvas-camera`), au lieu de props. Le bouton « Guided tour » n'apparaît que sur `?scenario=guided` : les instants des étapes ne valent que pour ce scénario.
- **Base** : `develop`, pas `main`.
