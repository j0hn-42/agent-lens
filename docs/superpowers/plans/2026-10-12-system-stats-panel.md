# Panneau de santé machine : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un panneau « System » qui montre CPU, RAM, swap, disque et charge de la machine, mesurés par le relay et poussés par SSE aux clients locaux.

**Architecture:** Un module pur `scripts/system-stats.ts` produit un `SystemSample` (valeurs mesurées ou `null`). Le relay l'échantillonne toutes les 2 s via le `SharedTicker` existant et le diffuse avec `broadcastLocal`. Le web garde 60 points dans un buffer circulaire pur et les affiche dans un panneau qui suit le précédent du panneau Context (#180).

**Tech Stack:** TypeScript, `node:test` via tsx, Node `os`/`fs`, React 19, Tailwind 4, tokens de thème (`web/lib/theme-tokens.json`).

**Spec:** `docs/superpowers/specs/2026-10-12-system-stats-panel-design.md` (issue #357).

## Global Constraints

- Aucun chiffre non mesuré : une métrique indisponible vaut `null` et s'affiche « non disponible », jamais 0.
- `broadcastLocal` uniquement : rien de la machine ne sort par un tunnel (#241).
- Pas de nouvelle dépendance npm.
- Intervalle d'échantillonnage : 2 s. Buffer web : 60 points.
- Seuils : `normal` < 0,85 ≤ `warm` < 0,95 ≤ `critical`.
- Nom du panneau : « System » (« Stats » est déjà pris). Raccourci : `y`.
- WCAG 2.1 AA : `role="meter"`, gravité en texte et icône, `prefers-reduced-motion`, couleurs depuis les tokens. Ne pas élargir `web/tests-a11y/lint-baseline.json` ni `known-violations.json`.
- Jamais d'édition à la main de `web/app/themes.css` (`pnpm run gen:themes`) ni de `pnpm-lock.yaml`.
- Tests d'abord, un commit par étape logique, `(#357)` dans chaque message de commit, trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Les tests ouvrent des ports fixes : `unshare -rn sh -c 'ip link set lo up; <cmd>'`, jamais deux suites en parallèle.

## Review Focus

- Compteurs CPU qui reculent ou ne bougent pas (delta nul) : `null`, jamais NaN ni 0 inventé.
- `/proc/meminfo` sans `MemAvailable` (vieux noyau) sous Linux : `mem` vaut `null`, pas la valeur trompeuse de `os.freemem()`.
- Message SSE `system-stats` malformé ou hostile (champs manquants, NaN, valeurs négatives ou énormes, tableau `perCore` géant) : rejeté ou borné côté web.
- Client SSE uniquement distant (tunnel) : le timer ne tourne pas pour lui, et il ne reçoit jamais l'événement.
- Disque ou swap absent (swap de taille 0, `statfs` en erreur) : « non disponible » ou « aucun swap », pas 0 %.

---

## Fichiers

| Fichier | Rôle |
|---|---|
| `scripts/system-stats.ts` (créer) | Échantillonneur pur, lectures injectées |
| `scripts/system-stats.test.ts` (créer) | Tests de l'échantillonneur |
| `scripts/relay.ts` (modifier) | Timer partagé, diffusion locale, `debugState` |
| `scripts/system-stats-relay.test.ts` (créer) | Tests relay |
| `web/lib/bridge-types.ts` (modifier) | Miroir `SystemSample` |
| `web/lib/system-stats.ts` (créer) | Garde de message, buffer, résumé, gravité |
| `scripts/system-stats-web.test.ts` (créer) | Tests du modèle web |
| `web/hooks/use-vscode-bridge.ts` (modifier) | Reçoit et expose le buffer |
| `web/lib/panel-layout.ts`, `scripts/panel-layout.test.ts` (modifier) | Id `'system'` dans le dock gauche |
| `web/lib/ui-glossary.ts`, `web/lib/shortcuts.ts`, `web/hooks/use-keyboard-shortcuts.ts` (modifier) | Nom, raccourci `y` |
| `web/components/agent-visualizer/system-panel.tsx` (créer) | Le panneau |
| `web/components/agent-visualizer/top-bar.tsx`, `index.tsx` (modifier) | Bouton et branchement |
| `web/lib/theme-tokens.json` (modifier), `web/app/themes.css` (généré) | Tokens de gravité |
| `docs/system-stats.md` (créer), `docs/reading-the-ui.md` (modifier) | Documentation |

---

### Task 1: Échantillonneur `scripts/system-stats.ts`

**Files:**
- Create: `scripts/system-stats.ts`
- Test: `scripts/system-stats.test.ts`

**Interfaces:**
- Produces:
  - `export interface SystemSample { ts: number; cpu: { total: number | null; perCore: (number | null)[] }; mem: Usage | null; swap: Usage | null; disk: Usage | null; load: [number, number, number] | null; uptime: number | null; platformNote: string | null }`
  - `export interface Usage { total: number; used: number }`
  - `export interface CpuCounters { idle: number; total: number }` (par cœur)
  - `export interface SystemIo { now(): number; cpus(): { times: { user: number; nice: number; sys: number; idle: number; irq: number } }[]; loadavg(): number[]; uptime(): number; totalmem(): number; freemem(): number; platform: string; readText(path: string): string | null; statfs(path: string): { blocks: number; bsize: number; bavail: number } | null; cwd: string }`
  - `export function nodeIo(): SystemIo`
  - `export function sampleSystem(prev: CpuCounters[] | null, io: SystemIo): { sample: SystemSample; counters: CpuCounters[] }`

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
// scripts/system-stats.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sampleSystem, type SystemIo } from './system-stats'

const KB = 1024
const meminfo = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k}:   ${v} kB`).join('\n')

function fakeIo(over: Partial<SystemIo> & { cpuIdle?: number[]; cpuBusy?: number[] } = {}): SystemIo {
  const idle = over.cpuIdle ?? [100, 100]
  const busy = over.cpuBusy ?? [100, 100]
  return {
    now: () => 1_000,
    cpus: () => idle.map((i, n) => ({ times: { user: busy[n], nice: 0, sys: 0, idle: i, irq: 0 } })),
    loadavg: () => [1, 2, 3],
    uptime: () => 42,
    totalmem: () => 8 * 1024 * KB,
    freemem: () => 1024 * KB,
    platform: 'linux',
    readText: (p) => p === '/proc/meminfo'
      ? meminfo({ MemTotal: 8192, MemAvailable: 6144, SwapTotal: 2048, SwapFree: 1024 })
      : p === '/proc/version' ? 'Linux version 5.15 generic' : null,
    statfs: () => ({ blocks: 1000, bsize: 4096, bavail: 250 }),
    cwd: '/work',
    ...over,
  }
}

test('premier échantillon : cpu null, pas de 0 inventé', () => {
  const { sample } = sampleSystem(null, fakeIo())
  assert.equal(sample.cpu.total, null)
  assert.deepEqual(sample.cpu.perCore, [null, null])
})

test('delta CPU : part occupée entre deux lectures', () => {
  const first = sampleSystem(null, fakeIo({ cpuIdle: [100, 100], cpuBusy: [100, 100] }))
  const { sample } = sampleSystem(first.counters, fakeIo({ cpuIdle: [150, 100], cpuBusy: [150, 200] }))
  assert.equal(sample.cpu.perCore[0], 0.5)
  assert.equal(sample.cpu.perCore[1], 1)
  assert.equal(sample.cpu.total, 0.75)
})

test('compteurs qui reculent ou delta nul : null', () => {
  const first = sampleSystem(null, fakeIo({ cpuIdle: [200, 100], cpuBusy: [200, 100] }))
  const { sample } = sampleSystem(first.counters, fakeIo({ cpuIdle: [100, 100], cpuBusy: [100, 100] }))
  assert.equal(sample.cpu.perCore[0], null)
  assert.equal(sample.cpu.perCore[1], null)
  assert.equal(sample.cpu.total, null)
})

test('Linux : la RAM utilise MemAvailable, pas os.freemem', () => {
  const { sample } = sampleSystem(null, fakeIo())
  assert.deepEqual(sample.mem, { total: 8192 * KB, used: (8192 - 6144) * KB })
})

test('Linux sans MemAvailable : mem null (os.freemem compte le cache comme utilisé)', () => {
  const io = fakeIo({ readText: (p) => (p === '/proc/meminfo' ? meminfo({ MemTotal: 8192 }) : null) })
  assert.equal(sampleSystem(null, io).sample.mem, null)
})

test('hors Linux : os.totalmem - os.freemem', () => {
  const io = fakeIo({ platform: 'darwin', readText: () => null })
  const { sample } = sampleSystem(null, io)
  assert.deepEqual(sample.mem, { total: 8 * 1024 * KB, used: 7 * 1024 * KB })
  assert.equal(sample.swap, null)
})

test('swap : mesuré, et de taille 0 sans pourcentage inventé', () => {
  assert.deepEqual(sampleSystem(null, fakeIo()).sample.swap, { total: 2048 * KB, used: 1024 * KB })
  const none = fakeIo({ readText: (p) => (p === '/proc/meminfo' ? meminfo({ MemTotal: 8192, MemAvailable: 6144, SwapTotal: 0, SwapFree: 0 }) : null) })
  assert.deepEqual(sampleSystem(null, none).sample.swap, { total: 0, used: 0 })
})

test('disque : statfs, null en erreur', () => {
  assert.deepEqual(sampleSystem(null, fakeIo()).sample.disk, { total: 1000 * 4096, used: 750 * 4096 })
  assert.equal(sampleSystem(null, fakeIo({ statfs: () => null })).sample.disk, null)
})

test('charge : null sous Windows', () => {
  assert.deepEqual(sampleSystem(null, fakeIo()).sample.load, [1, 2, 3])
  assert.equal(sampleSystem(null, fakeIo({ platform: 'win32', readText: () => null })).sample.load, null)
})

test('platformNote : WSL2 signalé, sinon null', () => {
  const wsl = fakeIo({ readText: (p) => (p === '/proc/version' ? 'Linux version 5.15-microsoft-standard-WSL2' : p === '/proc/meminfo' ? meminfo({ MemTotal: 1, MemAvailable: 1, SwapTotal: 0, SwapFree: 0 }) : null) })
  assert.match(sampleSystem(null, wsl).sample.platformNote ?? '', /WSL2/)
  assert.equal(sampleSystem(null, fakeIo()).sample.platformNote, null)
})

test('une lecture qui lève ne casse pas les autres métriques', () => {
  const io = fakeIo({ statfs: () => { throw new Error('boom') }, readText: () => { throw new Error('boom') } })
  const { sample } = sampleSystem(null, io)
  assert.equal(sample.disk, null)
  assert.equal(sample.mem, null)
  assert.equal(sample.uptime, 42)
})
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run: `unshare -rn sh -c 'ip link set lo up; pnpm exec tsx --test scripts/system-stats.test.ts'`
Expected: FAIL, module `./system-stats` introuvable.

- [ ] **Step 3: Implémenter**

```ts
// scripts/system-stats.ts
/**
 * Machine health sample for the System panel (#357). Every figure is measured or null: a metric that
 * cannot be read is never replaced by 0 (docs/reading-the-ui.md). Reads are injected (SystemIo) so the
 * logic is testable without a real machine.
 */
import fs from 'node:fs'
import os from 'node:os'

export interface Usage { total: number; used: number }

export interface SystemSample {
  ts: number
  cpu: { total: number | null; perCore: (number | null)[] }
  mem: Usage | null
  swap: Usage | null
  disk: Usage | null
  load: [number, number, number] | null
  uptime: number | null
  platformNote: string | null
}

export interface CpuCounters { idle: number; total: number }

export interface SystemIo {
  now(): number
  cpus(): { times: { user: number; nice: number; sys: number; idle: number; irq: number } }[]
  loadavg(): number[]
  uptime(): number
  totalmem(): number
  freemem(): number
  platform: string
  readText(path: string): string | null
  statfs(path: string): { blocks: number; bsize: number; bavail: number } | null
  cwd: string
}

export function nodeIo(): SystemIo {
  return {
    now: () => Date.now(),
    cpus: () => os.cpus(),
    loadavg: () => os.loadavg(),
    uptime: () => os.uptime(),
    totalmem: () => os.totalmem(),
    freemem: () => os.freemem(),
    platform: process.platform,
    readText: (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } },
    statfs: (p) => {
      try { const s = fs.statfsSync(p); return { blocks: Number(s.blocks), bsize: Number(s.bsize), bavail: Number(s.bavail) } } catch { return null }
    },
    cwd: process.cwd(),
  }
}

/** Run one read; a failing read yields null for that metric only. */
function safe<T>(read: () => T | null): T | null {
  try { return read() } catch { return null }
}

const toCounters = (t: { user: number; nice: number; sys: number; idle: number; irq: number }): CpuCounters =>
  ({ idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq })

/** Busy share (0..1) between two readings; null when there is no valid delta. */
function busyShare(prev: CpuCounters | undefined, cur: CpuCounters): number | null {
  if (!prev) return null
  const total = cur.total - prev.total
  const idle = cur.idle - prev.idle
  if (!(total > 0) || idle < 0 || idle > total) return null
  return 1 - idle / total
}

function parseMeminfo(text: string | null): Record<string, number> | null {
  if (!text) return null
  const out: Record<string, number> = {}
  for (const line of text.split('\n')) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line)
    if (m) out[m[1]] = Number(m[2]) * 1024
  }
  return out
}

export function sampleSystem(prev: CpuCounters[] | null, io: SystemIo): { sample: SystemSample; counters: CpuCounters[] } {
  const counters = (safe(() => io.cpus().map(c => toCounters(c.times))) ?? [])
  const perCore = counters.map((c, i) => busyShare(prev?.[i], c))
  const total = (() => {
    if (!prev || counters.length === 0 || prev.length !== counters.length) return null
    const dTotal = counters.reduce((sum, c, i) => sum + (c.total - prev[i].total), 0)
    const dIdle = counters.reduce((sum, c, i) => sum + (c.idle - prev[i].idle), 0)
    return dTotal > 0 && dIdle >= 0 && dIdle <= dTotal ? 1 - dIdle / dTotal : null
  })()

  const linux = io.platform === 'linux'
  const info = linux ? safe(() => parseMeminfo(io.readText('/proc/meminfo'))) : null

  const mem = safe((): Usage | null => {
    if (linux) {
      if (!info || info.MemTotal === undefined || info.MemAvailable === undefined) return null
      return { total: info.MemTotal, used: info.MemTotal - info.MemAvailable }
    }
    const t = io.totalmem()
    return { total: t, used: t - io.freemem() }
  })

  const swap = safe((): Usage | null => {
    if (!info || info.SwapTotal === undefined || info.SwapFree === undefined) return null
    return { total: info.SwapTotal, used: info.SwapTotal - info.SwapFree }
  })

  const disk = safe((): Usage | null => {
    const s = io.statfs(io.cwd)
    if (!s) return null
    return { total: s.blocks * s.bsize, used: (s.blocks - s.bavail) * s.bsize }
  })

  const load = safe((): [number, number, number] | null => {
    if (io.platform === 'win32') return null
    const l = io.loadavg()
    return [l[0], l[1], l[2]]
  })

  const platformNote = safe(() => /microsoft/i.test(io.readText('/proc/version') ?? '')
    ? 'WSL2: values of the Linux VM, not of Windows' : null)

  return {
    counters,
    sample: { ts: io.now(), cpu: { total, perCore }, mem, swap, disk, load, uptime: safe(() => io.uptime()), platformNote },
  }
}
```

- [ ] **Step 4: Relancer, vérifier le succès**

Run: `unshare -rn sh -c 'ip link set lo up; pnpm exec tsx --test scripts/system-stats.test.ts'`
Expected: PASS (10 tests). Si le total CPU du test « delta » diffère, corriger l'implémentation, pas le test : (150−100 idle de 100 total + 100−0…) est calculé sur la somme des deltas.

- [ ] **Step 5: Typecheck et commit**

Run: `pnpm run lint:scripts`
Expected: pas d'erreur.

```bash
git add scripts/system-stats.ts scripts/system-stats.test.ts
git commit -m "feat(relay): échantillonneur de santé machine, mesuré ou null (#357)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Relay : timer partagé et diffusion locale

**Files:**
- Modify: `scripts/relay.ts` (près de `scanTicker`, l. ~848/895, de l'acquisition SSE l. ~1215, de `debugState` l. ~665/1294 et de l'arrêt l. ~1332)
- Test: `scripts/system-stats-relay.test.ts`

**Interfaces:**
- Consumes: `sampleSystem`, `nodeIo`, `CpuCounters` (Task 1) ; `SharedTicker` (`scripts/server-hardening.ts`) ; `broadcastLocal`, `remoteSseClients`, `hostClass`.
- Produces: message SSE `{ type: 'system-stats', sample: SystemSample }` ; champ `systemTimerActive: boolean` dans `debugState()`.

- [ ] **Step 1: Lire le harnais de test existant**

Lire `scripts/relay-hardening.test.ts` (démarrage d'un relay, connexion SSE, `debugState()`) et en reprendre le harnais tel quel : mêmes helpers, même nettoyage. Ne pas en inventer un.

- [ ] **Step 2: Écrire les tests qui échouent**

Dans `scripts/system-stats-relay.test.ts`, avec le harnais lu à l'étape 1 :

```ts
// Esquisse : adapter les noms de helpers à ceux de relay-hardening.test.ts
test('un client local reçoit system-stats ; le timer démarre à la 1re connexion et s\'arrête à la dernière', async () => {
  const relay = await startTestRelay({ systemIntervalMs: 20 })      // option test : intervalle court
  assert.equal(relay.debugState().systemTimerActive, false)
  const client = await connectSse(relay)
  const msg = await nextMessage(client, m => m.type === 'system-stats')
  assert.equal(typeof msg.sample.ts, 'number')
  assert.equal(relay.debugState().systemTimerActive, true)
  await client.close()
  await waitFor(() => relay.debugState().systemTimerActive === false)
})

test('un client distant (Host tunnel) ne reçoit jamais system-stats et ne démarre pas le timer', async () => {
  const relay = await startTestRelay({ systemIntervalMs: 20, allowHost: 'tunnel.example' })
  const remote = await connectSse(relay, { host: 'tunnel.example' })
  await sleep(120)
  assert.equal(remote.messages.some(m => m.type === 'system-stats'), false)
  assert.equal(relay.debugState().systemTimerActive, false)
})
```

- [ ] **Step 3: Lancer, vérifier l'échec**

Run: `unshare -rn sh -c 'ip link set lo up; pnpm exec tsx --test scripts/system-stats-relay.test.ts'`
Expected: FAIL (`systemTimerActive` indéfini).

- [ ] **Step 4: Implémenter dans `relay.ts`**

À côté de `scanTicker` (déclaration l. ~848) :

```ts
let systemTicker: SharedTicker | null = null
let cpuCounters: CpuCounters[] | null = null
```

Après la création de `scanTicker` (l. ~895) :

```ts
    // System panel (#357): one shared sampler for the local clients; nothing runs without one.
    const systemIo = nodeIo()
    systemTicker = new SharedTicker(() => {
      const { sample, counters } = sampleSystem(cpuCounters, systemIo)
      cpuCounters = counters
      broadcastLocal(JSON.stringify({ type: 'system-stats', sample }))
    }, options.systemIntervalMs ?? SYSTEM_INTERVAL_MS)
```

Constante en tête de fichier, avec les autres intervalles : `const SYSTEM_INTERVAL_MS = 2_000`. Si `options` n'a pas de champ pour surcharger un intervalle en test, suivre la façon dont `SCAN_INTERVAL_MS` est surchargé dans les tests existants (même mécanisme).

À l'acquisition SSE (l. ~1215), uniquement pour les clients locaux :

```ts
      const releaseTicker = scanTicker?.acquire()
      const releaseSystem = hostClass !== 'allowed' ? systemTicker?.acquire() : undefined
      const releaseHeartbeat = heartbeatTicker.acquire()
```

et dans `onGone` : `releaseSystem?.()`. À l'arrêt (l. ~1332) : `systemTicker?.stop(); cpuCounters = null`. Dans `debugState` (type l. ~665 et valeur l. ~1294) : ajouter `systemTimerActive: boolean` / `systemTimerActive: systemTicker?.active ?? false`.

Importer en tête : `import { nodeIo, sampleSystem, type CpuCounters } from './system-stats'`. Le premier tick après une pause du timer a `cpu: null` car `cpuCounters` est remis à `null` à l'arrêt.

- [ ] **Step 5: Relancer, puis le test de non-régression du relay**

Run: `unshare -rn sh -c 'ip link set lo up; pnpm exec tsx --test scripts/system-stats-relay.test.ts scripts/relay-hardening.test.ts'`
Expected: PASS. Puis `pnpm run lint:scripts`.

- [ ] **Step 6: Commit**

```bash
git add scripts/relay.ts scripts/system-stats-relay.test.ts
git commit -m "feat(relay): diffuse system-stats aux clients locaux, timer partagé (#357)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Modèle web : garde, buffer, résumé, gravité

**Files:**
- Modify: `web/lib/bridge-types.ts` (ajouter le miroir de `SystemSample`)
- Create: `web/lib/system-stats.ts`
- Test: `scripts/system-stats-web.test.ts`

**Interfaces:**
- Produces (`web/lib/system-stats.ts`) :
  - `export const SYSTEM_HISTORY = 60`
  - `export function parseSystemSample(data: unknown): SystemSample | null` (valide et borne)
  - `export function pushSample(buffer: readonly SystemSample[], sample: SystemSample): SystemSample[]`
  - `export type Severity = 'normal' | 'warm' | 'critical' | 'unknown'`
  - `export function severity(ratio: number | null): Severity`
  - `export function ratio(u: Usage | null): number | null` (null si `total` ≤ 0)
  - `export function summarise(buffer: readonly SystemSample[], pick: (s: SystemSample) => number | null): { current: number | null; max: number | null }`

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
// scripts/system-stats-web.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSystemSample, pushSample, severity, ratio, summarise, SYSTEM_HISTORY } from '../web/lib/system-stats'

const base = { ts: 1, cpu: { total: 0.5, perCore: [0.5] }, mem: { total: 100, used: 50 }, swap: null, disk: null, load: [1, 1, 1], uptime: 5, platformNote: null }

test('parseSystemSample : accepte un échantillon valide', () => {
  assert.deepEqual(parseSystemSample(base)?.cpu.total, 0.5)
})

test('parseSystemSample : rejette ou borne le hostile', () => {
  assert.equal(parseSystemSample(null), null)
  assert.equal(parseSystemSample({ ...base, ts: 'x' }), null)
  assert.equal(parseSystemSample({ ...base, cpu: { total: NaN, perCore: [] } })?.cpu.total, null)
  assert.equal(parseSystemSample({ ...base, cpu: { total: 7, perCore: [] } })?.cpu.total, null)
  assert.equal(parseSystemSample({ ...base, mem: { total: -1, used: 5 } })?.mem, null)
  assert.equal(parseSystemSample({ ...base, mem: { total: 10, used: 99 } })?.mem, null)
  assert.equal(parseSystemSample({ ...base, cpu: { total: 0.1, perCore: new Array(5000).fill(0.1) } })?.cpu.perCore.length, 256)
})

test('pushSample : buffer circulaire borné, immuable', () => {
  let b: ReturnType<typeof pushSample> = []
  const frozen = Object.freeze([] as never[])
  assert.doesNotThrow(() => pushSample(frozen, parseSystemSample(base)!))
  for (let i = 0; i < SYSTEM_HISTORY + 10; i++) b = pushSample(b, { ...parseSystemSample(base)!, ts: i })
  assert.equal(b.length, SYSTEM_HISTORY)
  assert.equal(b[b.length - 1].ts, SYSTEM_HISTORY + 9)
})

test('severity : bornes 0,85 et 0,95, null = unknown', () => {
  assert.equal(severity(0.849), 'normal')
  assert.equal(severity(0.85), 'warm')
  assert.equal(severity(0.949), 'warm')
  assert.equal(severity(0.95), 'critical')
  assert.equal(severity(null), 'unknown')
})

test('ratio : null si total nul', () => {
  assert.equal(ratio({ total: 0, used: 0 }), null)
  assert.equal(ratio({ total: 100, used: 25 }), 0.25)
  assert.equal(ratio(null), null)
})

test('summarise : ignore les null, max récent', () => {
  const s = (v: number | null, ts: number) => ({ ...parseSystemSample(base)!, ts, cpu: { total: v, perCore: [] } })
  const out = summarise([s(0.2, 1), s(null, 2), s(0.9, 3), s(null, 4)], x => x.cpu.total)
  assert.deepEqual(out, { current: null, max: 0.9 })
})
```

- [ ] **Step 2: Lancer, vérifier l'échec** (`tsx --test scripts/system-stats-web.test.ts`, module introuvable).

- [ ] **Step 3: Implémenter**

Dans `web/lib/bridge-types.ts`, copier l'interface  :

```ts
/** Mirror of scripts/system-stats.ts SystemSample (SSE `system-stats`, #357). */
export interface SystemUsage { total: number; used: number }
export interface SystemSample {
  ts: number
  cpu: { total: number | null; perCore: (number | null)[] }
  mem: SystemUsage | null
  swap: SystemUsage | null
  disk: SystemUsage | null
  load: [number, number, number] | null
  uptime: number | null
  platformNote: string | null
}
```

`web/lib/system-stats.ts` :

```ts
import type { SystemSample, SystemUsage } from './bridge-types'

export const SYSTEM_HISTORY = 60
const MAX_CORES = 256
const MAX_NOTE = 200

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const share = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

function usage(v: unknown): SystemUsage | null {
  if (!isRecord(v)) return null
  const total = num(v.total), used = num(v.used)
  if (total === null || used === null || used > total) return null
  return { total, used }
}

/** An SSE `system-stats` payload is data from the network: anything out of range becomes null, nothing is clamped into a plausible figure. */
export function parseSystemSample(data: unknown): SystemSample | null {
  if (!isRecord(data)) return null
  const ts = num(data.ts)
  if (ts === null) return null
  const cpu = isRecord(data.cpu) ? data.cpu : {}
  const perCore = Array.isArray(cpu.perCore) ? cpu.perCore.slice(0, MAX_CORES).map(share) : []
  const load = Array.isArray(data.load) && data.load.length === 3 && data.load.every(x => num(x) !== null)
    ? [data.load[0], data.load[1], data.load[2]] as [number, number, number] : null
  return {
    ts,
    cpu: { total: share(cpu.total), perCore },
    mem: usage(data.mem), swap: usage(data.swap), disk: usage(data.disk),
    load, uptime: num(data.uptime),
    platformNote: typeof data.platformNote === 'string' ? data.platformNote.slice(0, MAX_NOTE) : null,
  }
}

export function pushSample(buffer: readonly SystemSample[], sample: SystemSample): SystemSample[] {
  const next = [...buffer, sample]
  return next.length > SYSTEM_HISTORY ? next.slice(next.length - SYSTEM_HISTORY) : next
}

export type Severity = 'normal' | 'warm' | 'critical' | 'unknown'
export const WARM_AT = 0.85
export const CRITICAL_AT = 0.95

export function severity(r: number | null): Severity {
  if (r === null) return 'unknown'
  return r >= CRITICAL_AT ? 'critical' : r >= WARM_AT ? 'warm' : 'normal'
}

export function ratio(u: SystemUsage | null): number | null {
  return u && u.total > 0 ? u.used / u.total : null
}

export function summarise(buffer: readonly SystemSample[], pick: (s: SystemSample) => number | null): { current: number | null; max: number | null } {
  let max: number | null = null
  for (const s of buffer) { const v = pick(s); if (v !== null && (max === null || v > max)) max = v }
  return { current: buffer.length ? pick(buffer[buffer.length - 1]) : null, max }
}
```

- [ ] **Step 4: Relancer** : `pnpm exec tsx --test scripts/system-stats-web.test.ts` → PASS. Puis `pnpm run lint:scripts` et `pnpm --dir web exec tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add web/lib/bridge-types.ts web/lib/system-stats.ts scripts/system-stats-web.test.ts
git commit -m "feat(web): modèle de santé machine, garde de message et gravité (#357)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Le hook du bridge reçoit et expose le buffer

**Files:**
- Modify: `web/hooks/use-vscode-bridge.ts` (près de la ligne 314 où `isLaunchMessage` est traité ; type de retour l. ~117)

**Interfaces:**
- Consumes: `parseSystemSample`, `pushSample` (Task 3).
- Produces: champ `systemStats: readonly SystemSample[]` du retour du hook (vide tant que rien n'est reçu, et dans VS Code/démo).

- [ ] **Step 1: Lire** `web/hooks/use-vscode-bridge.ts` autour de la ligne 306-320 (le gestionnaire de messages) et du retour du hook, pour placer le code exactement à côté de `launches`.

- [ ] **Step 2: Test d'abord.** Si `scripts/` contient un test du bridge qui injecte des messages (chercher `use-vscode-bridge` dans `scripts/*.test.ts`), y ajouter : un message `{ type: 'system-stats', sample: <valide> }` ajoute un point, un message malformé n'en ajoute pas. Sinon, tester `parseSystemSample` + `pushSample` suffit (Task 3) et le branchement se vérifie à l'étape e2e de la Task 6.

- [ ] **Step 3: Implémenter.**

```ts
const [systemStats, setSystemStats] = useState<readonly SystemSample[]>([])
// dans le gestionnaire, à côté de isLaunchMessage :
if (isRecord(data) && data.type === 'system-stats') {
  const sample = parseSystemSample(data.sample)
  if (sample) setSystemStats(prev => pushSample(prev, sample))
  return
}
```

Exposer `systemStats` dans l'objet retourné et dans son type. Vider le buffer quand la source se déconnecte, comme le fait `setLaunches(new Map())` (l. ~385), pour ne jamais montrer des chiffres périmés comme actuels.

- [ ] **Step 4:** `pnpm --dir web exec tsc --noEmit` → PASS. Commit :

```bash
git add web/hooks/use-vscode-bridge.ts
git commit -m "feat(web): le bridge expose l'historique system-stats (#357)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Nom, raccourci `y`, bouton de la barre et dock

**Files:**
- Modify: `web/lib/ui-glossary.ts` (ajouter `system: 'System'` à `PANEL_NAMES`)
- Modify: `web/lib/shortcuts.ts` (entrée `y`, groupe `Panels`)
- Modify: `web/hooks/use-keyboard-shortcuts.ts` (cas `y`/`Y` : `a.toggleSystem()`)
- Modify: `web/lib/panel-layout.ts` (`PanelId` + dock gauche), `scripts/panel-layout.test.ts`
- Modify: `web/components/agent-visualizer/top-bar.tsx` (`PANEL_BUTTON_IDS.system`, bouton, `onTogglePanel`)
- Test: `scripts/keyboard-shortcuts.test.ts`, `scripts/panel-layout.test.ts`, `scripts/ui-glossary.test.ts`

**Interfaces:**
- Produces: `PANEL_NAMES.system`, `PanelId` accepte `'system'`, `PANEL_BUTTON_IDS.system = 'topbar-toggle-system'`, action `toggleSystem`.

- [ ] **Step 1: Tests d'abord.**
  - `scripts/panel-layout.test.ts` : lire comment les propriétés existantes (pas de chevauchement, hors barres, dans le viewport) génèrent leurs `open`. Étendre le générateur pour inclure `'system'`. Ajouter un test précis : avec `open: ['detail', 'system']` en dock large, `rects.system` existe, n'intersecte pas `rects.detail`, et se place en dessous de `detail` dans la colonne gauche.
  - `scripts/keyboard-shortcuts.test.ts` : vérifier l'unicité des touches (déjà testée) et que `y` appelle `toggleSystem`.
  - `scripts/ui-glossary.test.ts` : suivre ce que le test exige pour un nouveau nom de panneau.

- [ ] **Step 2: Lancer** → FAIL attendu (type `'system'` inconnu, etc.).

- [ ] **Step 3: Implémenter.**
  - `panel-layout.ts` : lire `tryDock` (l. 204-330) en entier. Ajouter `'system'` à `PanelId` et placer son rectangle dans la colonne gauche sous `detail` (même logique que `detail`, hauteur ≥ `DETAIL_SIZE.minH`, largeur `DETAIL_SIZE.w` ou la largeur de la colonne), avec repli en `sheet` comme les autres si pas de place. Mettre à jour le commentaire d'en-tête du fichier.
  - `shortcuts.ts` : `{ key: 'y', display: 'Y', description: \`Toggle ${PANEL_NAMES.system} panel (CPU, memory, disk)\`, group: 'Panels', singleKey: true }`.
  - `use-keyboard-shortcuts.ts` : suivre le motif de `case 'p': case 'P': a.toggleContext()` ; ajouter `toggleSystem` à l'interface d'actions.
  - `top-bar.tsx` : ajouter `system: 'topbar-toggle-system'`, un `ToggleButton` calqué sur celui de `context` (l. 371) avec `showSystem`, `openPanelLabel('system', 'Y')`, `shortcut="y"`, et élargir le type de `onTogglePanel`.

- [ ] **Step 4: Relancer** `pnpm test` limité : `unshare -rn sh -c 'ip link set lo up; pnpm exec tsx --test scripts/panel-layout.test.ts scripts/keyboard-shortcuts.test.ts scripts/ui-glossary.test.ts'` → PASS. Puis `pnpm --dir web exec tsc --noEmit`.

- [ ] **Step 5: Commit** `feat(web): panneau System : nom, raccourci y, bouton et place dans le dock (#357)`.

---

### Task 6: Le composant `system-panel.tsx` et son branchement

**Files:**
- Create: `web/components/agent-visualizer/system-panel.tsx`
- Modify: `web/components/agent-visualizer/index.tsx` (état `showSystem`, `useFocusReturn`, rendu, `closeTopPanel`, l. ~214/263/448/1173)
- Test: `web/tests-a11y/` (axe + clavier ; suivre le fichier le plus proche du panneau Context)

**Interfaces:**
- Consumes: `systemStats` (Task 4), `summarise`, `severity`, `ratio`, `Severity` (Task 3), `PanelHeader`, `SlidingPanel`, `useDockPanel`, `dockAttrs` (`shared-ui.tsx`), `CollapsibleSection`, `COLORS`.
- Produces: `export function SystemPanel(props: { visible: boolean; samples: readonly SystemSample[]; unavailableReason?: string; onClose: () => void })`.

- [ ] **Step 1: Lire** `project-context-panel.tsx` en entier : en-tête, `useDockPanel`, `dockAttrs`, `SlidingPanel`, `autoFocus`, fermeture ; et `collapsible-section.tsx`. Le nouveau panneau suit exactement la même structure.

- [ ] **Step 2: Tests d'abord** (axe + clavier, jsdom) : le panneau ouvert n'a aucune violation axe ; chaque jauge est un `role="meter"` avec nom accessible, et `aria-valuenow` absent quand la valeur est `null` ; `Échap` ferme ; le focus revient au bouton ; aucune jauge ne rend « 0 » pour une métrique `null` (texte « non disponible ») ; le détail par cœur est fermé par défaut ; une annonce polie n'est émise qu'au changement de gravité, pas à chaque échantillon.

- [ ] **Step 3: Implémenter.**
  - Corps : une ligne par métrique (CPU, Memory, Swap, Disk) avec libellé, valeur (`%` et octets formatés), barre, état en texte (`Normal` / `Warm` / `Critical` / `Not available`) et icône SVG `aria-hidden` distincte par gravité ; ligne « Load 1/5/15 » et « Uptime » ; `platformNote` si présent ; sparkline SVG `aria-hidden` par métrique avec, à côté, le résumé texte `Current x %, max y % over the last 2 min`.
  - Jauge : `<div role="meter" aria-label="CPU" aria-valuemin={0} aria-valuemax={100} aria-valuenow={…}>` ; sans `aria-valuenow` si `null`.
  - Swap de taille 0 : texte « No swap », pas de barre.
  - Aucun échantillon : « Waiting for the first measurement » ; `unavailableReason` (VS Code, démo) remplace tout le contenu : « System metrics come from the standalone relay; not available inside VS Code. »
  - Transitions CSS de largeur de barre seulement hors `prefers-reduced-motion`.
  - Couleurs de gravité : classes/variables des tokens de la Task 7 (utiliser des noms provisoires `--system-warm`, `--system-critical` définis à la Task 7 ; faire les deux tâches dans l'ordre 7 puis 6 si le contraste doit être vérifié avant).
  - Annonce : un effet qui compare la gravité par métrique à la précédente et appelle l'annonceur existant (`chrome-announcer.tsx`) seulement quand elle change.
  - `index.tsx` : `const [showSystem, setShowSystem] = useState(false)`, ajout aux listes de panneaux ouverts (l. ~426-433, `closeTopPanel` l. ~448), `useFocusReturn(showSystem, systemPanelRef, PANEL_BUTTON_IDS.system)`, rendu du panneau dans un `div` `display: contents` comme les autres, `unavailableReason` = `bridge.isVSCode` ou `bridge.useMockData` (mêmes conditions que Context).

- [ ] **Step 4: Vérifier.** `pnpm --dir web exec tsc --noEmit`, `pnpm --dir web run lint:a11y`, `pnpm run test:a11y` → PASS, baselines inchangées (`git diff --stat web/tests-a11y/*.json` vide). Comme le CSS et le rendu changent : `unshare -rn sh -c 'ip link set lo up; pnpm --dir web run test:e2e'`. Vérification visuelle : `pnpm run dev:demo`, ouvrir `http://localhost:3000`, appuyer sur `y` (en démo le panneau doit dire que les métriques ne sont pas disponibles, et rester lisible dans chaque thème). Le rendu avec de vraies données se vérifie avec le relay réel (`pnpm run dev` ou le CLI) : cocher CPU, RAM, disque.

- [ ] **Step 5: Commit** `feat(web): panneau System avec jauges accessibles et sparklines (#357)`.

---

### Task 7: Tokens de thème

**Files:**
- Modify: `web/lib/theme-tokens.json`
- Generated: `web/app/themes.css` (par `pnpm run gen:themes`, jamais à la main)
- Test: `scripts/theme-tokens.test.ts`, `scripts/contrast.test.ts`

- [ ] **Step 1:** Lire `web/lib/theme-tokens.json` et `scripts/contrast.test.ts` pour voir comment un token de statut est déclaré et testé en contraste (≥ 4,5:1 pour le texte, ≥ 3:1 pour les barres sur le fond du panneau, dans chaque thème).
- [ ] **Step 2:** Ajouter, pour chaque thème, des tokens `systemWarm` et `systemCritical` (et réutiliser les tokens de succès/neutre existants pour `normal`), en choisissant des valeurs qui passent le contraste. Étendre `contrast.test.ts` pour les couvrir.
- [ ] **Step 3:** `pnpm run gen:themes`, puis `unshare -rn sh -c 'ip link set lo up; pnpm exec tsx --test scripts/theme-tokens.test.ts scripts/contrast.test.ts'` → PASS.
- [ ] **Step 4: Commit** `feat(web): tokens de gravité du panneau System (#357)` (inclure `themes.css` généré).

---

### Task 8: Documentation, revues, vérification finale et PR

**Files:**
- Create: `docs/system-stats.md`
- Modify: `docs/reading-the-ui.md`, `docs/superpowers/specs/2026-10-12-system-stats-panel-design.md` (statut, raccourci `y`, nom « System », référence #357)
- Test: `scripts/docs.test.ts`, `scripts/ui-glossary.test.ts`

- [ ] **Step 1:** Rédiger `docs/system-stats.md` : ce qui est mesuré et d'où (CPU par delta de `os.cpus()`, RAM `MemAvailable`, swap, disque du dossier de travail, charge), `null` = « non disponible », limite WSL2, rien ne sort du loopback, indisponible dans VS Code et en démo. Ajouter la ligne dans `docs/reading-the-ui.md` et mettre à jour le glossaire si le test l'exige.
- [ ] **Step 2:** `unshare -rn sh -c 'ip link set lo up; pnpm exec tsx --test scripts/docs.test.ts scripts/ui-glossary.test.ts'` → PASS.
- [ ] **Step 3: Revues.** Lancer l'agent `relay-hardening-reviewer` (relay, SSE, `broadcastLocal`, timer) puis `a11y-reviewer` (panneau, tokens). Corriger les retours bloquants.
- [ ] **Step 4: Vérification complète** avec le skill `run-checks` (même ordre que la CI), un seul suite à la fois, dans `unshare -rn`. Rapporter chaque échec tel quel.
- [ ] **Step 5: PR.** Utiliser le skill `pr-fork` : `gh pr create --repo j0hn-42/agent-lens --base develop --head <branche> --label agent:frontend-engineer --label agent:backend-engineer`, gabarit `.github/pull_request_template.md`, `Closes #357`, fin du corps : `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Ne pas fusionner.

---

## Self-review

- **Couverture de la spec** : source (T1), relay et `broadcastLocal` et timer (T2), modèle web, seuils, buffer (T3), réception (T4), dock/raccourci/barre (T5), panneau et a11y (T6), tokens (T7), docs/revues/PR (T8). Question ouverte « touche du raccourci » tranchée : `y`.
- **Écarts avec la spec** : le panneau est nommé « System » (« Stats » existe), la minuterie réutilise `SharedTicker`, `uptime` devient `number | null`. À répercuter dans la spec à la Task 8.
- **Limites connues du plan** : T2, T4, T5 et T6 demandent de lire du code existant (harnais de test du relay, `tryDock`, `project-context-panel.tsx`) avant d'écrire, car je n'y ai pas lu chaque ligne ; les signatures et les points d'accroche sont exacts, pas le corps des helpers de test.
