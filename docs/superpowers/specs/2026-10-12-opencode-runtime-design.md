# Runtime OpenCode : design

Date : 2026-10-12. Statut : en attente de relecture.

## Objectif

Afficher les sessions [OpenCode](https://github.com/anomalyco/opencode) dans Agent Lens comme celles de Pi ou Gemini : agents, sous-agents, appels d'outils, modèle, tokens. Le runtime est le sixième après `claude`, `codex`, `copilot`, `pi` et `gemini`.

Principe du projet : rien n'est affiché qui ne soit prouvé ([docs/reading-the-ui.md](../../reading-the-ui.md)). Ce qu'OpenCode n'écrit pas en base n'apparaît pas dans l'UI.

## Décisions déjà prises

- Source : la base SQLite locale d'OpenCode, lue en lecture seule. Pas de hook, pas de plugin, pas de client du serveur HTTP/SSE d'OpenCode (issue ultérieure si besoin).
- Aucune installation n'est requise côté utilisateur.

## Hors périmètre

- Flux temps réel (serveur HTTP/SSE), plugin OpenCode, contrôle des permissions.
- Ancien stockage JSON (`storage/session|message|part`), utilisé avant OpenCode 1.2.0. OpenCode a retiré sa migration depuis ; seule la base SQLite est lue.
- Table `session_message` (modèle « v2 »). Le runtime CLI/TUI écrit dans `message` et `part` ; `session_message` n'est alimentée que par le runner v2, dont l'activation par défaut n'est pas vérifiée.
- Import de transcripts OpenCode (`imported-transcripts.ts`).

## Format source (vérifié dans OpenCode v1.19.0)

Référence : tag `v1.19.0` du dépôt `anomalyco/opencode`, fichiers `packages/core/src/database/database.ts`, `packages/core/src/session/sql.ts`, `packages/schema/src/v1/session.ts`.

**Chemin de la base**
- `OPENCODE_DB` s'il est défini : `:memory:` et les chemins absolus tels quels, sinon relatif à `<data>/`.
- Canal `latest`, `beta`, `prod`, ou `OPENCODE_DISABLE_CHANNEL_DB=1|true` : `<data>/opencode.db`. Autre canal : `<data>/opencode-<canal>.db`, caractères hors `[a-zA-Z0-9._-]` remplacés par `-`. Un build de dev utilise le canal `local`.
- `<data>` = `$XDG_DATA_HOME/opencode`, sinon `~/.local/share/opencode`. Le comportement sous Windows est contradictoire entre le code et les notes de release : à vérifier sur une vraie machine, non couvert par ce design.
- La base est en mode WAL (`-wal`, `-shm` à côté).

**Tables lues** (colonnes `time_*` en millisecondes epoch, colonnes JSON en `text`)
- `session` : `id`, `project_id`, `parent_id`, `directory`, `title`, `agent`, `model` (JSON), `cost`, `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`, `time_created`, `time_updated`, `time_compacting`, `time_archived`.
- `message` : `id`, `session_id`, `time_created`, `time_updated`, `data` (JSON sans `id` ni `sessionID`). `role` vaut `user` ou `assistant`. Un message assistant porte `modelID`, `providerID`, `agent`, `parentID`, `time{created, completed?}`, `cost`, `tokens{input, output, reasoning, cache{read, write}}`, `error?`, `path{cwd, root}`.
- `part` : `id`, `message_id`, `session_id`, `time_created`, `time_updated`, `data` (JSON sans `id`, `sessionID`, `messageID`). Types : `text`, `reasoning`, `tool`, `step-start`, `step-finish`, `subtask`, `agent`, `compaction`, `patch`, `file`, `snapshot`, `retry`.
- Part `tool` : `callID`, `tool`, `state.status` parmi `pending`, `running`, `completed`, `error`, avec `input`, `output` ou `error`, `time{start, end}`.

**Sous-agents.** L'outil `task` crée une session enfant (`parent_id` = session parente). La part `tool` du parent porte `state.metadata.sessionId` (session enfant).

**Non observable en base** (jamais affiché) :
- Permission en attente : elle n'existe qu'en mémoire ; la part reste `running`.
- Fin de session : aucun événement durable ne l'indique.
- Texte en cours de streaming : les deltas ne sont pas durables, le texte d'une part n'est écrit qu'à `text-start`, `text-end` et en fin de flux.

## Architecture

Nouvelle famille de fichiers, calquée sur Pi (`extension/src/pi-*.ts`) :

- `extension/src/opencode-db.ts` : localise la base (règles ci-dessus), l'ouvre en lecture seule via `node:sqlite` (même chargement conditionnel que `session-index.ts:104`), expose des requêtes préparées. Si `node:sqlite` est absent ou le schéma inattendu, retourne un état `unavailable` avec un message, jamais de données inventées.
- `extension/src/opencode-event-parser.ts` : fonctions pures, lignes SQL vers `AgentEvent` (`runtime: 'opencode'`). Testable sans base.
- `extension/src/opencode-session-watcher.ts` : implémente `AgentSessionWatcher` (`session-runtime.ts:55`). Sonde la base à intervalle régulier.
- `extension/src/opencode-runtime.ts` : fabrique `startOpenCodeRuntime`, comme `pi-runtime.ts`.

Câblage (extension des unions `'claude'|'codex'|'copilot'|'pi'|'gemini'` et des listes de runtimes) :
- Extension : `session-runtime.ts:18`, `observations.ts`, `extension.ts` (`startRuntimes`), `package.json` (enum `agentVisualizer.runtime`, mots-clés).
- Relay : `scripts/relay.ts` (`RelayRuntimeMode`, `resolveRuntimeMode`, drapeau `wantOpenCode`, démarrage du watcher, listes de runtimes), `scripts/mcp/server.ts`.
- Web : `agent-types.ts`, `bridge-types.ts` (type et validateur), `chrome-utils.ts` (badge `OC`), `session-filter.ts`, `ui-preferences.ts`, `legend-presence.ts` (clé `rt-opencode`), `handle-agent-events.ts`, `conversation-panel.tsx`, `canvas/draw-bubbles.ts`, `draw-agents.ts` (marque), `cluster-model.ts`, `a11y-model.ts`. La couleur du runtime passe par `web/lib/theme-tokens.json` puis `pnpm run gen:themes`.

Le plan d'implémentation reconfirme la liste exacte des occurrences par recherche, car elle vient d'une exploration par `grep`.

## Flux de données

**Sondage.** Un curseur par base : `max(time_updated)` déjà traité, avec un ensemble d'identifiants vus au même timestamp pour éviter les doublons et les pertes. Les parts `tool` sont mises à jour sur place (pending, running, completed), donc le sondage se fait sur `time_updated`, pas sur `time_created`. Chaque lecture est une transaction courte.

**Verrous WAL.** Ouverture en lecture seule, aucun `PRAGMA journal_mode`, transactions courtes. Le dossier de données doit permettre la création de `-shm` ; sinon le watcher passe à `unavailable` avec la cause.

**Cartographie** (tous les champs viennent des colonnes ci-dessus) :

| Source | Événement |
|---|---|
| Ligne `session` vue pour la première fois | `agent_spawn` (runtime `opencode`, titre, `directory`) |
| `session.parent_id` renseigné | `subagent_dispatch` côté parent, `agent_link`, puis `subagent_return` quand la part `task` est `completed` ou `error` |
| `message` assistant, `modelID` | `model_detected` |
| `tokens` du message ou `step-finish` | `context_update` (comptes de tokens ; pas de pourcentage de fenêtre si OpenCode ne l'écrit pas) |
| Part `tool` `pending` ou `running` | `tool_call_start` |
| Part `tool` `completed` ou `error` | `tool_call_end` (statut d'erreur pour `error`) |
| Part `compaction` | `context_compacted` |
| `message.data.error` | `error` (`name` et `data` d'OpenCode) |
| Message assistant avec `time.completed` posé | `agent_idle` |

`agent_complete` et `permission_requested` ne sont jamais émis : non observables.

**Session active.** Une session est active si `time_updated` est récent (même seuil que Pi/Gemini, à reprendre dans l'implémentation) et non archivée (`time_archived` nul).

## Erreurs et robustesse

- JSON invalide ou champ manquant dans `data` : la ligne est ignorée et comptée dans `normalization_stats`, comme pour les autres runtimes.
- Tailles bornées par `event-normalize.ts` (sanitisation existante), y compris pour `input` et `output` d'outils.
- Base absente : le runtime reste inactif sans erreur ; l'UI indique que la base n'a pas été trouvée.
- Schéma sans les tables attendues : état `unavailable` et message explicite.
- Revue par `relay-hardening-reviewer` (chemin issu de `OPENCODE_DB`, lecture seule, bornes) et `a11y-reviewer` (badge, marque canvas, légende).

## Tests (écrits avant le code)

- `extension/test/opencode-event-parser.test.ts` : une fixture par type de part et par état d'outil, erreurs, sous-agents.
- `extension/test/opencode-db.test.ts` : résolution du chemin (canal, `OPENCODE_DB`, XDG), schéma absent, `node:sqlite` absent.
- `extension/test/opencode-session-watcher.test.ts` : base SQLite créée par le test (schéma réduit aux colonnes lues), mise à jour d'une part pendant le sondage, absence de doublons, session archivée.
- `scripts/relay-opencode.test.ts`, calqué sur `relay-gemini.test.ts` (auto-détection, variable d'environnement).
- Tests web existants étendus : `session-filter`, `legend-presence`, validateur de `bridge-types`.
- `docs.test.ts` et `ui-glossary.test.ts` après mise à jour des docs.

## Documentation

- `README.md` : OpenCode dans la liste des agents pris en charge.
- `docs/reading-the-ui.md` : section « Sessions OpenCode » et limites (pas de permissions, pas de fin de session, texte en streaming absent).
- `docs/relay-sources.md` : OpenCode lit une base SQLite, sans hooks.

## Risques

- Aucune installation d'OpenCode n'était disponible : les fixtures sont construites d'après le code source v1.19.0, pas d'après des sessions réelles. La première vérification sur une vraie base se fait après l'implémentation.
- Le schéma évolue (38 migrations entre janvier et juin 2026). Le parseur ne dépend que des colonnes listées et tolère les champs absents.
- Les chemins sous Windows et macOS ne sont pas vérifiés.
