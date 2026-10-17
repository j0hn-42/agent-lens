# Jauges de quota d'abonnement : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Afficher dans la barre du haut deux mini-jauges (5 h et hebdomadaire, en % restant) pour Claude Code, un message honnête pour Copilot et OpenCode, masquables dans les paramètres. Issue : #467.

**Architecture:** Un script enveloppe de barre d'état (installé par `scripts/setup.js`) appelle la barre d'état existante de l'utilisateur et envoie `rate_limits` au relais par `POST /quota`. Le relais garde la dernière valeur par fenêtre (niveau compte, avec horodatage), la diffuse en SSE (`type: 'quota'`, locaux seulement) et la rejoue à chaque nouveau client. L'UI parse la donnée comme une donnée réseau (hors plage = inconnu) et la rend dans la barre du haut selon le `runtime` de la session sélectionnée.

**Tech Stack:** TypeScript, `node --test` via tsx (`scripts/*.test.ts`), React 19 / Next 16 / Tailwind 4 (`web/`), jsdom pour `web/tests-a11y`.

**Spec:** `docs/superpowers/specs/2026-10-17-quota-gauges-design.md`

## Global Constraints

- Jamais de nombre non prouvé : quota inconnu = « inconnu », jamais 0 ni estimation ; aucun endpoint non documenté (`copilot_internal`, endpoints internes claude.ai).
- Cible v1 : terminal + application autonome (`scripts/setup.js`). L'extension VS Code n'est pas modifiée. Copilot (consommation) : version 2.
- Quota au niveau du compte : une valeur « dernière reçue » par fenêtre, avec horodatage de réception. Âge affiché au-delà de 5 min ; au-delà de 30 min sans mise à jour : « inconnu pour l'instant » ; une fenêtre dont `resets_at` est passé disparaît.
- Script enveloppe : envoi détaché, 300 ms maximum, stdout, stderr et code de retour de la commande d'origine reproduits à l'identique ; jamais de modification sans que l'utilisateur voie ce qui change.
- Relais : loopback seulement, mêmes gardes que `POST /scope` (`guardedRoute`, `rejectCrossOrigin`, `Content-Type` exact, corps plafonné, JSON strict). Aucun chemin ni identifiant de session venant du client n'est stocké.
- Pas de `rate_limits` de remplacement reconstruit depuis les tokens des transcripts.
- WCAG 2.1 AA : texte « N % restant » en plus de la barre, nom accessible, couleurs depuis `web/lib/theme-tokens.json` puis `pnpm run gen:themes` (jamais `web/app/themes.css` à la main), `prefers-reduced-motion`. Ne pas élargir `web/tests-a11y/lint-baseline.json` ni `known-violations.json`.
- Libellés FR et EN dans `web/lib/messages.ts` ; `scripts/docs.test.ts` et `ui-glossary.test.ts` restent verts.
- Tests d'abord, un commit par étape logique, `(#467)` dans chaque message. Les tests ouvrent des ports fixes : lancer les suites une à une, dans `unshare -rn sh -c 'ip link set lo up; <cmd>'` si un serveur de dev tourne.

## Review Focus

- `rate_limits` absent, ou une seule fenêtre présente : l'UI montre la fenêtre présente, ou « inconnu pour l'instant », jamais 0 %.
- `used_percentage` hors 0 à 100, `NaN`, chaîne, négatif, `resets_at` non entier : rejeté par le relais et par le parseur web, jamais écrêté en valeur plausible.
- Corps `POST /quota` énorme, lent, mal typé, avec clés inconnues : 413, 408, 415, 400 ; l'état du relais ne change pas.
- Barre d'état d'origine qui échoue, se bloque ou écrit sur stderr : le script enveloppe reproduit sortie et code, sans attendre le relais.
- Relais arrêté ou injoignable au moment de l'envoi : la barre de l'utilisateur s'affiche sans délai notable.
- `settings.json` illisible, `statusLine` déjà posée par Agent Lens (double installation), `statusLine` absente : refus propre, idempotence, restauration exacte à la désinstallation.
- Deux comptes Claude utilisés en même temps : la dernière valeur reçue l'emporte (comportement documenté, non traité).

---

### Task 0: Vérifier que `rate_limits` arrive dans le terminal de l'utilisateur

Vérification, sans code de production. Si elle échoue, **arrêter et revoir le plan avec l'utilisateur**.

**Files:**
- Create (hors dépôt) : `$CLAUDE_JOB_DIR/tmp/probe-statusline.js`

- [ ] **Step 1: Écrire un script de sonde** qui lit stdin, l'écrit tel quel dans un fichier de `$CLAUDE_JOB_DIR/tmp`, et n'affiche rien.
- [ ] **Step 2: Demander à l'utilisateur** de le brancher temporairement comme `statusLine` d'un `settings.json` de test (`CLAUDE_CONFIG_DIR` dédié), puis de lancer une session Claude Code interactive avec un échange.
- [ ] **Step 3: Vérifier** que le fichier contient `rate_limits.five_hour.used_percentage`, `rate_limits.five_hour.resets_at`, `rate_limits.seven_day.*`, et noter la forme exacte des types (entier ou flottant, secondes). Consigner le résultat dans l'issue #467.

Résultat attendu : les champs existent. Sinon, stop.

### Task 1: État du quota dans le relais (logique pure)

**Files:**
- Create: `scripts/quota.ts`
- Test: `scripts/quota.test.ts`

**Interfaces:**
- Produces:
  - `type QuotaWindow = { usedPercentage: number; resetsAt: number }` (`resetsAt` : epoch en secondes)
  - `type QuotaSnapshot = { fiveHour: QuotaWindow | null; sevenDay: QuotaWindow | null; receivedAt: number }` (`receivedAt` : ms)
  - `parseQuotaBody(text: string): { fiveHour: QuotaWindow | null; sevenDay: QuotaWindow | null } | null`
  - `createQuotaStore(now?: () => number): { accept(body: { fiveHour: QuotaWindow | null; sevenDay: QuotaWindow | null }): QuotaSnapshot; current(): QuotaSnapshot | null }`

- [ ] **Step 1: Écrire les tests** `parseQuotaBody` : accepte `{"rate_limits":{"five_hour":{"used_percentage":62,"resets_at":1790000000},"seven_day":{...}}}` ; accepte une seule fenêtre ; refuse (renvoie `null`) : JSON invalide, tableau, clés inconnues à la racine, `used_percentage` de `-1`, `101`, `NaN`, `"62"`, `resets_at` non entier ou négatif, aucune fenêtre présente.
- [ ] **Step 2: Écrire les tests** du store : `accept` remplace les deux fenêtres ensemble (une fenêtre absente du nouveau message devient `null`, elle n'hérite pas de l'ancienne valeur) ; `current()` renvoie `null` avant tout `accept` ; `receivedAt` vient de `now()` injecté.
- [ ] **Step 3: Lancer** `pnpm test -- scripts/quota.test.ts` ; attendu : échec (module absent).
- [ ] **Step 4: Implémenter** `scripts/quota.ts` avec les signatures ci-dessus. `parseQuotaBody` est strict : racine `{ rate_limits: { five_hour?, seven_day? } }` et rien d'autre (le plafond d'octets est dans la route).
- [ ] **Step 5: Relancer ; attendu : PASS. Puis** `pnpm run lint:scripts`.
- [ ] **Step 6: Commit** `feat(relay): état du quota d'abonnement (#467)`.

### Task 2: Route `POST /quota`, diffusion SSE et rejeu

**Files:**
- Create: `scripts/routes/quota.ts`
- Test: `scripts/routes/quota.test.ts`, `scripts/relay-quota.test.ts`
- Modify: `extension/src/constants.ts` (près de `RELAY_SCOPE_*`, ligne ~459), `extension/src/relay-guards.ts` (près de `isScopePath`, ligne ~242), `scripts/relay.ts` (type `Relay` ~l.667, câblage ~l.1175-1210, rejeu SSE ~l.1265-1300), `scripts/dev-relay.ts` (~l.70), `app/src/server.ts` (~l.35 et ~l.70)

**Interfaces:**
- Consumes: `parseQuotaBody`, `createQuotaStore` (Task 1) ; `guardedRoute`, `sendPlain`, `readLimitedBody`, `isJsonContentType` (`scripts/routes/guard.ts`, `scripts/routes/scope.ts`).
- Produces:
  - Constantes `RELAY_QUOTA_RATE_BURST = 5`, `RELAY_QUOTA_RATE_PER_S = 1`, `RELAY_QUOTA_BODY_MAX_BYTES = 1024`, `RELAY_QUOTA_BODY_TIMEOUT_MS = 3000`.
  - `isQuotaPath(url: string | undefined): boolean` (chemin exact `/quota`, comme `isScopePath`).
  - `createQuotaRoute(deps: { limiter: KeyedRateLimiter; accept: (body) => QuotaSnapshot }): RouteHandler`.
  - `Relay.handleQuota` ; message SSE `{ type: 'quota', quota: QuotaSnapshot }`, envoyé par `broadcastLocal` (jamais à un hôte de tunnel), et rejoué à la connexion d'un client local s'il existe un `current()`.

- [ ] **Step 1: Écrire les tests de route** (calqués sur `scripts/routes/guard.test.ts` et ceux de `/scope`) : 200 avec corps valide et `Content-Type: application/json` ; 415 sur `text/plain` ; 413 au-dessus de 1024 octets ; 408 corps lent ; 400 JSON invalide ou hors plage ; 405 en GET ; 403 depuis un autre site (`Origin`) ; 429 au-delà de la rafale ; l'état du store est inchangé après tout refus.
- [ ] **Step 2: Écrire `scripts/relay-quota.test.ts`** : un `POST /quota` valide produit un message SSE `quota` chez un client connecté ; un client qui se connecte ensuite reçoit le dernier `quota` avant le reste du rejeu ; un client arrivé par un hôte de tunnel (`allowedHosts`) ne reçoit jamais `quota`.
- [ ] **Step 3: Lancer ; attendu : échec.**
- [ ] **Step 4: Implémenter** constantes, `isQuotaPath`, `createQuotaRoute` (même enchaînement que `createScopeRoute` ; la réponse est `{}` avec 200), puis le câblage : store créé dans le relais, `handleQuota` exposé, `accept` suivi d'un `broadcastLocal(JSON.stringify({ type: 'quota', quota }))`, rejeu via `sendSSE(res, …)` après la liste de sessions et avant le rejeu d'événements, pour les clients non-tunnel. Ajouter `handleQuota` à `AppRelay` (`app/src/server.ts`) et au routage de `server.ts` et `dev-relay.ts`.
- [ ] **Step 5: Relancer ; attendu : PASS. Puis** `pnpm run lint:scripts` et `pnpm --filter agent-lens run lint`.
- [ ] **Step 6: Revue** par l'agent `relay-hardening-reviewer` sur le diff ; corriger ce qu'il relève.
- [ ] **Step 7: Commit** `feat(relay): POST /quota, diffusion et rejeu SSE (#467)`.

### Task 3: Script enveloppe de barre d'état et installation

**Files:**
- Create: `scripts/statusline-wrapper.js` (contenu du script installé, exporté comme chaîne par une fonction)
- Modify: `scripts/setup.js` (près de `getHookScriptContent` l.59 et `configureHooks` l.185 ; exports l.240)
- Test: `scripts/statusline-wrapper.test.ts`, `scripts/setup-statusline.test.ts`

**Interfaces:**
- Consumes: découverte du relais déjà utilisée par `hook.js` (répertoire `~/.claude/agent-lens`, mêmes vérifications de PID) ; `updateSettings`, `readSettingsStrict`, `SettingsUnreadableError`, `claudeConfigDir` de `setup.js`.
- Produces:
  - `getStatuslineScriptContent(): string` (script autonome Node installé en `~/.claude/agent-lens/statusline.js`)
  - `configureStatusLine(options?: { settingsPath?: string; statuslineCommand?: string }): void` : pose `statusLine: { type: 'command', command: <wrapper> }` et enregistre la commande d'origine dans `~/.claude/agent-lens/statusline-original.json` (`{ "command": string | null }`)
  - `restoreStatusLine(options?: { settingsPath?: string }): void` : remet exactement la `statusLine` d'origine (ou la retire s'il n'y en avait pas)
  - `ensureSetup()` appelle aussi `configureStatusLine` (idempotent) ; `isAlreadySetup()` prend en compte la barre d'état.

- [ ] **Step 1: Écrire les tests du script enveloppe** (le script exécuté comme processus enfant avec un faux relais HTTP) : reçoit sur stdin un JSON de barre d'état et le passe **identique** à la commande d'origine ; stdout, stderr et code de retour de cette commande sont reproduits ; le relais reçoit `POST /quota` avec `{ rate_limits }` seulement (aucun autre champ du JSON : pas de `session_id`, pas de chemin) ; relais arrêté : sortie identique et durée totale ajoutée inférieure à 300 ms ; relais qui ne répond pas : même chose ; pas de commande d'origine : n'affiche rien ; JSON sans `rate_limits` : rien n'est envoyé.
- [ ] **Step 2: Écrire les tests d'installation** (calqués sur `scripts/setup.test.ts`, `HOME` factice) : `configureStatusLine` sur un `settings.json` sans `statusLine`, avec une `statusLine` utilisateur, avec une `statusLine` déjà posée par Agent Lens (pas de double enveloppe, l'original enregistré ne devient pas le wrapper) ; refuse et laisse intact un fichier illisible (commentaire, vide, tronqué) ; `restoreStatusLine` rend le fichier à l'identique ; `CLAUDE_CONFIG_DIR` respecté.
- [ ] **Step 3: Lancer ; attendu : échec.**
- [ ] **Step 4: Implémenter** le script enveloppe (lecture complète de stdin, exécution de la commande d'origine avec le même JSON, `stdio` hérité pour la sortie, envoi `http.request` avec `timeout: 300` sans attendre la fin pour sortir), puis `configureStatusLine` / `restoreStatusLine` / branchement dans `ensureSetup` et `isAlreadySetup`. Même écriture atomique que `ensureHookScript`.
- [ ] **Step 5: Relancer ; attendu : PASS. Puis** `pnpm run lint:scripts`.
- [ ] **Step 6: Commit** `feat(setup): barre d'état enveloppe qui transmet rate_limits au relais (#467)`.

### Task 4: Parseur et modèle de vue côté web

**Files:**
- Create: `web/lib/quota.ts`
- Test: `scripts/quota-web.test.ts` (même emplacement que `scripts/system-stats-web.test.ts`)
- Modify: `web/lib/bridge-types.ts` (type miroir, voir l.151), `web/hooks/use-vscode-bridge.ts` (état `quota`, `onMessage` ~l.343, valeur de retour ~l.120-135)

**Interfaces:**
- Produces:
  - `parseQuotaMessage(data: unknown): QuotaSnapshotView | null` (mêmes règles que le relais : hors plage = `null`)
  - `type QuotaSnapshotView = { fiveHour: { remainingPercent: number; resetsAt: number } | null; sevenDay: { remainingPercent: number; resetsAt: number } | null; receivedAt: number }`
  - `quotaGaugeState(runtime: string | undefined, snapshot: QuotaSnapshotView | null, now: number): QuotaGaugeState` avec `QuotaGaugeState = { kind: 'claude'; fiveHour: GaugeView | null; sevenDay: GaugeView | null; ageMinutes: number | null } | { kind: 'unknown' } | { kind: 'unavailable'; runtime: 'copilot' } | { kind: 'no-subscription'; runtime: 'opencode' } | { kind: 'hidden' }` et `GaugeView = { remainingPercent: number; resetsAt: number }`
  - `useVscodeBridge(...)` expose `quota: QuotaSnapshotView | null`

- [ ] **Step 1: Écrire les tests** : `remainingPercent = 100 - used_percentage` ; `parseQuotaMessage` rejette hors plage, `NaN`, types faux ; `quotaGaugeState` : `runtime 'claude'` avec données récentes → `claude` ; fenêtre dont `resetsAt` est passé → `null` pour cette fenêtre ; âge `null` sous 5 min, nombre de minutes au-delà ; plus de 30 min → `unknown` ; sans snapshot → `unknown` ; `'copilot'` → `unavailable` ; `'opencode'` → `no-subscription` ; `undefined` (aucune session sélectionnée) avec snapshot → l'état `claude` avec son âge, sans snapshot → `hidden`.
- [ ] **Step 2: Lancer ; attendu : échec.**
- [ ] **Step 3: Implémenter** `web/lib/quota.ts` et brancher le message SSE `quota` dans `onMessage` avant le `dispatch`, comme `system-stats`.
- [ ] **Step 4: Relancer ; attendu : PASS. Puis** `pnpm --dir web exec tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(web): parseur et états du quota (#467)`.

### Task 5: Jauges dans la barre du haut et réglage

**Files:**
- Create: `web/components/agent-visualizer/quota-gauges.tsx`
- Modify: `web/lib/ui-preferences.ts` (interface `UiPrefs` l.36-62, `DEFAULT_UI_PREFS` l.68-85, `sanitizePref` l.91), `web/components/agent-visualizer/top-bar.tsx` (props l.201+, rendu des totaux), `web/components/agent-visualizer/settings-dialog.tsx` (`SwitchRow` l.57-70, section Apparence), `web/components/agent-visualizer/index.tsx` (passage de `quota`, `runtime` de la session sélectionnée, `prefs.showQuota`), `web/lib/messages.ts` (clés FR et EN), `web/lib/ui-glossary.ts`, `web/lib/theme-tokens.json` puis `pnpm run gen:themes`
- Test: `web/tests-a11y/quota-gauges.test.tsx`, `web/tests-a11y/ui-preferences.test.tsx`, `web/tests-a11y/settings-dialog.test.tsx`, `web/tests-a11y/axe.test.tsx`

**Interfaces:**
- Consumes: `quotaGaugeState`, `QuotaGaugeState` (Task 4).
- Produces:
  - `UiPrefs.showQuota: boolean` (défaut `true`)
  - `<QuotaGauges state={QuotaGaugeState} now={number} />`
  - Props de `TopBar` : `quota?: QuotaSnapshotView | null`, `selectedRuntime?: string`, `showQuota?: boolean`

- [ ] **Step 1: Écrire les tests de composant** : état `claude` → deux éléments avec le texte « 5 h … 38 % restant » et « 7 j … 66 % restant », chacun avec `role="meter"` (ou `progressbar`) et `aria-valuenow`, nom accessible complet ; l'heure de reset apparaît en `title` / tooltip accessible au focus clavier ; une seule fenêtre → une seule jauge ; `unknown` → « quota : inconnu pour l'instant » sans nombre ; `unavailable` → « quota non disponible » ; `no-subscription` → « pas de quota d'abonnement » ; `hidden` → rien ; l'âge « mis à jour il y a N min » n'apparaît qu'au-delà de 5 min ; aucune animation sous `prefers-reduced-motion`.
- [ ] **Step 2: Écrire les tests de préférence et de réglage** : `showQuota` vaut `true` par défaut, une valeur non booléenne dans le stockage est ignorée (`sanitizePref`), l'interrupteur du dialogue de paramètres le change, et `showQuota: false` ne rend rien dans la barre du haut. Mettre à jour les props de `TopBar` dans `panel-buttons.test.tsx` et `scope-selector.test.tsx`.
- [ ] **Step 3: Lancer ; attendu : échec.**
- [ ] **Step 4: Implémenter** : préférence (sans migration, nouvelle clé), composant (couleurs depuis de nouveaux tokens `quota-ok`, `quota-low`, `quota-critical` ajoutés à `theme-tokens.json` puis `pnpm run gen:themes` ; état faible dit aussi en texte ou icône ; replié derrière « More » sous 600 px comme les totaux), interrupteur et libellés FR et EN. Les seuils de couleur sont à décider par l'implémenteur (proposition : faible sous 25 % restant, critique sous 10 %).
- [ ] **Step 5: Relancer** `pnpm run test:a11y`, `pnpm --dir web run lint:a11y`, `pnpm --dir web exec tsc --noEmit` ; attendu : tout vert, sans élargir les baselines.
- [ ] **Step 6: Revue** par l'agent `a11y-reviewer`, puis `pnpm --dir web run test:e2e` (changement de rendu et de CSS) ; corriger.
- [ ] **Step 7: Commit** `feat(web): jauges de quota dans la barre du haut et réglage (#467)`.

### Task 6: Documentation

**Files:**
- Modify: `docs/reading-the-ui.md` (nouvelle section « Quota d'abonnement »), `docs/relay-sources.md` (nouvelle entrée Claude Code : `statusLine`), `README.md` si la liste des fonctions y figure (`extension/README.md` est copié, ne pas l'éditer)
- Test: `scripts/docs.test.ts`, `scripts/ui-glossary.test.ts`

- [ ] **Step 1: Écrire dans `reading-the-ui.md`** ce que veulent dire les jauges (% **restant**, heure de reset), quand elles disent « inconnu pour l'instant », l'âge de la donnée, pourquoi Copilot et OpenCode n'ont pas de quota, comment masquer l'indicateur, et que le compte est la dernière valeur reçue.
- [ ] **Step 2: Lancer** `pnpm test -- scripts/docs.test.ts scripts/ui-glossary.test.ts` ; ajuster les libellés du glossaire si un test les compare à la doc ; attendu : PASS.
- [ ] **Step 3: Lancer** le skill `run-checks` (liste CI complète) ; attendu : tout vert.
- [ ] **Step 4: Commit** `docs: jauges de quota d'abonnement (#467)`, puis ouvrir la PR avec le skill `pr-fork` (contre `develop`, label `agent:frontend-engineer`, `Closes #467`).
