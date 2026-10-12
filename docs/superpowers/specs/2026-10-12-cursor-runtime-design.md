# Runtime Cursor : conception courte

Date : 2026-10-12
Statut : proposition, en attente de validation dans l'issue #238. Aucun code n'est écrit avant cette validation.
Refs #238.

## 1. Contexte

L'épopée #238 (autres runtimes) exige une conception courte, validée dans l'issue, avant le code. État au 2026-10-12 :

- **Pi** : livré (PR #327, `extension/src/pi-*.ts`).
- **Gemini CLI** : livré (PR #334, `extension/src/gemini-*.ts`).
- **OpenCode** : extrait dans #346 ; sa spec (SQLite en lecture seule) attend une relecture sur la branche `feat/opencode-runtime`. Ce document n'y touche pas.
- **Antigravity** : gelé, faute de format public (protobuf non documenté).
- **Cursor** : sans branche, sans spec, sans issue. C'est l'objet de ce document.

La conception de l'issue place Cursor sur la voie des hooks (`~/.cursor/hooks.json`). Cette voie écrit dans la configuration de l'utilisateur. C'est une décision de sécurité et de produit, à trancher avant toute implémentation.

## 2. Sources primaires

Statut de chaque point : **vérifié** (documentation officielle lue le 2026-10-12), **forum** (réponse du personnel Cursor ou rapport d'utilisateur, non officiel) ou **non vérifié**.

| Point | Statut | Source |
|---|---|---|
| Fichier `~/.cursor/hooks.json` (utilisateur), `<projet>/.cursor/hooks.json`, entreprise `/etc/cursor/hooks.json` ; tous les hooks qui correspondent s'exécutent | vérifié | [1] |
| Schéma : `version: 1`, `hooks: { <événement>: [{ command, type, timeout, matcher, failClosed, loop_limit }] }`. Types `command` et `prompt` seulement : **aucun type HTTP** | vérifié | [1] |
| Événements : `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `subagentStart`, `subagentStop`, `stop`, `beforeShellExecution`, `afterShellExecution`, `afterFileEdit`, `afterAgentResponse`… | vérifié | [1] |
| Entrée JSON sur stdin, sortie JSON sur stdout. Code 2 = bloque l'action. Pour un hook de permission (`preToolUse`, `subagentStart`…), un JSON invalide **bloque** l'action | vérifié | [1] |
| Champs communs : `conversation_id`, `generation_id`, `model`, `hook_event_name`, `cursor_version`, `workspace_roots`, `user_email`, `transcript_path` (null si transcripts désactivés) | vérifié | [1] |
| `subagentStart` : `subagent_id`, `subagent_type`, `parent_conversation_id`, `tool_call_id`, `subagent_model`. `subagentStop` : `status`, `duration_ms`, `agent_transcript_path` ; présence de `subagent_id` à l'arrêt **non vérifiée** | vérifié (sauf mention) | [1] |
| Aucun champ de coût ni d'usage de tokens dans les entrées de hooks | vérifié (absence dans la doc) | [1] |
| Format du fichier `transcript_path` | **non documenté** | [1] |
| Hooks dans le CLI (`cursor-agent`) : seulement `beforeShellExecution` / `afterShellExecution`, support complet « sans date » | forum (personnel) | [2] |
| CLI sous Linux : aucun hook déclenché (version 2026.08.11), alors que macOS fonctionne | forum (utilisateur) | [3] |
| Stockage CLI `~/.cursor/chats/<hash-workspace>/<uuid>/`, local uniquement ; algorithme du hash inconnu | forum (personnel) ; format **non vérifié** | [4] |
| Stockage IDE : `state.vscdb` (SQLite) et `~/.cursor/projects/<projet>/agent-transcripts/` ; pas de synchronisation avec le CLI | forum ; **non vérifié** | [4] |
| Cursor charge des hooks tiers « comme Claude Code » ; fichiers lus, opt-in et correspondance des champs non documentés | vérifié (existence) ; détails **non vérifiés** | [5], [6] |

Point d'attention tiré de [5] et [6] : si Cursor exécute les hooks de `~/.claude/settings.json`, le `hook.js` d'Agent Lens déjà installé peut recevoir des charges au format Cursor et les présenter comme une session Claude Code. À vérifier sur une machine réelle, quelle que soit l'option retenue (question ouverte 4).

## 3. Options

### A. Lecture seule de `transcript_path` ou de `~/.cursor/chats`, sans hook

Un watcher (`cursor-session-watcher.ts`) découvre les fichiers et les suit ; un parseur pur (`cursor-event-parser.ts`) les traduit, sur le modèle de Copilot, Pi et Gemini. Sans hook, `transcript_path` n'est jamais transmis : il faut deviner son emplacement, c'est-à-dire s'appuyer sur un stockage non documenté.

### B. Hooks Cursor vers le serveur de hooks loopback existant

Cursor n'a pas de hook HTTP : l'entrée de `hooks.json` lance une commande (un script `cursor-hook.js`, sur le modèle de `hook.js`). Le script lit stdin, fait un POST vers `extension/src/hook-server.ts` (127.0.0.1 seulement, contrôle de l'en-tête Host, limite de débit, `validateHookPayload` de `hook-guards.ts`), puis écrit `{}` et sort avec le code 0, toujours. L'écriture de `~/.cursor/hooks.json` reprend la mécanique de `hooks-config.ts` et `scripts/claude-hooks.js` (via `settings-writer.ts`) : action explicite de l'utilisateur, écriture atomique, ajout de nos seules entrées, retrait par une commande dédiée et à la désinstallation, fichiers illisibles laissés intacts.

### C. Geler Cursor

Garder #238 ouverte pour Cursor avec le statut « bloqué » et revenir quand le CLI prendra en charge les hooks ou quand un format de transcript sera documenté.

## 4. Analyse

| | A. Lecture seule | B. Hooks | C. Gel |
|---|---|---|---|
| **Prouvable dans l'UI** | Rien de garanti : format non documenté, donc chaque champ dépend d'une rétro-ingénierie. Parent de sous-agent seulement si le fichier le porte explicitement. | Outils (début et fin appariés par `tool_use_id`), statut d'arrêt, sous-agent avec un lien parent **vérifié** (`parent_conversation_id`, `tool_call_id`), modèle tel que déclaré (`model`, `subagent_model`). Coût : jamais affiché (absent de la source). Coût en tokens : aucun, pas d'estimation présentée comme une mesure. | Rien. |
| **Sécurité** | Aucune écriture. Lecture de fichiers locaux avec plafonds de taille, comme les autres watchers. | Écriture dans la config de l'utilisateur, d'où consentement et réversibilité. Notre hook s'exécute à **chaque** appel d'outil : il ne doit jamais bloquer (sortie `{}`, code 0, délai court, pas de `failClosed`), car un JSON invalide sur `preToolUse` bloque l'agent. Écoute en loopback seulement ; le relais n'exécute aucune commande. `user_email` est supprimé dès la réception, jamais relayé ni journalisé. `tool_input` et `tool_output` sont traités comme ceux de Claude Code (redaction existante). | Aucun risque. |
| **Effort** | Moyen à élevé, et à refaire à chaque changement de format. | Moyen : serveur, garde-fous et installeur existent ; il faut une table de correspondance Cursor → `AgentEvent`, le script et l'installeur `hooks.json`. | Nul. |
| **Couverture** | IDE et CLI, si le format est stable. | IDE seulement aujourd'hui (CLI : shell seulement, Linux douteux, voir [2] et [3]). | Aucune. |

### Tests à écrire d'abord

Sur le modèle de `extension/test/copilot-*.test.ts`, `pi-*.test.ts` et `gemini-*.test.ts`. La fixture `extension/test/fixtures/cursor-sample.jsonl` est produite depuis de vraies charges de hooks (ou un vrai transcript pour l'option A), puis anonymisée : chemins, `user_email` et contenus remplacés.

Option B :

- parseur : `preToolUse` puis `postToolUse` du même `tool_use_id` donnent un début et une fin ; `postToolUseFailure` donne une erreur ; un événement inconnu est ignoré ; une ligne partielle ou invalide n'émet rien ;
- sous-agent : créé seulement avec `parent_conversation_id` ; sans lui, aucun parent n'est inventé ;
- `model` absent : rien n'est affiché ; aucun coût n'est émis, jamais ;
- `user_email` n'apparaît dans aucun événement émis ;
- script : écrit toujours `{}` et sort avec le code 0, même si le serveur est absent, lent ou répond une erreur ;
- installeur : n'écrit rien sans consentement ; ajoute ses entrées sans toucher à celles de l'utilisateur ; le retrait rend le fichier identique à l'original ; un `hooks.json` illisible n'est pas réécrit ;
- serveur : une requête Cursor non loopback ou avec un Host étranger est refusée (extension des tests de `hook-guards`) ;
- filtre de session : extension de `scripts/session-filter.test.ts` pour le runtime `cursor`.

Option A : mêmes tests de parseur, plus ceux du watcher (racine absente, override par variable d'environnement, filtre de workspace).

## 5. Recommandation

**B, sous condition, et C tant que la condition n'est pas remplie.**

- B est la seule option dont chaque donnée affichée est prouvée par un format documenté : lien parent explicite, appariement par `tool_use_id`, modèle déclaré. A repose sur un stockage non documenté et contredit le principe de `docs/reading-the-ui.md`.
- La sécurité de B tient à des mécanismes existants et testés (serveur loopback, garde-fous, installeur réversible des hooks Claude Code). Le seul risque nouveau, bloquer l'agent par une sortie invalide, se couvre par un test.
- Condition avant le code : valider dans #238 (1) le consentement et l'emplacement de l'écriture, (2) le fait de cibler l'IDE seul, le CLI étant marqué « non pris en charge » dans la doc tant que ses hooks sont partiels, (3) la vérification de la question ouverte 4 sur une machine réelle.
- Sans cette validation, on gèle (C) : aucun runtime Cursor approximatif n'est livré.

## 6. Questions ouvertes

1. **Consentement et emplacement** : commande explicite (« Configure Cursor hooks »), comme pour Claude Code ? Écrire seulement dans `~/.cursor/hooks.json` (utilisateur), jamais dans `.cursor/hooks.json` d'un projet, qui serait versionné ?
2. **Hooks du CLI** : le CLI ne déclenche que les hooks shell ([2]) et aucun sous Linux ([3]). Faut-il l'exclure explicitement et l'écrire dans la doc ?
3. **Stabilité de `transcript_path`** : le format n'est pas documenté. Ne lire ce fichier dans aucune option tant que Cursor ne le documente pas ?
4. **Hooks tiers** : Cursor exécute-t-il les hooks Claude Code d'Agent Lens déjà installés ([5], [6]) ? Si oui, il faut les reconnaître (`cursor_version` présent) pour ne pas présenter une session Cursor comme une session Claude Code. Cela vaut même si Cursor est gelé.
5. **Antigravity** : créer une sous-issue « Antigravity bloqué : format non public » pour sortir ce runtime de #238 ?

## Sources

- [1] https://cursor.com/docs/agent/hooks (officiel, lu le 2026-10-12)
- [2] https://forum.cursor.com/t/cursor-cli-hooks/148511 (forum, réponse du personnel)
- [3] https://forum.cursor.com/t/cursor-agent-cli-never-invokes-hooks-json-on-linux-2026-08-11-same-version-works-on-macos/168326 (forum, rapport d'utilisateur)
- [4] https://forum.cursor.com/t/cursor-cli-past-chats-not-showing-up/152450/20 (forum, réponse du personnel)
- [5] https://cursor.com/docs/agent/third-party-hooks (officiel)
- [6] https://forum.cursor.com/t/cursor-agent-imported-claude-code-plugin-hooks-get-a-cursor-shaped-payload-so-pretooluse-gates-fail-open/173171 (forum, rapport d'utilisateur)
