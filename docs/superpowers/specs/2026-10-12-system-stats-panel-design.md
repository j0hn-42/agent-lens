# Panneau de santé machine : spécification de conception

Date : 2026-10-12
Statut : implémenté sur la branche `feat/357-system-stats-panel` (ticket #357). Cette spec a été mise à jour pour refléter ce qui a été construit.

## 1. Contexte et objectif

Agent Lens n'expose aucune métrique de la machine. Quand plusieurs agents tournent en parallèle, on ne sait pas si le CPU, la mémoire ou le disque saturent.

**Objectif** : un panneau de l'app qui montre la santé de la machine pendant que les agents tournent (CPU, RAM, swap, disque, charge), avec un historique récent.

**Hors périmètre de la V1** : consommation par processus d'agent (`claude`, `node`), GPU, température, réseau, historique persistant, dépendance externe (`systeminformation`).

**Principe du projet** ([reading-the-ui.md](../../reading-the-ui.md)) : aucun chiffre affiché s'il n'est pas mesuré. Une métrique indisponible vaut `null` et s'affiche « non disponible », jamais 0.

### Existant utile

- `scripts/relay.ts` : `broadcast(data, sessionId?)` et `broadcastLocal(data)`. Ce dernier ne sert que les clients locaux et laisse les infos sensibles hors tunnel (précédent : `/launch`, #241).
- Un intervalle partagé pour tous les clients SSE, arrêté quand le dernier client part (#68).
- `web/lib/panel-layout.ts` : dock de panneaux (`PanelId`, dock gauche pour `detail`), propriétés testées dans `scripts/panel-layout.test.ts`.
- `web/components/agent-visualizer/` : panneaux existants (`file-attention-panel.tsx`, `collapsible-section.tsx`), barre du haut, dialogue des raccourcis.

## 2. Approche retenue

**Le relay échantillonne et pousse par SSE.** Un module pur lit le module `os` de Node et `/proc`, le relay diffuse un événement `system-stats` aux clients locaux, le web garde 60 points en mémoire.

Écartées :
- **Mesure côté navigateur** : pas de CPU système, et seulement l'onglet.
- **`systeminformation`** : plus de métriques, mais dépendance lourde, contraire à l'esprit du fork (YAGNI en V1).

## 3. Source de données : `scripts/system-stats.ts`

Fonction pure `sampleSystem(prev, io)` où `io` injecte les lectures (`os.cpus`, lecture de `/proc/meminfo`, `fs.statfs`, `/proc/version`) pour les tests.

```ts
interface SystemSample {
  ts: number                                    // ms epoch
  cpu: { total: number | null; perCore: (number | null)[] }  // 0..1
  mem: { total: number; used: number } | null   // octets
  swap: { total: number; used: number } | null
  disk: { total: number; used: number } | null
  load: [number, number, number] | null         // os.loadavg()
  uptime: number | null                         // s
  platformNote: string | null
}
```

- **CPU** : delta entre deux lectures de `os.cpus()` (somme des temps, part inactive). Le premier échantillon n'a pas de delta : `total` et `perCore` valent `null`.
- **RAM** : `MemAvailable` de `/proc/meminfo` quand il existe (`used = total - available`). Sinon `os.totalmem() - os.freemem()` seulement hors Linux. Sous Linux, `os.freemem()` compte le cache comme utilisé et fausserait le chiffre.
- **Swap** : `SwapTotal` et `SwapFree` de `/proc/meminfo`, `null` sans `/proc`. Un swap de taille 0 vaut `{ total: 0, used: 0 }` (affiché « aucun swap »).
- **Disque** : `fs.statfs` sur le dossier de travail du relay. `null` en cas d'erreur.
- **Charge** : `os.loadavg()`. Sous Windows elle vaut toujours `[0,0,0]` : on renvoie `null` si `process.platform === 'win32'`.
- **`platformNote`** : « WSL2 : valeurs de la VM Linux, pas de Windows » quand `/proc/version` contient `microsoft`, sinon `null`.
- Toute lecture qui échoue donne `null` pour sa métrique seule, sans faire échouer l'échantillon.

## 4. Relay

- Un seul minuteur de **2 s**, un `SharedTicker` (le même que le heartbeat et le scan, #68), démarré au premier client SSE **local** et arrêté au dernier. Aucun coût sans client, et un client de tunnel ne le démarre pas. L'option de relay `systemIntervalMs` (inconditionnelle, utilisée par les tests) règle la période.
- Il envoie `JSON.stringify({ type: 'system-stats', sample })` avec **`broadcastLocal`**. Un client distant (tunnel) ne reçoit jamais les infos de la machine.
- Pas d'historique ni de rejeu côté relay : un nouveau client reçoit son premier point au tick suivant. Le premier échantillon d'un cycle de vie du timer a `cpu: null`.
- Le type d'événement est ajouté aux types de messages partagés (`web/lib/bridge-types.ts`) et à la validation côté client.
- Revue par `relay-hardening-reviewer` (taille du message, absence de données hors loopback, nettoyage du timer).

## 5. Web : modèle `web/lib/system-stats.ts`

- Buffer circulaire de **60 points** (environ 2 min) : `pushSample(buffer, sample)`, immuable.
- `summarise(buffer)` : valeur courante et maximum récent par métrique, en ignorant les `null`.
- `severity(ratio)` : `normal` < 0,85 ≤ `warm` < 0,95 ≤ `critical`. `null` donne `unknown`.
- Pure, sans React, testable seule.

## 6. UI : `system-panel.tsx`

- Le panneau s'appelle **System** (« Stats » existe déjà). Nouvel id `'system'` dans `PanelId` (`panel-layout.ts`), placé dans le **dock gauche** sous la carte de détail. Il est **non exclusif** : l'ouvrir ne ferme pas les autres panneaux. Les propriétés du layout (pas de chevauchement, mode `sheet` sous `SHEET_BREAKPOINT`) restent vraies.
- Ouverture : bouton **System** dans la barre du haut, entrée dans la palette de commandes et raccourci **`Y`** (touche à une seule lettre, soumise à la préférence des raccourcis à une touche, listé dans le dialogue des raccourcis). Fermeture : bouton visible et `Échap`, avec retour du focus à l'élément d'origine.
- Indisponible dans VS Code et en démo : le panneau le dit à la place des jauges. Le buffer est vidé quand la source SSE n'est pas connectée.
- La barre du haut passe à la ligne (`flex-wrap`) pour rester utilisable à 320 px avec le bouton System (WCAG, reflow).
- Contenu : jauges **CPU**, **RAM**, **swap**, **disque** (valeur en % arrondie vers le bas et en octets, barre), charge 1/5/15, uptime, `platformNote`, et une sparkline par métrique sur la fenêtre de 2 min.
- Détail par cœur dans une `collapsible-section`, **fermée par défaut**.
- Avant le premier point ou si la source est absente : « en attente de mesure » ; métrique `null` : « non disponible ».

### Accessibilité (WCAG 2.1 AA, obligatoire)

- Chaque jauge : `role="meter"` avec `aria-valuenow`, `aria-valuemin`, `aria-valuemax`, nom accessible. Quand la valeur est `null`, **aucun** `role="meter"` n'est rendu (ARIA exige `aria-valuenow`) : le texte « Not available » le remplace.
- Le pourcentage affiché est arrondi vers le bas, pour rester cohérent avec la gravité (85 % affiché est toujours Warm ou pire, 95 % toujours Critical).
- Les mises à jour toutes les 2 s ne sont **pas** annoncées. Une annonce polie (`chrome-announcer`) uniquement au **changement de gravité** (normal → chaud → critique).
- La gravité est dite en **texte et icône**, jamais par la couleur seule. Couleurs issues de nouveaux tokens dans `web/lib/theme-tokens.json`, puis `pnpm run gen:themes` (jamais `themes.css` à la main).
- Sparklines décoratives (`aria-hidden`) avec un résumé textuel (valeur courante, max récent).
- `prefers-reduced-motion` : aucune transition de barre ni d'animation.
- Navigation clavier complète, ordre de focus logique. Aucun élargissement de `lint-baseline.json` ni de `known-violations.json`.

## 7. Tests (écrits en premier)

- `scripts/system-stats.test.ts` : delta CPU (dont premier échantillon `null`, compteurs qui reculent), `MemAvailable` contre `freemem`, tout `null` sans `/proc`, swap de taille 0, charge `null` sous Windows, `platformNote` WSL2, échec d'une lecture sans effet sur les autres.
- `scripts/system-stats-relay.test.ts` : événement envoyé aux clients locaux et pas aux clients distants, timer démarré à la première connexion et arrêté à la dernière.
- `scripts/panel-layout.test.ts` : propriétés existantes étendues à `'system'`.
- Tests du modèle web : buffer circulaire, `summarise`, seuils aux bornes.
- `pnpm run test:a11y` : axe et clavier pour le panneau. `web test:e2e` seulement si le CSS ou le rendu le demande.
- `scripts/data-honesty.test.ts` et la doc : un test vérifie qu'aucun `0` n'est rendu pour une métrique `null`.

## 8. Documentation

- Nouvelle page `docs/system-stats.md` : ce qui est mesuré, d'où, la limite WSL2, le fait que rien ne sort du loopback.
- Une ligne dans `docs/reading-the-ui.md` et le glossaire UI (`ui-glossary.test.ts` à passer).

## 9. Livraison

- **Aucune issue n'existe** pour ce travail. Avant le code : créer l'issue dans `j0hn-42/agent-lens` avec `agent:frontend-engineer`, un label de type et un `severity:*`. Les rôles `backend-engineer` (relay) et `a11y-engineer` (revue) y sont associés.
- Branche `feat/...` depuis `develop`, PR vers `develop`, commits d'une étape logique chacun, test d'abord, référence `(#n)`.
- Ordre des étapes : 1) `system-stats.ts` et ses tests, 2) relay et ses tests, 3) modèle web, 4) layout et panneau, 5) tokens de thème, 6) docs.

## 10. Questions ouvertes

1. ~~Touche du raccourci clavier~~ : résolue, **`Y`**.
2. Seuils 85 % / 95 % : valeurs par défaut raisonnables, ajustables.
3. Faut-il une option pour désactiver l'échantillonnage ? Non en V1 : il ne tourne que s'il y a un client.
