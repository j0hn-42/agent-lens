# Démo guidée d'Agent Lens

Une démo d'environ 85 secondes qui montre toutes les fonctionnalités sans lancer de vraie session. Les données sont fictives : le scénario est dans `web/lib/tour-scenario.ts`.

```bash
pnpm i
pnpm run dev:demo            # http://localhost:3000
pnpm run dev:demo:classic    # l'ancienne démo, une seule session
```

On peut aussi ajouter `?scenario=tour` à l'URL de n'importe quelle instance en mode démo (`?scenario=workflow` : le workflow seul).

## Avant de commencer

- Fenêtre d'au moins 1280 × 800, thème au choix.
- Désactivez **Hide inactive agents** (bouton de la barre du haut) si vous voulez garder à l'écran les agents terminés. Il est actif par défaut et il masque les sessions finies : c'est une fonctionnalité à montrer, voir l'acte 7.
- Pour l'acte 4, réglez **Expire unanswered calls after** (bas à droite) sur **1 min** avant de lancer : c'est le plus court délai, et le défaut (5 min) dépasse la durée du tour.
- Le tour ne se rejoue pas tout seul : rechargez la page pour recommencer. Le mode **Review** (barre du bas) permet de remonter la timeline et de survoler un instant précis.

## Les trois sessions

| Session | Runtime | Projet | Contenu |
| --- | --- | --- | --- |
| `payments-api · refactor` | Claude Code | `payments-api` | actes 1, 2, 4 |
| `payments-api · release` | Claude Code | `payments-api` (un autre worktree) | acte 3 |
| `docs-site · Codex` | Codex | `docs-site` | acte 5 |

Les deux sessions Claude partagent un projet : la vue **All** les regroupe sous le même projet.

## Déroulé

| Temps | Acte | Ce qu'on montre | Que cliquer / que dire |
| --- | --- | --- | --- |
| 0:00 – 0:06 | **1. Un agent travaille** | L'`orchestrator` reçoit un prompt, réfléchit, lit le code (`Glob`, `Read`, `Grep`), planifie avec `TodoWrite`. | Cliquez l'agent : l'inspecteur donne modèle (pastille `configured`), contexte par catégorie, jetons. Ouvrez **Conversation** : messages, réflexion et appels d'outils au même endroit. |
| 0:06 – 0:15 | **Sous-agents en parallèle** | `explore-agent` et `research-agent` sont dépêchés ensemble puis rendent leur résumé. | `explore-agent` a demandé `opus` et a reçu `sonnet` : la pastille lit **requested != actual**, c'est le cas honnête. Montrez les arêtes parent-enfant. |
| 0:15 – 0:23 | **Outil MCP et permission** | L'appel `mcp__stripe__…` a son propre style (cyan, badge de serveur). Puis l'`orchestrator` attend une permission avant `npm install`. | Dites : « l'état *waiting for permission* est visible, pas deviné ». Repérez le bloc *Permission* dans **Timeline**. |
| 0:24 – 0:38 | **Erreur et reprise** | `test-runner` (modèle `haiku` demandé, obtenu et détecté) lance les tests, échoue, ajoute un setup, relance et passe. | L'appel en échec est marqué en erreur dans le graphe et dans **Conversation**. Ouvrez **Files** : la carte d'attention des fichiers touchés. Ouvrez **$Cost** : coût par agent. |
| 0:39 | **Fin de tour** | L'`orchestrator` passe en *idle* : il attend le prompt suivant, il ne travaille plus. | Dites : « un agent qui a fini son tour n'est pas compté comme actif ». |
| 0:40 – 0:49 | **2. Agent Team et Comms** | `api-dev` et `qa-dev` forment l'équipe `payments-squad` (halo en tirets). Ils s'échangent des messages. | Cliquez le lien entre `api-dev` et `qa-dev` : le panneau de lien lit l'échange. Le badge est le nombre de messages. Montrez les couleurs de coéquipiers et l'état working / idle / done. |
| 0:14 – 1:24 | **3. Workflow à phases** | La session `release` exécute un Workflow : phases **Plan** puis **Build**. | Les membres apparaissent avant l'annonce des phases : le graphe se réorganise. Quand **Plan** est terminé (0:19), ses agents quittent l'écran avec **Hide inactive agents**. |
| 1:15 et 0:52 | **4. Valeurs honnêtes** | Un `WebFetch` lancé à 0:15 dont on ne reçoit jamais la fin, un coût rapporté pour un agent inconnu (0:52), un coéquipier annoncé qui n'a rien produit (0:52). | À 1:15 (une minute après son départ, avec le réglage ci-dessus), l'appel sans fin se lit **fin non observée**, jamais « réussi ». Le coût inconnu apparaît dans **$Cost** comme **unattributed**, hors des agents. Le coéquipier se lit **Not observed yet**. Les totaux partiels de la barre du haut disent **at least** et **estimated**. |
| 0:30 – 1:08 | **5. Une session Codex** | `codex` met à jour des pages de documentation. Ses chiffres de jetons viennent du runtime, avec l'effort de raisonnement (`high`). | Dites : « Claude Code et Codex côte à côte, étiquetés par runtime ». Montrez la fenêtre de contexte de 272 000 jetons. |
| tout le long | **6. Vue All (Fleet)** | Trois sessions sur un canevas, chacune dans un halo pointillé ; deux sont sous le même projet. | Cliquez un halo pour zoomer sur le cluster. Ouvrez **Sessions** : l'arbre sessions, agents et sous-agents ; le menu contextuel (clic droit) ; **Legend** en bas à gauche explique chaque forme. |
| à la fin | **7. Les filtres** | **Hide inactive agents** masque les agents terminés. | Désactivez-le pour retrouver toute l'histoire. Montrez **Timeline**, **Stats** et **Shortcuts**. |

Le temps des actes se chevauche (les sessions tournent en parallèle) : suivez l'horloge de la barre du bas, pas l'ordre des lignes.

## Ce que la démo ne peut pas montrer

Ces fonctionnalités demandent un vrai relais et ne se voient qu'avec `pnpm run dev` et une vraie session :

- le panneau **Context** (`CLAUDE.md` et index mémoire) : « not available in demo mode » ;
- les liens **issues et PR** (`gh` sur le dépôt `origin`) de l'inspecteur ;
- la source hooks et la réconciliation avec les transcripts JSONL, et l'action `observations`.

## Modifier le scénario

`web/lib/tour-scenario.ts` écrit les événements acte par acte. Le test `scripts/tour-scenario.test.ts` garantit que le tableau reste trié par temps (le lecteur le consomme dans l'ordre), que chaque type d'événement est joué, que chaque session déclarée est utilisée, et que le tour contient bien un agent Codex, un modèle demandé différent du modèle réel, un effort, une équipe, un workflow avec phases, un lien Comms avec messages, un coût non attribué et un appel en erreur.
