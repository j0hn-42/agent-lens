# Panneau Issues · Agents · PR : spécification de conception

Date : 2026-10-17
Statut : proposition issue d'un brainstorming avec l'utilisateur. Aucun code de production n'est écrit avant validation. Les passages marqués « décision » viennent de l'utilisateur ; ceux marqués « mon choix » sont des choix de conception à relire.

## 1. Intention

### Le besoin

L'utilisateur lance 3 à 5 agents en parallèle, parfois jusqu'à 8. Il écrit à l'agent « fais l'issue #n » ; c'est l'agent qui crée son worktree et sa branche (`fix/<n>-...`, voir `CLAUDE.md`), puis qui ouvre sa PR avec `gh pr create` (`Closes #n`, étiquette `agent:<rôle>`).

Aujourd'hui, **l'utilisateur doit retenir de tête quel agent travaille sur quelle issue**. C'est le problème à résoudre, avant tout affichage.

### Le but

Quand le dépôt est sur GitHub, un panneau latéral du canvas montre d'un coup d'œil : quelle issue est traitée par quel agent, et quelle PR en résulte, avec pour chaque lien le niveau de preuve.

### Non-buts

- Pas de GitLab dans cette première livraison (décision : GitHub d'abord, GitLab ensuite).
- Aucune consommation de tokens supplémentaire : pas de message envoyé à un agent, pas d'injection de contexte par hook (voir §4).
- Pas de vue qui remplace le canvas (décision : un panneau sur le côté du canvas).
- Ne pas modifier les issues, les PR ni les étiquettes depuis le panneau.

### Anti-buts (échec même si ça « marche »)

- Afficher un lien agent → issue faux, ou présenter « on ne sait pas » comme « aucun ». Principe du projet : [reading-the-ui.md](../../reading-the-ui.md).
- Un niveau de preuve exprimé par la seule couleur.

## 2. Existant (lu dans `develop` au 2026-10-17)

- `scripts/relay.ts` : `sessionBranch` (l. 278) n'est rempli qu'**une fois**, depuis l'en-tête du transcript (l. 449 et 497). Pour une session qui démarre sur `develop` puis crée sa branche, c'est la mauvaise branche. Le « (this session) » du panneau Context peut donc rater la PR de la session.
- `extension/src/team-watcher.ts` (l. 58 et 237-241) sait déjà lire `gitBranch` dans les lignes d'un transcript, avec nettoyage de la valeur.
- `extension/src/session-work.ts` : `gh pr list --json number,title,url,isDraft,headRefName,statusCheckRollup` (l. 159) et la liste des issues. « Issue sans agent » y signifie « sans étiquette `agent:*` », pas « qu'aucune session ne traite ».
- `extension/src/issue-links.ts` : `GET /issue-links?role=<rôle>` par étiquette `agent:<rôle>`. Relie un rôle, pas une session. `normalizeRepoUrl` (l. 75) n'accepte que github.com.
- `web/lib/git-state.ts` : lit l'URL imprimée par `gh pr create` et la sortie de `git checkout`/`git switch` dans les appels d'outils. C'est aujourd'hui le seul chemin **prouvé** agent → PR.
- `closingIssuesReferences` n'est lu nulle part.
- `POST /launch` (#229, désactivé par défaut, jeton, 1 ou 2 lancements) fixe lui-même le `sessionId` et l'issue et les écrit dans un journal : le lien y est prouvé.
- Panneaux latéraux : largeur par défaut 480 px (`SESSIONS_PANEL_WIDTH`), redimensionnables avec `DockResizer` (`web/components/agent-visualizer/session-list-panel.tsx`).
- Les hooks ne renvoient un corps que pour `PermissionRequest` ; il n'existe aucun canal du relais vers un agent déjà lancé.

## 3. Niveaux de preuve

Quatre niveaux, toujours écrits en mots dans l'interface et dans l'annonce pour lecteur d'écran, jamais par la couleur seule :

| Niveau | Source | Lien concerné |
|---|---|---|
| **prouvé** | URL imprimée par le `gh pr create` de cette session ; `gh pr list --json closingIssuesReferences` (GitHub résout `Closes #n`) ; lancement par Agent Lens (journal) | agent → PR, PR → issue, agent → issue |
| **confirmé par l'utilisateur** | clic sur « Confirmer #n » | agent → issue |
| **probable** | `#n` dans le premier prompt, ou numéro dans la branche courante de la session | agent → issue |
| **inconnu** | aucun des indices ci-dessus | tous |

Règles :

- La branche lue dans le transcript est un `gitBranch` **déclaré** par Claude Code. Une PR rapprochée d'une session par cette seule branche est **probable** (trait en tirets), pas un cinquième niveau : elle devient **prouvée** dès que l'URL de PR imprimée par `gh pr create` est lue (mon choix, voir §8).
- Plusieurs `#n` dans le premier prompt : le lien reste « probable » et le panneau n'en choisit pas un à la place de l'utilisateur.
- Un agent sur plusieurs issues : une liste de liens, chacun avec son niveau. Si une issue est reprise par un autre agent, le lien prouvé le plus récent l'emporte et l'ancien passe en « historique ».
- Une PR ou une issue lue chez GitHub porte l'heure de lecture (« lu à 14:02 »). Si le rafraîchissement échoue (limite de débit de `gh`), le panneau dit « non rafraîchi », jamais « aucune ».
- Un dépôt qu'on ne peut pas prouver (worktree d'un autre dépôt que le cwd, session hors git, scope « tous les workspaces » sans dépôt prouvé) : pas de lien affiché, colonne PR « inconnu ».

## 4. Décisions de conception

### 4.1 Aucune communication vers l'agent (décision d'après l'avis d'un conseiller)

Le relais déduit tout du transcript, des hooks déjà reçus et de GitHub. Une injection par hook (`SessionStart`, `UserPromptSubmit`) a été écartée : ses quelques dizaines de tokens restent dans le contexte et sont renvoyés à chaque tour, le hook est rejoué après `/compact`, et au démarrage l'issue n'est pas connue. Le prompt arrive déjà au relais dans le payload de `UserPromptSubmit`. La consigne de nommage existe déjà dans `CLAUDE.md`. À rouvrir seulement si l'inférence s'avère insuffisante.

### 4.2 Disposition (décisions)

Panneau sur le côté du canvas, redimensionnable avec la poignée existante. La disposition **s'adapte à la largeur** :

- **Étroit (≈ 480 px)** : une chaîne verticale par agent, « issue → agent → PR », avec les mêmes traits de preuve (plein = prouvé, tirets = probable). Le panneau défile verticalement.
- **Large (≈ 900 px et plus)** : une ligne horizontale par agent, trois cases reliées.
- Issues sans agent et PR sans issue : cartes en pointillés, listées à la suite (mon choix : après les chaînes).
- **Sous-agents (décision)** : repliés par défaut dans la carte de leur agent, avec un résumé d'états réellement observés (« ▸ 3 sous-agents : 2 travaillent, 1 fini »). Dépliable au clic ou à Entrée. Le lien issue/PR est celui de la session : les traits partent de l'agent principal, jamais d'un sous-agent.
- Bouton « Confirmer #n » sur un lien « probable » (mon choix). Bouton « Associer une issue » sur un agent « inconnu » (mon choix).
- Les maquettes validées sont dans `.superpowers/brainstorm/` de la session de brainstorming et ne sont pas versionnées.

### 4.3 Accessibilité (WCAG 2.1 AA, imposée par la CI)

- Chaque lien est doublé d'un texte lisible (« PR #461, prouvé ») : un trait n'est jamais le seul porteur d'information.
- Navigation au clavier, noms accessibles, couleurs issues de `web/lib/theme-tokens.json` (puis `pnpm run gen:themes`), respect de `prefers-reduced-motion`.
- Ne pas élargir `web/tests-a11y/lint-baseline.json` ni `known-violations.json`.
- Le contenu nominatif (noms de sessions, titres d'issue) porte `data-sensitive` pour le mode présentation.

### 4.4 Forges (décision : GitHub d'abord)

Livraison 1 : GitHub uniquement, via `gh`. Mais le code est écrit derrière une interface minimale (`ForgeProvider` : détecter le dépôt, lister PR ouvertes, lister issues ouvertes, issues fermées par une PR) pour que GitLab (`glab`, MR, `closes_issues`) soit une seconde implémentation. Le vocabulaire « PR » ou « MR » vient du fournisseur. Même validation stricte des URL pour chaque forge ; un hôte autohébergé doit être déclaré explicitement.

## 5. Découpage proposé (mon choix)

1. **Fiabiliser les liens (relais et extension)** : suivre la branche courante de chaque session (réutiliser la lecture de `gitBranch` de `team-watcher.ts`), ajouter `closingIssuesReferences` à la liste des PR, extraire `#n` du premier prompt, exposer le tout avec son niveau de preuve par une route lecture seule.
2. **Panneau** : composant, disposition adaptative, sous-agents repliés, « Confirmer #n » (état local au navigateur, jamais écrit dans un transcript), tests d'accessibilité.
3. **`ForgeProvider`** : l'interface avec l'implémentation GitHub existante. GitLab est une livraison ultérieure.

Chaque partie peut être une issue séparée, avec les étiquettes `agent:<rôle>` du dépôt. Le test est écrit d'abord.

## 6. Contraintes

- Le relais reste en lecture seule et sur loopback ; la route nouvelle passe par le limiteur et le cache existants (`relay.ts`, `issueLinksLimiter`). Revue par `relay-hardening-reviewer`.
- `gh` sans shell, avec délai, comme dans `issue-links.ts`. Toute URL renvoyée est revalidée.
- Revue UI par `a11y-reviewer`.
- Mise à jour de `docs/reading-the-ui.md` (le test `scripts/docs.test.ts` en vérifie une partie).

## 7. Laissé au développeur

- Le nom exact de la route, du composant et du raccourci clavier d'ouverture du panneau.
- Les seuils de largeur exacts entre les deux dispositions.
- L'ordre et le style des cartes orphelines.
- Le libellé exact des niveaux de preuve (à faire passer par `ui-glossary.test.ts`).
- La forme du stockage de « Confirmer #n » dans le navigateur (clé, durée de vie).
- Le comportement quand le premier prompt est trop long ou ne contient aucun `#n`.

## 8. Choix faits après relecture par un développeur extérieur (mon choix, à relire)

1. **Pas de cinquième niveau « déclaré ».** Il n'y a que quatre niveaux (§3). Un rapprochement par la seule branche déclarée est « probable ».
2. **Le relais calcule le niveau final.** La nouvelle route lit les événements du transcript que le relais a déjà (dont l'URL de `gh pr create`, que `web/lib/git-state.ts` extrait aujourd'hui côté navigateur : le même extracteur est partagé) et la combine avec `gh`. Le navigateur n'affiche que ce que la route renvoie, avec le niveau. Le panneau fonctionne comme la section Context existante : avec le relais (app autonome et relais de développement) et en mode démo avec des données simulées.
3. **Issues sans agent.** Seules les issues ouvertes reliées à une session, plus celles qui portent une étiquette `agent:*` et qu'aucune session ne tient. Même plafond que l'existant (`ISSUE_LINKS_MAX`, 50) et même formulation « au moins N » quand la liste est tronquée.
4. **Sessions et durée.** Une session terminée garde sa chaîne tant qu'elle reste dans la liste des sessions du relais (règle existante des sessions terminées). L'« historique » d'un lien remplacé n'existe qu'en mémoire : un redémarrage du relais l'efface. Rien n'est persisté côté relais.
5. **Une preuve se transmet.** Si agent → PR est prouvé et PR → issue est prouvé (`closingIssuesReferences`), alors agent → issue est affiché « prouvé, via la PR #n ».
6. **Deux agents sur la même issue sans preuve.** Les deux liens sont affichés, chacun avec son niveau, avec la mention « 2 agents annoncent #n ». Une confirmation de l'utilisateur ne remplace jamais une preuve : si un autre agent a le lien prouvé, les deux sont affichés et le conflit est dit. Le panneau ne choisit jamais un gagnant à la place de l'utilisateur.
