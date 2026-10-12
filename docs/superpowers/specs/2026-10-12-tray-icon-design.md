# Icône de barre système : spécification de conception

Date : 2026-10-12
Statut : proposition, en attente de validation dans #335. Aucun code de production n'est écrit avant cette validation. Les libellés cités ici sont indicatifs (voir la question ouverte 4).

## 1. Contexte

### Origine

- **#241, décision (c)** : l'icône de barre système n'est pas livrée avec l'accès distant. Elle fait l'objet d'une issue séparée, #335.
- **#326** (fusionnée) : étape 1 de #241, les gardes seulement. Le relais reste sur `127.0.0.1` ; `--allow-host` et un `--host` hors loopback refusent le démarrage (code de sortie 2) tant que le jeton n'est pas livré.
- **#335** demande de trancher l'enveloppe (Electron, Tauri ou binaire natif) et propose un menu : ouvrir l'UI ; état (n sessions suivies, d'après `/status`) ; afficher l'URL ; quitter.

### Contraintes du ticket

- L'application reste utilisable **sans** l'icône : `agent-lens` (CLI) ne change pas de comportement et ne gagne aucune dépendance.
- Les libellés et le menu sont accessibles au clavier et aux lecteurs d'écran.
- **Aucun accès réseau hors loopback** : l'icône ne parle qu'à `127.0.0.1`.
- **État prouvé seulement** ([reading-the-ui.md](../../reading-the-ui.md)) : chaque nombre du menu vient d'une réponse `/status` récente, sinon le menu dit « inconnu ».
- Tests d'abord sur la logique d'état.

### Existant utile (lu dans `develop`)

- `app/` est un CLI Node sans interface : `bin agent-lens -> dist/app.js`, aucune dépendance graphique.
- `app/src/server.ts` écoute via `listenLoopback` et affiche `Server running at http://127.0.0.1:<port>`. `--port 0` demande un port éphémère.
- Le même fichier installe un nettoyage idempotent sur `SIGINT`, `SIGTERM` et `SIGHUP` : fermeture du serveur, `relay.dispose()`, vidage de la télémétrie, puis `exit(0)`.
- `GET /status` (`scripts/routes/status.ts`) renvoie un `RelayStatus` : `relayVersion`, `sessionCount`, `skippedSessions` (sessions non suivies, à lire « au moins »), `runtimes`, `hooksConfigured`… La route refuse les requêtes cross-origin et passe par un limiteur (rafale de 20, 5 par seconde).
- `GET /statusline` (#236) donne déjà une ligne d'état pour tmux et zellij. C'est un précédent de « ligne d'état hors navigateur » qui ne demande aucune GUI.

## 2. Options comparées

Les poids sont des ordres de grandeur à mesurer sur un prototype, pas des valeurs garanties.

| Critère | a) Electron, paquet séparé | b) Tauri | c) Binaire systray natif piloté par stdin/stdout | d) Ne rien embarquer |
|---|---|---|---|---|
| Poids installé | ~100 Mo ou plus par plateforme (Chromium + Node) | quelques Mo (WebView du système) | quelques Mo par plateforme | 0 |
| Build | electron-builder, un artefact par OS et architecture | chaîne Rust (cargo) en plus de pnpm, compilation par OS | binaire précompilé par OS/arch (Go ou Rust) ; le pilote reste en TypeScript | aucun |
| Signature | quasi obligatoire (Gatekeeper sur macOS, SmartScreen sur Windows) | idem | idem pour le binaire embarqué | aucune |
| Maintenance | mises à jour de sécurité Chromium fréquentes, à suivre | Rust + plugins Tauri, une seconde pile | petit binaire peu modifié ; les paquets npm existants de ce type sont peu maintenus, à vendoriser ou recompiler | documentation seulement |
| Accessibilité du menu | menu natif (`Tray` + `Menu`) | menu natif (crate `tray-icon`) | menu natif (même mécanisme) | sans objet |
| Impact CI | matrice macOS/Windows/Linux pour packager ; jobs lourds | toolchain Rust + matrice OS ; jobs lourds | compilation croisée du binaire (un job) ; tests du pilote en `node --test` comme aujourd'hui | aucun |
| Empreinte npm | énorme si publié sur npm (ou téléchargement post-install, à proscrire) | binaire hors npm | quelques Mo par plateforme via `optionalDependencies` par OS | aucune |
| Surface de sécurité | moteur web complet, même sans fenêtre | WebView inutilisée mais présente | aucun moteur web ; le binaire n'ouvre aucun socket | aucune |

### Accessibilité du menu natif, par système

Les options a), b) et c) aboutissent toutes au **même** menu natif du système. Le choix de l'enveloppe change donc peu l'accessibilité ; c'est la plateforme qui décide.

- **macOS** (`NSStatusItem` + `NSMenu`) : VoiceOver lit les éléments, la barre des menus est atteignable au clavier (Ctrl+F8 avec l'accès clavier complet, ou VO+M M). Bon support.
- **Windows** (zone de notification + menu Win32) : Win+B donne le focus à la zone de notification, puis les flèches, Entrée ou la touche Menu ouvrent le menu ; Narrator et NVDA lisent les menus Win32. Bon support, à condition que l'icône ait une info-bulle (nom accessible).
- **Linux** (StatusNotifierItem + dbusmenu, via libayatana-appindicator) : support **variable**. GNOME sans l'extension AppIndicator n'affiche aucune icône ; la lecture par Orca dépend du panneau (KDE Plasma correct, d'autres partiels). Il faut tester sur au moins GNOME (avec l'extension) et KDE.
- Dans tous les cas, l'icône ne doit jamais être la **seule** voie : tout ce que propose le menu existe déjà dans le CLI (sortie console, `Ctrl+C`), dans l'UI web et dans `/statusline`. Une icône invisible ou illisible n'enlève donc aucune fonction.

### Option d) en détail

Documenter un lancement au démarrage de session sans icône : `launchd` (macOS), tâche planifiée ou raccourci de démarrage (Windows), unité `systemd --user` (Linux), plus `/statusline` pour l'état dans tmux et zellij. Coût nul, mais elle ne répond pas à la demande « ouvrir / état / quitter » d'un clic. Elle reste la **voie de repli documentée**, quelle que soit l'option retenue.

## 3. Recommandation

**Un paquet optionnel séparé, `app-tray/`**, construit sur l'option c) : un pilote TypeScript (Node) et un binaire de menu natif minimal. On garde la porte ouverte vers a) ou b) : le pilote et la logique d'état ne dépendent pas de l'enveloppe. L'option d) est documentée en parallèle.

Pourquoi : l'accessibilité du menu est la même pour a), b) et c), puisque le menu est natif dans les trois cas. Le critère décisif devient donc le poids, la CI et la surface d'attaque. Sur ces trois points, c) l'emporte nettement. a) embarque un navigateur entier pour un menu de quatre lignes. b) ajoute une chaîne Rust à un dépôt TypeScript.

### Architecture

```
app-tray (Node) ──spawn──▶ agent-lens --port 0      (relais, inchangé)
      │  └─ lit "Server running at http://127.0.0.1:<port>" sur stdout (URL validée : loopback seulement)
      ├─ GET http://127.0.0.1:<port>/status          (toutes les N s, délai d'attente court)
      └─ stdin/stdout JSON ⇄ binaire de menu natif   (aucun socket, aucun réseau)
```

- **Relais** : `app-tray` le **démarre** comme processus enfant. Il peut aussi **interroger** un relais déjà lancé, sur un port donné explicitement (`--port`) ; dans ce cas, il ne le possède pas. Seul `127.0.0.1` est accepté : une URL ou un hôte hors loopback est refusé au démarrage, comme le fait `remoteStartupError`.
- **État** : « n sessions suivies » vient **uniquement** de `sessionCount` dans une réponse `/status` valide et récente. Si `/status` ne répond pas, dépasse le délai, renvoie un code non 200, un JSON invalide ou un champ manquant, le menu affiche **« inconnu »**, jamais une valeur supposée ni la dernière valeur connue présentée comme actuelle. Si `skippedSessions` est non nul, le menu ajoute « au moins k non suivies », avec la même sémantique que l'UI.
- **Identité du relais** : une réponse sur le port ne prouve pas que c'est Agent Lens. La réponse doit porter un `relayVersion` de forme attendue, sinon l'état est « inconnu ».
- **Quitter** : envoie `SIGTERM` au processus du relais. Le nettoyage existant de `server.ts` s'en charge (fermeture, `session_end`, télémétrie). Il n'y a **aucune** route HTTP d'arrêt nouvelle et **aucune** exécution de commande côté relais. Sous Windows, où `SIGTERM` n'existe pas comme signal POSIX, il faut un arrêt équivalent qui passe par le même `cleanup` : point à vérifier sur prototype (voir § 7). Si `app-tray` n'a **pas** démarré le relais, il ne connaît pas son PID de façon prouvée. « Quitter » ferme alors seulement l'icône, et le libellé le dit (« Fermer l'icône, le relais continue »).
- **Ouvrir l'UI** : ouvre `http://127.0.0.1:<port>` dans le navigateur par défaut. L'URL est construite à partir du port validé, jamais à partir d'une chaîne reçue telle quelle.
- **Polling** : une requête toutes les 5 s au plus, bien sous le limiteur de `/status` (5 par seconde). Pas de requête concurrente : on attend la fin (ou le délai) de la précédente.

### Ce que le relais ne change pas

Aucune route, aucun champ de `/status` et aucune option ne sont ajoutés pour l'icône. Ce que le relais expose déjà suffit. L'icône n'élargit donc pas la surface revue par `relay-hardening-reviewer`.

## 4. Logique d'état pure, écrite en premier

`app-tray/src/menu-model.ts` : une fonction pure, sans E/S.

```ts
type StatusProbe =
  | { kind: 'ok'; body: unknown; receivedAt: number }
  | { kind: 'unreachable' | 'timeout' | 'http-error' | 'invalid-json' }
  | { kind: 'not-started' }

interface MenuInput { probe: StatusProbe; now: number; port: number | null; ownsRelay: boolean }
interface MenuItem { id: 'open' | 'state' | 'skipped' | 'quit'; label: string; enabled: boolean }

export function deriveMenu(input: MenuInput): { tooltip: string; items: MenuItem[] }
```

Tests `node --test` (`app-tray/src/menu-model.test.ts`), à brancher dans le glob de `pnpm test` :

- `unreachable`, `timeout`, `http-error`, `invalid-json` et `not-started` donnent « Sessions suivies : inconnu », jamais un nombre.
- `ok` sans `sessionCount` entier positif ou nul (absent, négatif, flottant, chaîne) donne « inconnu ».
- `ok` sans `relayVersion` de forme attendue donne « inconnu » (ce n'est pas Agent Lens).
- `ok` trop ancien (`now - receivedAt` au-delà du seuil) donne « inconnu » et ne réaffiche pas l'ancienne valeur.
- `ok` valide : « Sessions suivies : n », avec le singulier et le pluriel corrects.
- `skippedSessions` dont la somme est k > 0 : élément « Au moins k non suivies » ; absent si k = 0 ou si le champ est invalide.
- « Ouvrir l'interface » est désactivé si `port` est nul.
- « Quitter » arrête le relais seulement si `ownsRelay` ; sinon, le libellé dit que le relais continue.
- Info-bulle toujours non vide (nom accessible de l'icône), qui reprend l'état ou « inconnu ».
- Aucun libellé vide, identifiants uniques, aucune URL hors `127.0.0.1` dans la sortie.

Ensuite, dans l'ordre : tests du pilote avec un faux binaire (protocole stdin/stdout, fin propre si le binaire meurt), un test d'intégration sur un relais réel en `--port 0` (en `unshare -rn`) qui vérifie que `SIGTERM` émis par le pilote arrête le relais avec le code 0, puis une vérification manuelle au lecteur d'écran sur les trois OS (VoiceOver, Narrator ou NVDA, Orca).

## 5. Risques

### Sécurité

- **Binaire tiers** : il faut le compiler dans la CI du dépôt à partir de sources vendorisées et versionnées, sans téléchargement au `postinstall`. Sommes de contrôle publiées.
- **Protocole stdin/stdout** : messages JSON bornés en taille, schéma validé des deux côtés ; un clic renvoie un **identifiant** d'élément, jamais une commande ni une URL.
- **Arrêt d'un mauvais processus** : on n'envoie de signal qu'au PID de l'enfant lancé par `app-tray`, jamais à un PID découvert (port, fichier, `/status`).
- **Ouverture du navigateur** : on réutilise le chemin existant d'ouverture d'URL avec une URL construite et validée (loopback, port entier), jamais une chaîne reçue.
- **Aucun réseau hors loopback** : test qui refuse tout hôte autre que `127.0.0.1`.

### Accessibilité

- Linux : icône absente sur GNOME sans extension, lecture Orca inégale. Repli documenté (option d) et `/statusline`.
- L'icône seule ne porte pas l'état : l'info-bulle et le libellé d'état le disent en texte, jamais par la couleur seule.
- Pas d'animation de l'icône (pas de clignotement) : rien à adapter pour `prefers-reduced-motion`.

### Produit

- Signature des binaires (macOS, Windows) : coût et secrets de CI à prévoir avant toute distribution publique.
- Maintenance d'un second artefact par plateforme.

## 6. Découpage en incréments (après validation)

1. `app-tray/` : `menu-model.ts` + tests (aucune GUI).
2. Pilote Node : lancement du relais, lecture de l'URL, polling de `/status`, `SIGTERM` ; tests avec un faux binaire et un relais réel.
3. Binaire de menu natif + build CI croisé.
4. Documentation : `docs/tray.md` (installation, accessibilité par OS, repli sans icône), lien depuis le README ; `docs.test.ts` si une section est vérifiée.

## 7. Questions ouvertes

1. **Enveloppe** : c) binaire natif (recommandé), ou a) Electron / b) Tauri si une fenêtre native devient un objectif ? Et, pour c), Go (bibliothèques systray existantes) ou Rust (crate `tray-icon`, partagée avec Tauri) ?
2. **Distribution** : paquet npm `agent-lens-tray` avec binaires en `optionalDependencies` par OS, ou binaires attachés aux releases GitHub (signés) ?
3. **Plateformes visées** pour la v1 : macOS et Windows seulement, Linux en « au mieux » ? Quelles architectures (x64, arm64) ?
4. **i18n des libellés** : #247 a livré un catalogue pour l'UI web (`web/lib/messages.ts`, `fr` et `en`, clés vérifiées par `scripts/messages.test.ts`). Faut-il réutiliser ce catalogue (clés `tray.*`, ajoutées à chaque locale à la fois) en choisissant la langue d'après la locale du système, ou garder des libellés en anglais seulement pour la v1 ? Proposition : réutiliser le catalogue. `deriveMenu` prend alors une fonction de traduction en paramètre, et les tests vérifient les deux locales.
5. **URL d'appairage** : le menu proposé dans #335 affiche « l'URL ». Avant le jeton de #241, la seule URL est `http://127.0.0.1:<port>` : faut-il un élément « Copier l'URL locale » seulement, et reporter tout élément d'appairage à la livraison du jeton (étape 2 de #241) ? Proposition : oui, aucun élément d'appairage tant que le jeton n'existe pas.
6. **Windows et `SIGTERM`** : `process.kill(pid, 'SIGTERM')` y termine le processus sans exécuter les gestionnaires. Faut-il un canal d'arrêt sans réseau (par exemple fermer le stdin de l'enfant, ou un IPC Node entre parent et enfant) qui appelle le même `cleanup` ? Cela touche `server.ts` et demande la revue `relay-hardening-reviewer`.
7. **Lecture de l'URL sur stdout** : s'appuyer sur la ligne `Server running at …` existante (fragile si son texte change), ou ajouter une sortie machine (par exemple `--print-url-json`), testée ?
