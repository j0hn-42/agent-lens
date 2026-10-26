# Agent Lens

[![CI](https://img.shields.io/github/actions/workflow/status/j0hn-42/agent-lens/ci.yml?branch=main&label=CI)](https://github.com/j0hn-42/agent-lens/actions/workflows/ci.yml)
[![Licence : Apache 2.0](https://img.shields.io/badge/licence-Apache--2.0-blue)](LICENSE)
[![Version](https://img.shields.io/github/package-json/v/j0hn-42/agent-lens?filename=extension%2Fpackage.json&branch=main&label=version)](extension/CHANGELOG.md)

**Un canevas en direct de vos agents de code.** Voyez ce que Claude Code, Codex, GitHub Copilot, Pi, Gemini CLI et OpenCode pensent, quels outils ils appellent et comment ils se passent le travail, au moment où cela se produit.

*[English](README.md) · Français*

![Agent Lens suit une session Claude Code : un orchestrateur lit le code, puis dépêche deux sous-agents qui travaillent en parallèle](docs/media/hero.gif)

[Voir la vidéo du tour](docs/media/tour.mp4) · [L'essayer sans session](#démarrage-rapide) : `pnpm run dev:demo`

> Agent Lens est basé sur [Agent Flow](https://github.com/patoles/agent-flow) de Simon Patole (licence Apache 2.0). Voir [Origine et crédits](#origine-et-crédits).

La documentation détaillée est en anglais (sauf la [démo guidée](docs/demo.md)). Ce fichier présente le projet en français.

## Pourquoi Agent Lens ?

Une session d'agent est une boîte noire : on voit le résultat final, pas le parcours. Agent Lens montre le parcours : retrouver les appels d'outils qui ont mené à un échec, repérer le travail lent ou répété, comprendre comment les sous-agents se coordonnent, apprendre comment vos prompts sont exécutés. Il lit ce que les agents laissent sur votre machine et n'affiche que ce qu'il peut prouver : un état inconnu se lit « Not observed », un total partiel se lit « at least X ».

![Les mêmes événements en journal brut et dans Agent Lens](docs/media/before-after.png)

## Démarrage rapide

```bash
npx agent-lens
```

Il sert l'application, ouvre http://localhost:3001 et configure les hooks de Claude Code pour vous. Lancez une session Claude Code, Codex ou autre dans un autre terminal : les événements arrivent dans le navigateur au fil de l'eau. Pas besoin de cloner.

Pour travailler sur Agent Lens lui-même, ou essayer le tour de démo (`pnpm run dev:demo` joue toutes les fonctions sur des données fictives), lancez-le depuis les sources :

```bash
git clone https://github.com/j0hn-42/agent-lens.git
cd agent-lens
pnpm i && pnpm run setup && pnpm run dev    # http://localhost:3000
```

Prérequis : [Node.js](https://nodejs.org/) 20+ (22.13+ pour lire les sessions OpenCode) et le CLI d'au moins un des runtimes ci-dessus ; [pnpm](https://pnpm.io/) seulement pour lancer depuis les sources.

## Ce que vous voyez

- **Un canevas en direct** : agents, sous-agents et appels d'outils sous forme de graphe interactif, avec branches et retours. Cliquez sur un élément pour l'inspecter.
- **Toutes les sessions à la fois** : la vue Fleet (All) met toutes les sessions suivies sur un seul canevas, regroupées par projet, à côté d'un panneau Sessions qui les liste en arbre.
- **Timeline, Files et Conversation** : la chronologie complète, les fichiers touchés ou modifiés à plusieurs, et une conversation unique pour les messages et les appels d'outils.
- **Des valeurs honnêtes** : rien n'est affiché sans preuve ; ce qui est deviné ou partiel le dit ([ce que chaque mention veut dire](docs/reading-the-ui/honest-values.md), en anglais). Les vues sont expliquées dans [Reading the UI](docs/reading-the-ui.md).
- **Replay et démo** : exportez une session en un fichier HTML hors ligne avec une barre de lecture au clavier ; un tour guidé tourne sur des données fictives.
- **Neuf thèmes sombres et WCAG 2.1 AA** : à choisir dans **Settings** ; l'accessibilité est vérifiée en CI.

<table>
  <tr>
    <td><a href="docs/media/fleet.png"><img src="docs/media/fleet.png" alt="La vue Fleet : une équipe, un workflow et une session Codex regroupés sur un canevas"></a></td>
    <td><a href="docs/media/comms.png"><img src="docs/media/comms.png" alt="Le panneau Conversation avec les messages échangés par deux coéquipiers"></a></td>
    <td><a href="docs/media/cost.png"><img src="docs/media/cost.png" alt="Le panneau Cost : coûts par agent marqués estimés, avec une ligne non attribuée"></a></td>
  </tr>
  <tr>
    <td align="center">Vue Fleet</td>
    <td align="center">Comms entre agents</td>
    <td align="center">Le coût, avec ses limites</td>
  </tr>
</table>

Le détail, avec chaque limite énoncée, est dans [Features](docs/features.md) : workflows et équipes, lectures répétées, rapport de délégation, panneau Context, jauges de quota, commandes headless, serveur MCP et plus.

## Runtimes

Agent Lens les suit tous en même temps et étiquette chaque session avec son runtime.

| Runtime | Lit | Limites connues |
| --- | --- | --- |
| Claude Code | hooks, plus transcripts dans `~/.claude/projects/` | |
| Codex | rollouts dans `~/.codex/sessions/` | |
| GitHub Copilot | `~/.copilot/session-state/` | sessions locales seulement, pas celles hébergées dans le cloud |
| Pi | `~/.pi/agent/sessions/` | pas de sous-agents ; jetons et coût pas encore lus |
| Gemini CLI | `~/.gemini/tmp/` | pas de sous-agents dessinés ; jetons et coût pas encore lus |
| OpenCode | sa base SQLite, en lecture seule | Linux seulement pour l'instant ; demande Node 22.13+ ; sessions des 10 dernières minutes |

Cursor n'est pas encore supporté. La [feuille de route](docs/roadmap.md) dit ce qui est livré, partiel ou bloqué.

## Installation

**Avec npx** : `npx agent-lens` lance l'application autonome (sert l'interface et le relais, ouvre le navigateur ; `--port <n>`, `--no-open`, `--all-workspaces`). **Depuis les sources** : les commandes du [démarrage rapide](#démarrage-rapide), ou `pnpm run build:app` puis `node app/dist/app.js` pour la même application.

**Extension VS Code** : construisez le `.vsix` depuis les sources et installez-le. Fonctionne avec VS Code 1.85+, [Cursor](https://cursor.sh/) et [Windsurf](https://windsurf.com/).

```bash
pnpm --filter agent-lens run package
code --install-extension extension/agent-lens-<version>.vsix
```

Lancez ensuite **Agent Lens: Open Agent Lens** depuis la palette de commandes. Les étapes complètes, le choix du runtime, la portée des sessions analysées et les réglages sont dans [Install and configure](docs/install.md) et la [référence](docs/reference.md). Quelque chose n'apparaît pas ? Voir la [FAQ](docs/faq.md).

## À qui s'adresse-t-il

**Pour** les personnes qui lancent des agents de code et veulent voir ce qu'ils ont fait : pourquoi une session a mal tourné, où sont passés le temps et les jetons, quels fichiers ont été relus encore et encore.

**Pas pour** : un service hébergé (il tourne sur votre machine et n'envoie aucune télémétrie), un framework d'agents, ni un outil de facturation (les coûts sont des estimations à partir des jetons qu'un runtime rapporte, et le disent). Il observe. Deux fonctions optionnelles, désactivées par défaut, peuvent agir : le [contrôle opérateur](docs/operator-control.md) dans VS Code et le [lancement d'un agent](docs/launch-security.md).

## Documentation

- [Features](docs/features.md) : chaque fonction, avec ses limites
- [Install and configure](docs/install.md) et [Reference](docs/reference.md) : commandes, réglages, scripts
- [FAQ and troubleshooting](docs/faq.md)
- [Reading the UI](docs/reading-the-ui.md) : les vues, et ce que veulent dire « Not observed », « at least », « estimated » et « unattributed »
- [Démo guidée](docs/demo.md) : le script de présentation qui montre chaque fonction sur des données fictives
- [Roadmap](docs/roadmap.md) : les runtimes livrés, partiels ou bloqués

Pour contribuer (branches, labels, contrôles d'accessibilité, releases), voir [CONTRIBUTING.md](CONTRIBUTING.md).

## Origine et crédits

Agent Lens est basé sur [Agent Flow](https://github.com/patoles/agent-flow), créé par [Simon Patole](https://github.com/patoles) pour [CraftMyGame](https://craftmygame.com). Le code, l'architecture et le design visuel d'origine d'Agent Flow sont le socle de ce projet, et nous remercions son auteur.

Ce dépôt est une continuation indépendante, avec son propre nom, ses icônes, sa feuille de route et ses mainteneurs. Il n'est ni affilié à Agent Flow ni approuvé par lui. Les changements faits depuis le fork sont listés dans [NOTICE](NOTICE) et dans l'historique git ; l'historique avant le fork est celui d'Agent Flow.

## Vie privée et télémétrie

Agent Lens n'envoie **aucune télémétrie** : le point de collecte hérité d'Agent Flow a été supprimé, donc rien ne quitte votre machine et rien n'est écrit sur disque à des fins statistiques. Si vous voulez de la télémétrie pour votre propre déploiement, renseignez votre point de collecte et votre clé publique dans `scripts/telemetry.ts` et reconstruisez. La télémétrie reste aussi désactivée quand `DO_NOT_TRACK=1` ou `AGENT_LENS_TELEMETRY=false` est défini.

## Licence

Apache License 2.0, voir [LICENSE](LICENSE). Les mentions de copyright d'origine sont conservées et les modifications sont indiquées dans [NOTICE](NOTICE), comme l'exige la licence.
