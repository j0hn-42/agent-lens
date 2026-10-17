# Jauges de quota d'abonnement : spécification de conception

Date : 2026-10-17
Statut : proposition, en attente de validation. Aucun code de production n'est écrit avant cette validation. Aucune issue n'existe encore : à créer avant l'implémentation (rôle `agent:frontend-engineer` ou `agent:backend-engineer` selon le découpage).

## 1. Intention

L'utilisateur veut voir, en permanence et selon l'outil de la session (Claude Code, Copilot, OpenCode), sa consommation d'abonnement et le pourcentage restant. Ce qui l'intéresse : savoir tout de suite s'il lui reste de la marge avant de lancer ou de poursuivre du travail, et ne pas se faire couper par une limite atteinte.

Le principe du projet s'applique sans exception : **jamais d'état ni de nombre qui ne puisse être prouvé** ([reading-the-ui.md](../../reading-the-ui.md)). Un quota inconnu s'affiche « inconnu », jamais 0 ni une valeur plausible.

## 2. Objectifs, non-objectifs, anti-objectifs

### Objectifs

- Un indicateur permanent dans la barre du haut avec deux mini-jauges pour Claude Code : fenêtre de 5 heures et fenêtre hebdomadaire, en pourcentage **restant**, avec l'heure de reset.
- Un interrupteur dans les paramètres pour le masquer (préférence UI, affichée par défaut).
- Un affichage adapté au `runtime` de la session : chaque outil dit honnêtement ce qu'il sait.
- Branchement sur la barre d'état Claude Code **sans casser** la barre d'état existante de l'utilisateur.

### Non-objectifs (version 1)

- Consommation Copilot via l'API officielle de facturation GitHub (demande un jeton GitHub de l'utilisateur) : version 2.
- Aucun quota pour OpenCode (il n'en a pas en propre).
- Pas de prévision (« il vous reste X heures au rythme actuel »).

### Anti-objectifs

- Reconstituer un pourcentage à partir des tokens des transcripts : ce serait une estimation présentée comme un quota.
- Appeler un endpoint non documenté (par exemple `copilot_internal/user`, ou les endpoints internes de claude.ai avec le jeton OAuth de l'abonnement) : instable et risqué côté conditions d'utilisation.
- Remplacer, déformer ou ralentir la barre d'état actuelle de l'utilisateur.

## 3. Ce que chaque outil permet de prouver

Vérifié en documentation le 2026-10-17 (voir § 8 pour les sources et incertitudes).

| Outil | Pourcentage restant | Source |
|---|---|---|
| Claude Code (Pro/Max) | Oui, 5 heures et 7 jours, avec reset | `rate_limits` dans le JSON reçu par le script de barre d'état, documenté officiellement |
| Copilot | Non (version 1) | La facturation est à l'usage depuis le 1er juin 2026. L'API officielle donne la consommation, pas le quota restant |
| OpenCode | Non | Pas de quota d'abonnement propre ; dépend du fournisseur |

Détails Claude Code : `rate_limits.five_hour` et `rate_limits.seven_day`, chacun avec `used_percentage` (0 à 100) et `resets_at` (epoch en secondes). Présent seulement pour les abonnés Pro et Max et seulement après la première réponse API de la session. Chaque fenêtre peut manquer indépendamment ; Claude Code retire une fenêtre une fois son `resets_at` passé.

## 4. Décisions prises par l'utilisateur

- Indicateur **toujours affiché**, masquable dans les paramètres.
- Quota d'abonnement : fenêtre de 5 heures et limite hebdomadaire.
- Le comportement s'adapte à chaque service, car Copilot et OpenCode ne fonctionnent pas comme Claude Code.
- **Option A** de la maquette : deux mini-jauges dans la barre du haut, à côté des tokens et du coût.
- Agent Lens peut s'insérer dans la barre d'état Claude Code, **à condition de ne pas casser celle de l'utilisateur**.
- Copilot (consommation) reporté en version 2.

## 5. Comportement attendu

### Affichage dans la barre du haut

Exemple pour Claude Code : `5 h [barre] 38 % restant` puis `7 j [barre] 66 % restant`. Toujours un texte avec le pourcentage, jamais la couleur seule. Au survol et au focus clavier : l'heure de reset de la fenêtre. La barre du haut replie déjà ses totaux sous 600 px derrière « More » : l'indicateur suit la même règle.

### États par outil

| Situation | Affichage |
|---|---|
| Claude Code, données reçues | Les deux jauges |
| Claude Code, une seule fenêtre présente | Seulement la fenêtre présente |
| Claude Code, avant le premier appel de la session, ou barre d'état non branchée, ou abonnement sans `rate_limits` | « quota : inconnu pour l'instant » (sans nombre) |
| Fenêtre dont le reset est passé | La fenêtre disparaît (comportement de Claude Code), jamais un pourcentage périmé |
| Copilot | « quota non disponible » |
| OpenCode | « pas de quota d'abonnement », avec le coût estimé en `~` s'il existe |
| Plusieurs sessions de runtimes différents | L'affichage suit la session sélectionnée ; sans session sélectionnée, voir § 7 |

### Réglage

Interrupteur dans le dialogue de paramètres, même mécanique que `showCostOverlay` dans `web/lib/ui-preferences.ts` (booléen, défaut `true`, validation stricte, test dédié). Masqué : rien n'est rendu dans la barre du haut.

### Branchement de la barre d'état Claude Code

Le relais reçoit les quotas via un script de barre d'état. Exigences décidées :

- Le script d'Agent Lens **appelle la commande de barre d'état existante** de l'utilisateur, lui passe exactement le même JSON sur stdin, et réaffiche exactement sa sortie.
- La transmission au relais est secondaire : si le relais est arrêté, lent ou refuse la requête, la barre de l'utilisateur s'affiche quand même, sans délai notable.
- Installation et retrait réversibles ; rien n'est modifié sans que l'utilisateur ait vu ce qui change.

## 6. Contraintes

- WCAG 2.1 AA : accessibles au clavier, noms accessibles, couleurs des tokens de thème (`web/lib/theme-tokens.json` puis `pnpm run gen:themes`, jamais `themes.css` à la main), `prefers-reduced-motion` respecté. Ne pas élargir `lint-baseline.json` ni `known-violations.json`. Revue par `a11y-reviewer`.
- Le relais n'accepte que des requêtes loopback ; la nouvelle entrée passe par les mêmes gardes que les routes existantes (limiteur, refus cross-origin, plafond de taille). Revue par `relay-hardening-reviewer`.
- Libellés dans `web/lib/messages.ts` (i18n) et `ui-glossary` ; `scripts/docs.test.ts` et `ui-glossary.test.ts` doivent rester verts.
- Section ajoutée à `docs/reading-the-ui.md` : ce que veulent dire les jauges, quand elles sont « inconnu », et pourquoi Copilot et OpenCode n'ont pas de quota.
- Tests d'abord, commits d'une seule étape logique.

## 7. Laissé au constructeur

- Chemin technique exact de réception : route du relais, format du message, stockage en mémoire, diffusion à l'UI (SSE).
- Où et comment le script de barre d'état est installé, et comment il détecte la commande existante (réglage `statusLine` des settings Claude, `CLAUDE_CONFIG_DIR`).
- Comportement avec des sessions Claude Code issues de comptes différents (voir § 9, choix 1).
- Seuils de couleur (l'état « faible » ou « critique » est dit aussi par texte ou icône, jamais par la couleur seule, WCAG 1.4.1) des jauges (faible, critique), à tirer des tokens de thème.
- Découpage en issues et en PR.

## 8. Sources et incertitudes

- Claude Code : https://code.claude.com/docs/en/statusline (champ `rate_limits`). Pas vérifié : présence de `rate_limits` dans les sessions headless (`-p`) ni dans l'extension VS Code. Pas vérifié non plus : les payloads des hooks.
- Copilot : https://github.blog/2026-04-27-github-copilot-is-moving-to-usage-based-billing/ et https://docs.github.com/en/rest/billing/usage. Les AI Credits (unités, reset) n'ont pas été lus en détail.
- OpenCode : https://opencode.ai/docs/zen/ et https://opencode.ai/docs/providers/. Le format local des sessions est déjà géré par le watcher existant (`extension/src/opencode-event-parser.ts`).
- Dans le code actuel : aucun usage de quota ni de fenêtre 5h/hebdo ; les tokens et coûts de l'UI sont des estimations (`web/lib/usage.ts`, `docs/reading-the-ui.md`). Détection des runtimes par watcher, champ `runtime` sur les sessions.

## 9. Choix du rédacteur (à relire, non validés par l'utilisateur)

1. **Le quota appartient au compte, pas à la session.** Le relais garde une seule valeur « dernière reçue » par fenêtre, avec son horodatage de réception, et l'affiche pour toute session Claude Code. Il n'essaie pas de rattacher un quota à un `session_id`. Si deux comptes sont utilisés en même temps, la dernière valeur reçue l'emporte ; cas non traité en version 1.
2. **Fraîcheur.** Le relais affiche l'âge de la donnée dès qu'elle a plus de 5 minutes (« mis à jour il y a 12 min »). Une fenêtre dont `resets_at` est passé disparaît toujours. Sans mise à jour depuis plus de 30 minutes, l'indicateur repasse à « inconnu pour l'instant ». Les deux durées sont mes valeurs de départ, à ajuster à l'usage.
3. **Aucune session sélectionnée.** L'indicateur affiche la dernière donnée Claude Code (avec son âge) s'il y en a une, sinon rien (pas de faux « inconnu » quand aucun outil n'est observé).
4. **Script enveloppe.** Envoi au relais détaché, avec un délai maximal de 300 ms, qui n'a aucun effet sur l'affichage. Stdout, stderr et code de retour de la commande d'origine sont reproduits à l'identique.
5. **Installation.** Décidé avec l'utilisateur : il utilise Claude Code dans un terminal et Agent Lens via l'application autonome. La cible de la version 1 est donc l'application autonome ; l'extension VS Code n'est pas concernée. L'installation suit l'installateur autonome existant `scripts/setup.js` (`pnpm setup`, `configureHooks`, `CLAUDE_CONFIG_DIR` respecté, refus de toucher un `settings.json` illisible, voir `scripts/setup.test.ts`) et sa confirmation, au lieu de `extension/src/claude-settings.ts`.
6. **Première tâche du plan : une vérification** que `rate_limits` arrive bien dans l'environnement réel de l'utilisateur (terminal, extension VS Code, sessions headless). Si ce n'est pas le cas, le plan est revu avant d'aller plus loin.
