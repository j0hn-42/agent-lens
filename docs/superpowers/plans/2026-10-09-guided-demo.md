# Démo guidée pas à pas : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter une démo pédagogique pilotée par l'utilisateur (`?scenario=guided`) : une carte explique l'interface étape par étape, met en surbrillance l'élément ciblé et montre toutes les entrées de la légende.

**Architecture:** Un scénario `guided` dédié (événements simulés comme `tour`), des étapes en données pures, un hook `useGuidedTour` qui appelle `pause()` puis `seek(step.time)` à chaque changement d'étape, une carte `GuidedTourCard` et un anneau de surbrillance. Un contexte React (`TourBridge`) évite de faire passer des props à travers `canvas.tsx`. La liste des entrées de légende devient une donnée partagée entre `graph-legend.tsx` et les tests.

**Tech Stack:** Next 16 / React 19 / Tailwind 4, `node:test` + tsx (scripts), jsdom + axe (`web/tests-a11y`), Playwright (e2e), pnpm.

**Spec:** `docs/superpowers/specs/2026-10-09-guided-demo-design.md` (section « Corrections issues de la lecture du code » incluse).

## Global Constraints

- Branche de base : `develop` (pas `main`). PR vers `jobailla/agent-lens`, jamais vers l'upstream `patoles/agent-flow`.
- Textes de l'interface en anglais, pas d'i18n ; vocabulaire de `web/lib/ui-glossary.ts` (`PANEL_NAMES`, `HIERARCHY_TERMS`).
- Aucune couleur en dur : tokens CSS / `COLORS` de `@/lib/colors` ; compatible avec tous les thèmes.
- « Ne jamais afficher un état ou un nombre non prouvé » (`CONTRIBUTING.md`) : un texte d'étape n'affirme que ce que le scénario produit.
- La démo existante (`tour`, `workflow`, classique), son test et `docs/demo.md` (partie démo actuelle) ne changent pas.
- Vérifications CI à garder vertes : `pnpm test`, `pnpm run test:a11y`, `pnpm --dir web exec tsc --noEmit`, `pnpm --dir web run lint:a11y`, `pnpm --filter agent-lens run lint`, `pnpm run lint:scripts`.
- Commits en français, un par tâche, terminés par `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Les commandes `pnpm` se lancent depuis la racine du worktree.

## Review Focus

- Navigation hors bornes (Précédent à l'étape 0, Suivant à la dernière) : ne plante pas et ne boucle pas.
- Les flèches `←`/`→` dans la carte ne doivent pas détourner la navigation clavier du graphe (elles ne valent que focus dans la carte).
- Quitter la visite relance la lecture et rend le focus à l'élément qui l'avait avant.
- Une étape qui cible un agent absent à cet instant (ou un élément DOM absent) n'affiche pas d'anneau et ne plante pas.
- Ouvrir la légende par la visite ne modifie pas la préférence mémorisée `agent-viz-legend-open`.
- `prefers-reduced-motion` : aucun mouvement de l'anneau n'est animé.

---

## File Structure

| Fichier | Rôle |
|---|---|
| `web/lib/legend-entries.ts` (créer) | Liste exhaustive des identifiants d'entrées de légende, par section. Pure, sans JSX. |
| `web/components/agent-visualizer/graph-legend.tsx` (modifier) | Chaque `Row` porte `data-legend-entry` ; `Heading` porte `data-tour-target` ; ouverture forcée par le contexte. |
| `web/lib/guided-scenario.ts` (créer) | `GUIDED_SCENARIO: SimulationEvent[]`. |
| `web/lib/mock-scenario.ts` (modifier) | Branche `?scenario=guided`. |
| `web/lib/guided-steps.ts` (créer) | `GUIDED_STEPS`, `DESCRIBED_ONLY`, type `GuidedStep`. |
| `web/lib/guided-tour-nav.ts` (créer) | État de navigation pur (`startTour`, `nextStep`, `prevStep`, `goToStep`, `exitTour`). |
| `web/hooks/use-guided-tour.ts` (créer) | Hook : état + `pause()` puis `seek()` à chaque étape. |
| `web/components/agent-visualizer/guided-tour-context.tsx` (créer) | Contexte `TourBridge` : légende ouverte, ref `canvasToScreen`. |
| `web/components/agent-visualizer/guided-tour-card.tsx` (créer) | Carte (dialog) : texte, navigation, liste des étapes. |
| `web/components/agent-visualizer/tour-highlight.tsx` (créer) | Anneau de surbrillance. |
| `web/components/agent-visualizer/index.tsx` (modifier) | Extrait `handleSeek`, monte le hook, la carte, l'anneau et le bouton d'entrée. |
| `web/components/agent-visualizer/canvas.tsx` (modifier) | Publie `canvasToScreen` dans le contexte. |
| `scripts/*.test.ts`, `web/tests-a11y/*.test.tsx`, `web/tests-a11y/e2e/guided.e2e.ts` | Tests (voir chaque tâche). |
| `package.json`, `docs/demo.md`, `docs/reading-the-ui.md`, `README.md` | Script `dev:demo:guided` et documentation. |

Faits vérifiés dans le code, sur lesquels ce plan s'appuie :
- `seekToTime(t)` rejoue `MOCK_SCENARIO` depuis zéro (`web/hooks/use-agent-simulation.ts:387`). Le `onSeek` de la barre de lecture (`index.tsx`, autour de la ligne 833) fait `seekingRef.current = true; pause(); seekToTime(time); setZoomToFitTrigger(n => n + 1)` puis arme un timer ; la visite réutilise cette séquence.
- `canvasToScreen(worldX, worldY)` existe dans `use-canvas-camera.ts:163` et est utilisé dans `canvas.tsx`.
- `CanvasControls` (et donc `GraphLegend`) est monté par `canvas.tsx:229`, pas par `index.tsx`.
- Aucun événement de la simulation ne produit l'état `paused` (seule `freshness.ts` le lit) : cette entrée reste « décrite seulement ».
- `Z` (`lib/agent-types.ts:313`) : `detailCard: 100`, `contextMenu: 200`.

---

### Task 1: Entrées de légende en données partagées

**Files:**
- Create: `web/lib/legend-entries.ts`
- Modify: `web/components/agent-visualizer/graph-legend.tsx`
- Test: `web/tests-a11y/legend-entries.test.tsx`

**Interfaces:**
- Produces: `LEGEND_ENTRIES` (objet `section → readonly string[]`), `LEGEND_ENTRY_IDS: readonly LegendEntryId[]`, `type LegendEntryId`, `type LegendSectionId`. `GraphLegend` rend chaque ligne avec `data-legend-entry="<id>"` et chaque titre de section avec `data-tour-target="legend-<section>"`.

- [ ] **Step 1: Écrire le test qui échoue**

`web/tests-a11y/legend-entries.test.tsx` :

```tsx
// Keeps the legend and its list of entries in sync: the guided tour must cover every entry (issue guided demo).
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React, { type ComponentProps } from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { GraphLegend } from '@/components/agent-visualizer/graph-legend'
import { LEGEND_ENTRY_IDS, LEGEND_ENTRIES } from '@/lib/legend-entries'

afterEach(() => { cleanup(); document.body.replaceChildren() })

const team = { key: 't', name: 'squad', color: '#ffffff', teamKind: 'team', memberNames: ['a'] }
const teams = [team] as unknown as ComponentProps<typeof GraphLegend>['teams']

test('the legend renders exactly the entries of LEGEND_ENTRY_IDS (one team row included)', () => {
  const view = render(<GraphLegend teams={teams} />)
  fireEvent.click(view.getByRole('button', { name: /legend/i }))
  const rendered = [...document.querySelectorAll('[data-legend-entry]')].map(el => el.getAttribute('data-legend-entry'))
  assert.deepEqual([...new Set(rendered)].sort(), [...LEGEND_ENTRY_IDS].sort())
  assert.equal(new Set(LEGEND_ENTRY_IDS).size, LEGEND_ENTRY_IDS.length, 'no duplicate id')
})

test('every section heading is a tour target', () => {
  const view = render(<GraphLegend teams={teams} />)
  fireEvent.click(view.getByRole('button', { name: /legend/i }))
  for (const section of Object.keys(LEGEND_ENTRIES)) {
    assert.ok(document.querySelector(`[data-tour-target="legend-${section}"]`), `heading of ${section}`)
  }
})
```

- [ ] **Step 2: Lancer le test, vérifier qu'il échoue**

Run: `pnpm --dir web exec node --import tsx --import ./tests-a11y/setup.ts --test tests-a11y/legend-entries.test.tsx`
Expected: FAIL (`Cannot find module '@/lib/legend-entries'`).

- [ ] **Step 3: Créer `web/lib/legend-entries.ts`**

```ts
/**
 * Every entry of the graph legend (graph-legend.tsx), by section. The legend renders each one with
 * `data-legend-entry`, and the guided tour must explain each one (scripts/guided-steps.test.ts).
 */
export const LEGEND_ENTRIES = {
  states: ['state-idle', 'state-thinking', 'state-tool_calling', 'state-waiting_permission', 'state-error', 'state-paused', 'state-complete'],
  shapes: ['shape-main', 'shape-sub', 'shape-tool', 'shape-discovery', 'shape-complete'],
  edges: ['edge-parent', 'edge-unverified', 'edge-tool', 'edge-badge-hidden', 'edge-badge-active', 'particle-dispatch', 'particle-return'],
  teams: ['team-ring', 'team-idle', 'team-working', 'team-done', 'team-archived', 'team-halo', 'session-halo', 'orchestrator', 'team-row'],
  links: ['link-flight', 'link-recent', 'link-error', 'link-quiet', 'link-bubble'],
  context: ['ctx-system', 'ctx-user', 'ctx-tool-results', 'ctx-reasoning', 'ctx-subagent'],
  discoveries: ['disc-file', 'disc-pattern', 'disc-finding', 'disc-code'],
  runtime: ['rt-claude', 'rt-codex'],
} as const

export type LegendSectionId = keyof typeof LEGEND_ENTRIES
export type LegendEntryId = (typeof LEGEND_ENTRIES)[LegendSectionId][number]

export const LEGEND_ENTRY_IDS: readonly LegendEntryId[] = Object.values(LEGEND_ENTRIES).flat() as LegendEntryId[]
```

- [ ] **Step 4: Brancher les identifiants dans `graph-legend.tsx`**

Modifications (le reste du fichier est inchangé) :

1. Imports : `import { LEGEND_ENTRIES, type LegendEntryId, type LegendSectionId } from '@/lib/legend-entries'`.
2. `Row` reçoit `id` :

```tsx
function Row({ id, icon, children }: { id: LegendEntryId; icon: ReactNode; children: ReactNode }) {
  return (
    <li data-legend-entry={id} className="flex items-center gap-2 min-h-5">
```

3. `Heading` reçoit `section` :

```tsx
function Heading({ section, children }: { section: LegendSectionId; children: ReactNode }) {
  return <h3 data-tour-target={`legend-${section}`} className="mt-2 mb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: COLORS.textMuted }}>{children}</h3>
}
```

4. Chaque `<Heading>` reçoit son `section` (`states`, `shapes`, `edges`, `teams`, `links`, `context`, `discoveries`, `runtime`).
5. Chaque `<Row>` reçoit son `id`, dans l'ordre de `LEGEND_ENTRIES` :
   - États : `<Row key={state} id={`state-${state}` as LegendEntryId} …>`.
   - Formes : `shape-main`, `shape-sub`, `shape-tool`, `shape-discovery`, `shape-complete`.
   - Edges : `edge-parent`, `edge-unverified`, `edge-tool`, `edge-badge-hidden`, `edge-badge-active`, `particle-dispatch`, `particle-return`.
   - Teams : `team-ring`, `team-idle`, `team-working`, `team-done`, `team-archived`, `team-halo`, `session-halo`, `orchestrator`, puis `id="team-row"` sur la ligne dynamique de chaque équipe.
   - Liens : `link-flight`, `link-recent`, `link-error`, `link-quiet`, `link-bubble`.
   - Contexte : ajouter `id` aux objets de `contextSegmentList()` (`ctx-system`, `ctx-user`, `ctx-tool-results`, `ctx-reasoning`, `ctx-subagent`) et passer `id={seg.id}`.
   - Découvertes : `id={`disc-${d.type}` as LegendEntryId}`.
   - Runtime : `rt-claude`, `rt-codex`.

- [ ] **Step 5: Lancer le test et le typecheck**

Run: `pnpm --dir web exec node --import tsx --import ./tests-a11y/setup.ts --test tests-a11y/legend-entries.test.tsx && pnpm --dir web exec tsc --noEmit`
Expected: PASS, aucune erreur de type.

- [ ] **Step 6: Non-régression a11y et commit**

Run: `pnpm run test:a11y`
Expected: PASS (la légende n'a changé que par des attributs).

```bash
git add web/lib/legend-entries.ts web/components/agent-visualizer/graph-legend.tsx web/tests-a11y/legend-entries.test.tsx
git commit -m "refactor(legend): entrées de légende en données partagées (démo guidée)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Scénario `guided`

**Files:**
- Create: `web/lib/guided-scenario.ts`
- Modify: `web/lib/mock-scenario.ts` (import ligne 4 ; sélection autour de la ligne 245) ; `package.json` (script `dev:demo:guided`)
- Test: `scripts/guided-scenario.test.ts`

**Interfaces:**
- Produces: `GUIDED_SCENARIO: SimulationEvent[]` (trié par `time`, sans `sessionId`, durée ≤ 50 s) ; `?scenario=guided` sélectionne ce scénario dans `MOCK_SCENARIO`.

Une seule « session » implicite (comme le scénario classique), pas de `MOCK_SESSIONS`. Acte par acte (les instants servent de repères aux étapes de la Task 3) :

| Acte | Instants | Contenu |
|---|---|---|
| A | 0 – 5 | agent principal Claude, message, réflexion, `Glob`, `Read` (découverte *file*), `Grep` (découverte *pattern*) |
| B | 6 – 10 | `explore-agent` (dispatch, spawn, `Read` découverte *code*, `Grep` découverte *finding*, retour, fin) |
| C | 12 – 16 | demande de permission, puis `Bash` |
| D | 18 – 25 | `test-runner` : outil en erreur, retour |
| E | 27 – 35 | équipe `payments-squad` : `api-dev` et `qa-dev`, messages entre eux |
| F | 37 – 42 | agent Codex (runtime `codex`) |
| G | 44 – 46 | message final, fin de l'agent principal |

- [ ] **Step 1: Écrire le test qui échoue**

`scripts/guided-scenario.test.ts` :

```ts
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { GUIDED_SCENARIO } from '../web/lib/guided-scenario'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import type { SimulationEvent } from '../web/lib/agent-types'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}
function play(events: SimulationEvent[]): SimulationState {
  let state = createEmptyState()
  for (const e of events) state = processEvent(e, { ...state, currentTime: e.time }, ctx)
  return state
}

test('the guided scenario is sorted by time: the player reads it in array order', () => {
  for (let i = 1; i < GUIDED_SCENARIO.length; i++) {
    assert.ok(GUIDED_SCENARIO[i].time >= GUIDED_SCENARIO[i - 1].time, `event ${i} (t=${GUIDED_SCENARIO[i].time}) is before t=${GUIDED_SCENARIO[i - 1].time}`)
  }
})

test('the guided scenario is short enough for seekToTime to replay it instantly', () => {
  assert.ok(GUIDED_SCENARIO[GUIDED_SCENARIO.length - 1].time <= 50)
})

test('the played scenario produces what the tour explains', () => {
  const s = play(GUIDED_SCENARIO)
  const agents = [...s.agents.values()]
  assert.ok(agents.some(a => a.runtime === 'codex'), 'a Codex agent')
  assert.ok(agents.some(a => a.runtime !== 'codex'), 'a Claude agent')
  assert.ok(agents.some(a => a.kind === 'subagent'), 'a sub-agent')
  assert.ok(agents.some(a => a.kind === 'teammate'), 'a teammate')
  assert.ok([...s.toolCalls.values()].some(t => t.state === 'error'), 'a failed tool call')
  assert.deepEqual(['code', 'file', 'finding', 'pattern'], [...new Set(s.discoveries.map(d => d.type))].sort())
  assert.ok(s.links.size > 0 && [...s.links.values()].some(l => l.messages.length > 0), 'a link with messages')
  assert.ok(s.teams.size > 0, 'a team')
})

test('the permission request puts the main agent in waiting_permission at that moment', () => {
  const t = GUIDED_SCENARIO.find(e => e.type === 'permission_requested')!.time
  const s = play(GUIDED_SCENARIO.filter(e => e.time <= t))
  assert.ok([...s.agents.values()].some(a => a.state === 'waiting_permission'))
})
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `node --import tsx --test scripts/guided-scenario.test.ts`
Expected: FAIL (`Cannot find module '../web/lib/guided-scenario'`).

- [ ] **Step 3: Écrire `web/lib/guided-scenario.ts`**

Même forme que `web/lib/tour-scenario.ts` (lire ses lignes 1-50 et 80-135 comme modèle exact des payloads) :

```ts
import type { SimulationEvent } from './agent-types'

// ─── Guided scenario (?scenario=guided) ──────────────────────────────────────
// The scenario behind the step-by-step tour (web/lib/guided-steps.ts). Short (< 50 s) so that
// seekToTime replays it instantly, and written act by act so that every legend entry has a moment where it
// is on screen. Single implicit session, like the classic demo.

type Payload = Record<string, unknown>
const events: SimulationEvent[] = []
const at = (time: number, type: SimulationEvent['type'], payload: Payload) => { events.push({ time, type, payload }) }
const breakdown = (systemPrompt: number, userMessages: number, toolResults: number, reasoning: number, subagentResults: number) =>
  ({ systemPrompt, userMessages, toolResults, reasoning, subagentResults })

/** A tool round: start, then end after `dur` seconds. */
function tool(time: number, dur: number, agent: string, name: string, args: string, end: Payload, inputData?: Payload) {
  at(time, 'tool_call_start', { agent, tool: name, args, ...(inputData ? { inputData } : {}) })
  at(time + dur, 'tool_call_end', { agent, tool: name, ...end })
}

// ── Act A · The main agent: thinking, tools, discoveries ──
at(0.0, 'agent_spawn', { name: 'orchestrator', isMain: true, task: 'Waiting for instructions...', model: 'claude-opus-5-5', modelSource: 'configured' })
at(0.2, 'message', { agent: 'orchestrator', role: 'user', content: 'Refactor the payment system to support Stripe and PayPal, add webhook handling, and write integration tests' })
at(0.4, 'context_update', { agent: 'orchestrator', tokens: 2200, breakdown: breakdown(1500, 700, 0, 0, 0) })
at(0.8, 'model_detected', { agent: 'orchestrator', model: 'claude-opus-5-5' })
at(1.0, 'message', { agent: 'orchestrator', role: 'thinking', content: 'Understand the existing payment code first, then delegate the research.' })
at(2.0, 'context_update', { agent: 'orchestrator', tokens: 3000, breakdown: breakdown(1500, 700, 0, 800, 0) })
tool(3.0, 0.3, 'orchestrator', 'Glob', 'src/**/*.ts', { result: '47 files matched', tokenCost: 500, tokenSource: 'reported' }, { pattern: 'src/**/*.ts' })
tool(3.5, 0.4, 'orchestrator', 'Read', 'src/services/payment.ts', {
  result: 'payment.ts — 234 lines, legacy processor with direct Stripe v2 calls', tokenCost: 3500, tokenSource: 'reported',
  discovery: { type: 'file', label: 'src/services/payment.ts', content: 'Legacy processor, 234 lines\nDirect Stripe v2 calls' },
}, { file_path: 'src/services/payment.ts' })
tool(4.1, 0.4, 'orchestrator', 'Grep', '"stripe|paypal|payment" --type ts', {
  result: '28 matches in 9 files', tokenCost: 700, tokenSource: 'reported',
  discovery: { type: 'pattern', label: 'Payment references', content: '28 matches across 9 files\nNo webhook handling found' },
}, { pattern: 'stripe|paypal|payment', type: 'ts' })
at(4.6, 'context_update', { agent: 'orchestrator', tokens: 11500, breakdown: breakdown(1500, 700, 6500, 2800, 0) })

// ── Act B · A sub-agent: dispatch, own discoveries, result returned ──
at(6.0, 'subagent_dispatch', { parent: 'orchestrator', child: 'explore-agent', toolUseId: 'toolu_guided_explore', task: 'Deep-dive into the payment flow and the database schema' })
at(6.3, 'agent_spawn', { name: 'explore-agent', parent: 'orchestrator', toolUseId: 'toolu_guided_explore', task: 'Analyze payment flow and database schema' })
at(6.6, 'context_update', { agent: 'explore-agent', tokens: 1800, breakdown: breakdown(1400, 400, 0, 0, 0) })
tool(7.5, 0.4, 'explore-agent', 'Read', 'src/models/payment.model.ts', {
  result: 'Prisma schema: Payment { id, amount, currency, status, provider }', tokenCost: 1200, tokenSource: 'reported',
  discovery: { type: 'code', label: 'Payment Model', content: 'Payment { id, amount, currency,\n  status, provider }' },
}, { file_path: 'src/models/payment.model.ts' })
tool(8.2, 0.4, 'explore-agent', 'Grep', '"catch|error|throw" src/services/', {
  result: '15 matches — minimal error handling, no retry logic', tokenCost: 500, tokenSource: 'reported',
  discovery: { type: 'finding', label: 'Weak error handling', content: 'No retry logic in the payment flow\nGeneric catch blocks only' },
}, { pattern: 'catch|error|throw', path: 'src/services/' })
at(9.2, 'subagent_return', { child: 'explore-agent', parent: 'orchestrator', toolUseId: 'toolu_guided_explore', summary: 'Legacy Stripe v2 calls, Prisma Payment model, weak error handling, no webhooks' })
at(9.2, 'agent_complete', { name: 'explore-agent' })
at(9.6, 'context_update', { agent: 'orchestrator', tokens: 24000, breakdown: breakdown(1500, 700, 8500, 4800, 8500) })

// ── Act C · A permission request ──
at(12.0, 'permission_requested', { agent: 'orchestrator' })
tool(14.0, 2.0, 'orchestrator', 'Bash', 'npm install stripe @paypal/checkout-server-sdk', { result: 'added 23 packages in 4.2s', tokenCost: 300, tokenSource: 'reported' }, { command: 'npm install stripe @paypal/checkout-server-sdk' })

// ── Act D · A failed tool call ──
at(18.0, 'subagent_dispatch', { parent: 'orchestrator', child: 'test-runner', toolUseId: 'toolu_guided_test', task: 'Run the test suite' })
at(18.3, 'agent_spawn', { name: 'test-runner', parent: 'orchestrator', toolUseId: 'toolu_guided_test', task: 'Run the integration tests' })
tool(20.0, 3.0, 'test-runner', 'Bash', 'npm test -- --coverage', {
  result: 'FAIL: StripeAdapter > should handle API errors\nError: STRIPE_SECRET_KEY is not defined\n\n6 passed, 3 failed',
  tokenCost: 400, tokenSource: 'reported', isError: true, errorMessage: 'STRIPE_SECRET_KEY is not defined',
}, { command: 'npm test -- --coverage' })
at(25.0, 'subagent_return', { child: 'test-runner', parent: 'orchestrator', toolUseId: 'toolu_guided_test', summary: '3 tests failing: STRIPE_SECRET_KEY is not defined' })
at(25.0, 'agent_complete', { name: 'test-runner' })

// ── Act E · An Agent Team: teammates and the messages between them ──
at(27.0, 'agent_spawn', { name: 'api-dev', parent: 'orchestrator', kind: 'teammate', teamName: 'payments-squad', color: '#4cc9f0', agentType: 'backend', task: 'Implement the webhook endpoints', model: 'claude-sonnet-5-5', modelSource: 'configured' })
at(27.2, 'agent_spawn', { name: 'qa-dev', parent: 'orchestrator', kind: 'teammate', teamName: 'payments-squad', color: '#f9c74f', agentType: 'qa', task: 'Verify the webhooks end to end', model: 'claude-sonnet-5-5', modelSource: 'configured' })
at(27.4, 'agent_link', { from: 'orchestrator', to: 'api-dev', kind: 'spawn', content: 'Take the Stripe webhooks: signature check + payment_intent.* events.' })
at(27.6, 'agent_activity', { name: 'api-dev', activity: 'working' })
at(27.7, 'agent_activity', { name: 'qa-dev', activity: 'idle' })
at(30.0, 'message_sent', { from: 'api-dev', to: 'qa-dev', kind: 'teammate', content: 'Webhook handler is in. It rejects bad signatures with SIGNATURE_MISMATCH.' })
at(30.1, 'agent_activity', { name: 'api-dev', activity: 'idle' })
at(30.2, 'agent_activity', { name: 'qa-dev', activity: 'working' })
at(33.0, 'message_sent', { from: 'qa-dev', to: 'api-dev', kind: 'teammate', content: 'Tampered payload is rejected as expected.' })
at(34.0, 'agent_activity', { name: 'api-dev', activity: 'done' })
at(34.2, 'agent_activity', { name: 'qa-dev', activity: 'done' })

// ── Act F · A Codex agent (second runtime) ──
at(37.0, 'agent_spawn', { name: 'codex', isMain: true, runtime: 'codex', task: 'Update the API reference', model: 'gpt-5-codex', modelSource: 'configured', effort: 'medium' })
at(37.3, 'message', { agent: 'codex', role: 'user', content: 'Update the API reference for the new payment gateway' })
at(37.6, 'context_update', { agent: 'codex', tokens: 5200, tokensMax: 272000, breakdown: breakdown(3000, 400, 0, 1800, 0) })
tool(38.5, 2.0, 'codex', 'Read', 'docs/api.md', { result: 'api.md — 120 lines', tokenCost: 900, tokenSource: 'reported' }, { file_path: 'docs/api.md' })
at(41.5, 'agent_complete', { name: 'codex' })

// ── Act G · End ──
at(44.0, 'message', { agent: 'orchestrator', content: 'Payment system refactored. Webhooks verified by the team.' })
at(46.0, 'agent_complete', { name: 'orchestrator' })

export const GUIDED_SCENARIO: SimulationEvent[] = events.sort((a, b) => a.time - b.time)
```

Si un payload diffère de ce que `process-event.ts` attend (la Step 4 le révèle), corriger **en copiant le payload équivalent de `tour-scenario.ts`**, jamais en assouplissant le test.

- [ ] **Step 4: Lancer le test**

Run: `node --import tsx --test scripts/guided-scenario.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Brancher `?scenario=guided` et le script**

Dans `web/lib/mock-scenario.ts` : ajouter `import { GUIDED_SCENARIO } from './guided-scenario'` après la ligne 4, et dans `MOCK_SCENARIO` :

```ts
export const MOCK_SCENARIO: SimulationEvent[] = stressLevel
  ? STRESS_SCENARIOS[stressLevel]()
  : SCENARIO_NAME === 'tour' ? TOUR_SCENARIO
  : SCENARIO_NAME === 'guided' ? GUIDED_SCENARIO
  : SCENARIO_NAME === 'workflow' ? WORKFLOW_MOCK_SCENARIO : NORMAL_MOCK_SCENARIO
```

Exporter aussi le nom pour la Task 5 : `export const IS_GUIDED_DEMO = !stressLevel && SCENARIO_NAME === 'guided'`.

Dans `package.json` (racine), après `dev:demo:classic` :

```json
"dev:demo:guided": "NEXT_PUBLIC_DEMO=1 NEXT_PUBLIC_DEMO_SCENARIO=guided pnpm run dev:web",
```

- [ ] **Step 6: Vérifier et commiter**

Run: `pnpm test && pnpm --dir web exec tsc --noEmit`
Expected: PASS ; `tour-scenario.test.ts` inchangé et vert.

```bash
git add web/lib/guided-scenario.ts web/lib/mock-scenario.ts package.json scripts/guided-scenario.test.ts
git commit -m "feat(demo): scénario guided pour la démo pas à pas

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Étapes et test de couverture de la légende

**Files:**
- Create: `web/lib/guided-steps.ts`
- Test: `scripts/guided-steps.test.ts`

**Interfaces:**
- Consumes: `LegendEntryId`, `LEGEND_ENTRY_IDS` (Task 1) ; `GUIDED_SCENARIO` (Task 2).
- Produces:

```ts
export type TourTarget =
  | { kind: 'dom'; id: string }      // [data-tour-target="<id>"]
  | { kind: 'agent'; name: string }  // agent of the canvas, by name
  | { kind: 'none' }
export interface GuidedStep {
  id: string
  time: number
  target: TourTarget
  opensLegend?: boolean
  title: string
  body: string
  covers: readonly LegendEntryId[]
}
export const GUIDED_STEPS: readonly GuidedStep[]
export const DESCRIBED_ONLY: readonly LegendEntryId[]
```

`DESCRIBED_ONLY` = entrées que la simulation ne peut pas produire par événements, expliquées en texte seulement : `state-paused` (aucun événement ne la produit), `edge-unverified`, `edge-badge-hidden`, `edge-badge-active` (repli de branche = action de l'utilisateur), `link-error`, `team-archived`, `session-halo` (pas de session déclarée).

- [ ] **Step 1: Écrire le test qui échoue**

`scripts/guided-steps.test.ts` :

```ts
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { GUIDED_SCENARIO } from '../web/lib/guided-scenario'
import { GUIDED_STEPS, DESCRIBED_ONLY } from '../web/lib/guided-steps'
import { LEGEND_ENTRY_IDS, type LegendEntryId } from '../web/lib/legend-entries'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import type { SimulationEvent } from '../web/lib/agent-types'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}
const playUntil = (time: number): SimulationState => {
  let state = createEmptyState()
  for (const e of GUIDED_SCENARIO.filter(ev => ev.time <= time)) state = processEvent(e, { ...state, currentTime: e.time }, ctx)
  return state
}
const duration = GUIDED_SCENARIO[GUIDED_SCENARIO.length - 1].time

test('every legend entry is explained by at least one step', () => {
  const covered = new Set(GUIDED_STEPS.flatMap(s => s.covers))
  assert.deepEqual(LEGEND_ENTRY_IDS.filter(id => !covered.has(id)), [])
})

test('steps only cover real legend entries, and steps have an id, a title and a body', () => {
  const known = new Set<string>(LEGEND_ENTRY_IDS)
  for (const s of GUIDED_STEPS) {
    assert.ok(s.id && s.title.trim() && s.body.trim(), `step ${s.id} has text`)
    for (const c of s.covers) assert.ok(known.has(c), `${s.id} covers unknown entry ${c}`)
  }
  assert.equal(new Set(GUIDED_STEPS.map(s => s.id)).size, GUIDED_STEPS.length, 'unique step ids')
})

test('step times are non-decreasing and inside the scenario', () => {
  for (let i = 0; i < GUIDED_STEPS.length; i++) {
    assert.ok(GUIDED_STEPS[i].time >= 0 && GUIDED_STEPS[i].time <= duration, `${GUIDED_STEPS[i].id} inside [0, ${duration}]`)
    if (i > 0) assert.ok(GUIDED_STEPS[i].time >= GUIDED_STEPS[i - 1].time, `${GUIDED_STEPS[i].id} after ${GUIDED_STEPS[i - 1].id}`)
  }
})

test('agent targets exist at the time of their step', () => {
  for (const s of GUIDED_STEPS) {
    if (s.target.kind !== 'agent') continue
    const name = s.target.name
    assert.ok([...playUntil(s.time).agents.values()].some(a => a.name === name), `${s.id}: agent ${name} at t=${s.time}`)
  }
})

// What the simulation can prove is proven: a step never claims a state, runtime, discovery or context segment
// that the scenario has not produced yet at its time (CONTRIBUTING: never show an unproven state).
const STATE_OF = (id: LegendEntryId) => id.startsWith('state-') ? id.slice('state-'.length) : null
const CTX_FIELD: Partial<Record<LegendEntryId, string>> = {
  'ctx-system': 'systemPrompt', 'ctx-user': 'userMessages', 'ctx-tool-results': 'toolResults', 'ctx-reasoning': 'reasoning', 'ctx-subagent': 'subagentResults',
}
const hasContext = (field: string, time: number) => GUIDED_SCENARIO.some((e: SimulationEvent) =>
  e.type === 'context_update' && e.time <= time && Number((e.payload as { breakdown?: Record<string, number> }).breakdown?.[field] ?? 0) > 0)

test('covered states, runtimes, discoveries and context segments are on screen at the step time', () => {
  for (const s of GUIDED_STEPS) {
    const state = playUntil(s.time)
    const agents = [...state.agents.values()]
    for (const id of s.covers) {
      if (DESCRIBED_ONLY.includes(id)) continue
      const st = STATE_OF(id)
      if (st) assert.ok(agents.some(a => a.state === st), `${s.id}: an agent is ${st} at t=${s.time}`)
      if (id === 'rt-codex') assert.ok(agents.some(a => a.runtime === 'codex'), `${s.id}: a Codex agent`)
      if (id === 'rt-claude') assert.ok(agents.some(a => a.runtime !== 'codex'), `${s.id}: a Claude agent`)
      if (id.startsWith('disc-')) assert.ok(state.discoveries.some(d => d.type === id.slice('disc-'.length)), `${s.id}: a ${id} discovery`)
      const field = CTX_FIELD[id]
      if (field) assert.ok(hasContext(field, s.time), `${s.id}: context ${field} > 0`)
      if (id === 'team-row') assert.ok(state.teams.size > 0, `${s.id}: a team`)
    }
  }
})

test('DESCRIBED_ONLY entries are explained with words that say they are not on screen', () => {
  for (const id of DESCRIBED_ONLY) {
    const step = GUIDED_STEPS.find(s => s.covers.includes(id))
    assert.ok(step, `${id} is covered`)
    assert.match(step!.body, /not (shown|part of)|never shown|does not appear|only (appears|when)/i, `${step!.id} says ${id} is not in this demo`)
  }
})
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `node --import tsx --test scripts/guided-steps.test.ts`
Expected: FAIL (module `guided-steps` introuvable).

- [ ] **Step 3: Écrire `web/lib/guided-steps.ts`**

Les instants viennent de la table de la Task 2. Écrire les 14 étapes ci-dessous ; **si le test « on screen at the step time » échoue pour une étape, déplacer `time` à un instant de la même scène, jamais assouplir le test**.

```ts
import type { LegendEntryId } from './legend-entries'

export type TourTarget =
  | { kind: 'dom'; id: string }
  | { kind: 'agent'; name: string }
  | { kind: 'none' }

export interface GuidedStep {
  id: string
  /** Scenario time to seek to (web/lib/guided-scenario.ts) */
  time: number
  target: TourTarget
  /** Opens the graph legend while this step is shown (without touching the saved preference) */
  opensLegend?: boolean
  title: string
  body: string
  /** Legend entries this step explains (every entry must be covered, scripts/guided-steps.test.ts) */
  covers: readonly LegendEntryId[]
}

/** Entries no event can produce in a demo: explained in words only, and the text must say so. */
export const DESCRIBED_ONLY: readonly LegendEntryId[] = [
  'state-paused', 'edge-unverified', 'edge-badge-hidden', 'edge-badge-active', 'link-error', 'team-archived', 'session-halo',
]

export const GUIDED_STEPS: readonly GuidedStep[] = [
  { id: 'welcome', time: 1.5, target: { kind: 'agent', name: 'orchestrator' }, title: 'Meet your agent',
    body: 'Each large hexagon is a main agent. This one is thinking: it has read your request and is planning. The Claude spark logo tells you its runtime.',
    covers: ['shape-main', 'state-thinking', 'rt-claude'] },
  { id: 'tools', time: 3.2, target: { kind: 'agent', name: 'orchestrator' }, title: 'Tool calls',
    body: 'Every tool the agent runs appears as a rounded card on a thin amber line. The agent is calling a tool right now.',
    covers: ['state-tool_calling', 'shape-tool', 'edge-tool'] },
  { id: 'discoveries', time: 4.8, target: { kind: 'dom', id: 'legend-discoveries' }, opensLegend: true, title: 'Discoveries',
    body: 'When a tool brings back something worth remembering, a card with a colour bar appears: a file it read, or a pattern it searched.',
    covers: ['shape-discovery', 'disc-file', 'disc-pattern'] },
  { id: 'subagent', time: 6.6, target: { kind: 'agent', name: 'explore-agent' }, title: 'Sub-agents',
    body: 'The main agent delegated a task: a small hexagon joined by a thick line. The purple dot is the task travelling to the sub-agent.',
    covers: ['shape-sub', 'edge-parent', 'particle-dispatch'] },
  { id: 'more-discoveries', time: 8.8, target: { kind: 'agent', name: 'explore-agent' }, title: 'Code and findings',
    body: 'The sub-agent found a piece of code and a finding. Same cards, other colours: file, pattern, finding and code.',
    covers: ['disc-finding', 'disc-code'] },
  { id: 'return', time: 9.4, target: { kind: 'agent', name: 'explore-agent' }, title: 'Results come back',
    body: 'A green dot carries the result back to the parent. The sub-agent is done: its outline is now dashed.',
    covers: ['particle-return', 'shape-complete', 'state-complete'] },
  { id: 'context', time: 9.7, target: { kind: 'dom', id: 'legend-context' }, opensLegend: true, title: 'Context usage',
    body: 'The context window fills up with five kinds of content. Each colour is one of them: the system prompt, your messages, tool results, reasoning and sub-agent results.',
    covers: ['ctx-system', 'ctx-user', 'ctx-tool-results', 'ctx-reasoning', 'ctx-subagent'] },
  { id: 'permission', time: 12.5, target: { kind: 'agent', name: 'orchestrator' }, title: 'Waiting for you',
    body: 'The agent asked for a permission and is blocked until you answer it in your terminal. Nothing is guessed: this state only appears when the agent really asked.',
    covers: ['state-waiting_permission'] },
  { id: 'error', time: 23.5, target: { kind: 'agent', name: 'test-runner' }, title: 'When something fails',
    body: 'A tool call failed (a missing environment variable) and the agent turned red. Open the card to read the exact error.',
    covers: ['state-error', 'state-idle'] },
  { id: 'team', time: 30.4, target: { kind: 'agent', name: 'api-dev' }, opensLegend: true, title: 'Agent Teams',
    body: 'Teammates share a dashed halo and a coloured ring. An open arc means a teammate is working, a hollow ring that it is idle. The orchestrator carries a crown and a LEAD badge. The legend lists each team with its member count.',
    covers: ['team-ring', 'team-working', 'team-idle', 'team-halo', 'orchestrator', 'team-row'] },
  { id: 'messages', time: 30.6, target: { kind: 'agent', name: 'qa-dev' }, title: 'Messages between agents',
    body: 'A long-dashed purple line is a message in flight; a bubble shows the latest message. Click a link to read the conversation.',
    covers: ['link-flight', 'link-bubble'] },
  { id: 'messages-after', time: 34.6, target: { kind: 'agent', name: 'api-dev' }, title: 'Quiet links and finished teammates',
    body: 'Once delivered a message line turns solid green, then fades to a thin quiet line with a count badge. A filled dot means the teammate is done.',
    covers: ['link-recent', 'link-quiet', 'team-done'] },
  { id: 'runtimes', time: 39.0, target: { kind: 'agent', name: 'codex' }, title: 'Two runtimes',
    body: 'The knot logo is Codex; the spark is Claude. Both are drawn the same way, so you can compare them side by side.',
    covers: ['rt-codex'] },
  { id: 'not-in-demo', time: 44.5, target: { kind: 'dom', id: 'legend-edges' }, opensLegend: true, title: 'Seen only in a real session',
    body: 'Some legend entries are not shown in this demo because they depend on live conditions or on your clicks: a paused agent, an unverified parent link (dashed), a "+N" badge on a folded branch, a red error message link, an archived agent and the dotted session halo. Keep the legend open to recognise them later.',
    covers: ['state-paused', 'edge-unverified', 'edge-badge-hidden', 'edge-badge-active', 'link-error', 'team-archived', 'session-halo'] },
] as const
```

- [ ] **Step 4: Lancer le test, corriger les instants**

Run: `node --import tsx --test scripts/guided-steps.test.ts`
Expected: PASS. Si « an agent is X at t=… » échoue, déplacer le `time` de l'étape (Step 3 le précise). L'ordre du tableau doit rester croissant en `time` : réordonner les objets `subagent`/`context` si besoin.

- [ ] **Step 5: Commit**

```bash
git add web/lib/guided-steps.ts scripts/guided-steps.test.ts
git commit -m "feat(demo): étapes de la démo guidée et test de couverture de la légende

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Navigation, hook et carte

**Files:**
- Create: `web/lib/guided-tour-nav.ts`, `web/hooks/use-guided-tour.ts`, `web/components/agent-visualizer/guided-tour-context.tsx`, `web/components/agent-visualizer/guided-tour-card.tsx`
- Test: `scripts/guided-tour-nav.test.ts`, `web/tests-a11y/guided-tour-card.test.tsx`

**Interfaces:**
- Produces (`guided-tour-nav.ts`) :

```ts
export interface TourState { active: boolean; index: number }
export const INACTIVE_TOUR: TourState
export function startTour(): TourState                              // { active: true, index: 0 }
export function goToStep(state: TourState, index: number, total: number): TourState  // clamps into [0, total - 1]
export function nextStep(state: TourState, total: number): TourState
export function prevStep(state: TourState, total: number): TourState
export function exitTour(): TourState                               // INACTIVE_TOUR
```

- Produces (`use-guided-tour.ts`) :

```ts
export function useGuidedTour(opts: {
  steps: readonly GuidedStep[]
  seek: (time: number) => void   // pauses and seeks (index.tsx handleSeek)
  play: () => void
}): { active: boolean; index: number; step: GuidedStep | null; start(): void; next(): void; prev(): void; goTo(i: number): void; exit(): void }
```

- Produces (`guided-tour-context.tsx`) :

```ts
export interface TourBridge {
  legendOpen: boolean
  canvasToScreenRef: MutableRefObject<((worldX: number, worldY: number) => { x: number; y: number }) | null>
}
export const TourBridgeContext: React.Context<TourBridge>   // default: { legendOpen: false, canvasToScreenRef: { current: null } }
export function useTourBridge(): TourBridge
```

- Produces (`guided-tour-card.tsx`) : `GuidedTourCard({ steps, index, onNext, onPrev, onGoTo, onExit })`.

- [ ] **Step 1: Écrire le test de navigation (échoue)**

`scripts/guided-tour-nav.test.ts` :

```ts
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { startTour, nextStep, prevStep, goToStep, exitTour, INACTIVE_TOUR } from '../web/lib/guided-tour-nav'

test('start opens on the first step; exit closes', () => {
  assert.deepEqual(startTour(), { active: true, index: 0 })
  assert.deepEqual(exitTour(), INACTIVE_TOUR)
})

test('next and prev move by one and stop at the bounds without looping', () => {
  let s = startTour()
  s = prevStep(s, 3); assert.equal(s.index, 0)
  s = nextStep(s, 3); s = nextStep(s, 3); assert.equal(s.index, 2)
  s = nextStep(s, 3); assert.equal(s.index, 2)
})

test('goTo clamps out-of-range indexes', () => {
  assert.equal(goToStep(startTour(), 99, 5).index, 4)
  assert.equal(goToStep(startTour(), -3, 5).index, 0)
})

test('navigating an inactive tour or an empty list does nothing', () => {
  assert.deepEqual(nextStep(INACTIVE_TOUR, 3), INACTIVE_TOUR)
  assert.deepEqual(goToStep(startTour(), 2, 0), startTour())
})
```

- [ ] **Step 2: Lancer, vérifier l'échec** — `node --import tsx --test scripts/guided-tour-nav.test.ts` → FAIL (module introuvable).

- [ ] **Step 3: Écrire `web/lib/guided-tour-nav.ts`**

```ts
export interface TourState { active: boolean; index: number }
export const INACTIVE_TOUR: TourState = { active: false, index: 0 }

export const startTour = (): TourState => ({ active: true, index: 0 })
export const exitTour = (): TourState => INACTIVE_TOUR

export function goToStep(state: TourState, index: number, total: number): TourState {
  if (!state.active || total <= 0) return state
  return { active: true, index: Math.min(Math.max(index, 0), total - 1) }
}
export const nextStep = (state: TourState, total: number): TourState => goToStep(state, state.index + 1, total)
export const prevStep = (state: TourState, total: number): TourState => goToStep(state, state.index - 1, total)
```

- [ ] **Step 4: Lancer** — Expected: PASS (4 tests).

- [ ] **Step 5: Écrire le hook `web/hooks/use-guided-tour.ts`**

```ts
import { useCallback, useEffect, useState } from 'react'
import type { GuidedStep } from '@/lib/guided-steps'
import { INACTIVE_TOUR, startTour, nextStep, prevStep, goToStep, exitTour, type TourState } from '@/lib/guided-tour-nav'

interface Options {
  steps: readonly GuidedStep[]
  /** Pauses the scenario and seeks to a time (the seek of the playback bar) */
  seek: (time: number) => void
  play: () => void
}

export function useGuidedTour({ steps, seek, play }: Options) {
  const [state, setState] = useState<TourState>(INACTIVE_TOUR)
  const step = state.active ? steps[state.index] ?? null : null

  // Each step change: pause and replay the scenario up to the step time
  useEffect(() => {
    if (step) seek(step.time)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seek is a fresh closure each render; only the step must re-trigger
  }, [step])

  const start = useCallback(() => setState(startTour()), [])
  const next = useCallback(() => setState(s => nextStep(s, steps.length)), [steps.length])
  const prev = useCallback(() => setState(s => prevStep(s, steps.length)), [steps.length])
  const goTo = useCallback((i: number) => setState(s => goToStep(s, i, steps.length)), [steps.length])
  const exit = useCallback(() => { setState(exitTour()); play() }, [play])

  return { active: state.active, index: state.index, step, start, next, prev, goTo, exit }
}
```

- [ ] **Step 6: Écrire le contexte `guided-tour-context.tsx`**

```tsx
'use client'

import { createContext, useContext, type MutableRefObject } from 'react'

export interface TourBridge {
  /** The guided tour wants the graph legend open (the saved preference is left alone) */
  legendOpen: boolean
  /** Filled by the canvas: world point to client coordinates (the tour ring follows agents) */
  canvasToScreenRef: MutableRefObject<((worldX: number, worldY: number) => { x: number; y: number }) | null>
}

export const TourBridgeContext = createContext<TourBridge>({ legendOpen: false, canvasToScreenRef: { current: null } })
export const useTourBridge = () => useContext(TourBridgeContext)
```

- [ ] **Step 7: Écrire le test de la carte (échoue)**

`web/tests-a11y/guided-tour-card.test.tsx` :

```tsx
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import { GuidedTourCard } from '@/components/agent-visualizer/guided-tour-card'
import { GUIDED_STEPS } from '@/lib/guided-steps'

afterEach(() => { cleanup(); document.body.replaceChildren() })
const frames = () => act(async () => { await new Promise(r => setTimeout(r, 80)) })

function setup(index = 1) {
  const calls: string[] = []
  const view = render(
    <GuidedTourCard steps={GUIDED_STEPS} index={index} onNext={() => calls.push('next')} onPrev={() => calls.push('prev')}
      onGoTo={i => calls.push(`goto:${i}`)} onExit={() => calls.push('exit')} />,
  )
  return { view, calls }
}

test('the card is a labelled dialog that shows the title, the body and the position', () => {
  const { view } = setup(1)
  const dialog = view.getByRole('dialog')
  assert.ok(dialog.getAttribute('aria-labelledby'))
  assert.ok(view.getByText(GUIDED_STEPS[1].title))
  assert.ok(view.getByText(GUIDED_STEPS[1].body))
  assert.ok(view.getByText(`Step 2 of ${GUIDED_STEPS.length}`))
})

test('Previous is disabled on the first step and Next on the last', () => {
  assert.equal((setup(0).view.getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled, true)
  cleanup()
  assert.equal((setup(GUIDED_STEPS.length - 1).view.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled, true)
})

test('buttons call back; the step list jumps to a step', () => {
  const { view, calls } = setup(1)
  fireEvent.click(view.getByRole('button', { name: 'Next' }))
  fireEvent.click(view.getByRole('button', { name: 'Previous' }))
  fireEvent.click(view.getByRole('button', { name: 'Exit tour' }))
  fireEvent.change(view.getByRole('combobox', { name: 'Go to step' }), { target: { value: '3' } })
  assert.deepEqual(calls, ['next', 'prev', 'exit', 'goto:3'])
})

test('arrow keys and Escape work inside the card only', async () => {
  const { view, calls } = setup(1)
  await frames()
  const dialog = view.getByRole('dialog')
  fireEvent.keyDown(dialog, { key: 'ArrowRight' })
  fireEvent.keyDown(dialog, { key: 'ArrowLeft' })
  fireEvent.keyDown(dialog, { key: 'Escape' })
  assert.deepEqual(calls, ['next', 'prev', 'exit'])
  calls.length = 0
  fireEvent.keyDown(document.body, { key: 'ArrowRight' })
  assert.deepEqual(calls, [], 'the graph keyboard navigation keeps its arrow keys')
})

test('the step text is announced politely', () => {
  const { view } = setup(2)
  assert.equal(view.container.querySelector('[aria-live="polite"]')?.textContent?.includes(GUIDED_STEPS[2].title), true)
})
```

- [ ] **Step 8: Lancer, vérifier l'échec** — `pnpm --dir web exec node --import tsx --import ./tests-a11y/setup.ts --test tests-a11y/guided-tour-card.test.tsx` → FAIL (composant introuvable).

- [ ] **Step 9: Écrire `guided-tour-card.tsx`**

```tsx
'use client'

import { useRef, type KeyboardEvent } from 'react'
import { COLORS } from '@/lib/colors'
import { Z } from '@/lib/agent-types'
import { CONTROL_BAR_BOTTOM, DOCK_GAP } from '@/lib/panel-layout'
import { useFocusReturn } from '@/hooks/use-focus-return'
import type { GuidedStep } from '@/lib/guided-steps'

interface GuidedTourCardProps {
  steps: readonly GuidedStep[]
  index: number
  onNext: () => void
  onPrev: () => void
  onGoTo: (index: number) => void
  onExit: () => void
}

const BUTTON_CLASS =
  'inline-flex min-h-6 min-w-6 items-center justify-center rounded-md px-3 py-1 text-xs font-mono disabled:opacity-50 '
  + 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--lens-focus-ring)]'
const BUTTON_STYLE = { background: COLORS.panelBg, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }

/**
 * The guided tour card: what the highlighted element is. A dialog without a focus trap, so the page stays
 * explorable (zoom, click an agent) while the tour is open. Arrow keys and Escape work only while the focus is
 * inside the card, so they never take the arrow keys away from the graph keyboard navigation.
 */
export function GuidedTourCard({ steps, index, onNext, onPrev, onGoTo, onExit }: GuidedTourCardProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  useFocusReturn(true, rootRef)
  const step = steps[index]
  if (!step) return null

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); onNext() }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); onPrev() }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onExit() }
  }

  return (
    <div ref={rootRef} style={{ display: 'contents' }}>
      <section
        role="dialog"
        aria-labelledby="guided-tour-title"
        aria-describedby="guided-tour-body"
        onKeyDown={onKeyDown}
        className="pointer-events-auto absolute left-1/2 w-[min(28rem,calc(100vw-24px))] -translate-x-1/2 rounded-md p-4 font-mono text-xs"
        style={{
          bottom: CONTROL_BAR_BOTTOM + DOCK_GAP + 64,
          zIndex: Z.detailCard,
          background: COLORS.panelBg,
          border: `1px solid ${COLORS.glassBorder}`,
          color: COLORS.textPrimary,
        }}
      >
        <div className="mb-1 flex items-center justify-between gap-2">
          <span style={{ color: COLORS.textMuted }}>{`Step ${index + 1} of ${steps.length}`}</span>
          <button type="button" onClick={onExit} className={BUTTON_CLASS} style={BUTTON_STYLE}>Exit tour</button>
        </div>
        <div aria-live="polite">
          <h2 id="guided-tour-title" className="mb-1 text-sm font-semibold">{step.title}</h2>
          <p id="guided-tour-body" className="leading-relaxed" style={{ color: COLORS.textPrimary }}>{step.body}</p>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={onPrev} disabled={index === 0} className={BUTTON_CLASS} style={BUTTON_STYLE}>Previous</button>
          <button type="button" onClick={onNext} disabled={index === steps.length - 1} className={BUTTON_CLASS} style={BUTTON_STYLE}>Next</button>
          <select
            aria-label="Go to step"
            value={index}
            onChange={e => onGoTo(Number(e.target.value))}
            className="ml-auto max-w-[12rem] bg-transparent font-mono text-xs"
            style={{ color: COLORS.textPrimary, border: `1px solid ${COLORS.controlBorder}`, borderRadius: 6, minHeight: 24 }}
          >
            {steps.map((s, i) => (
              <option key={s.id} value={i} style={{ color: COLORS.textPrimary, background: 'var(--lens-surface)' }}>{`${i + 1}. ${s.title}`}</option>
            ))}
          </select>
        </div>
      </section>
    </div>
  )
}
```

`CONTROL_BAR_BOTTOM` et `DOCK_GAP` viennent de `@/lib/panel-layout` (déjà utilisés par `canvas-controls.tsx`).

- [ ] **Step 10: Lancer les tests, les types, l'axe**

Run: `pnpm --dir web exec node --import tsx --import ./tests-a11y/setup.ts --test tests-a11y/guided-tour-card.test.tsx && pnpm --dir web exec tsc --noEmit && pnpm --dir web run lint:a11y`
Expected: PASS ; si `lint:a11y` signale `select`/`dialog`, corriger le composant (étiquette, rôle), pas la baseline.

- [ ] **Step 11: Commit**

```bash
git add web/lib/guided-tour-nav.ts web/hooks/use-guided-tour.ts web/components/agent-visualizer/guided-tour-context.tsx web/components/agent-visualizer/guided-tour-card.tsx scripts/guided-tour-nav.test.ts web/tests-a11y/guided-tour-card.test.tsx
git commit -m "feat(demo): navigation, hook et carte de la visite guidée

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Surbrillance, câblage et points d'entrée

**Files:**
- Create: `web/components/agent-visualizer/tour-highlight.tsx`
- Modify: `web/components/agent-visualizer/index.tsx` (extraction de `handleSeek` ; montage), `web/components/agent-visualizer/canvas.tsx` (publier `canvasToScreen`), `web/components/agent-visualizer/graph-legend.tsx` (ouverture forcée, bouton), `web/lib/mock-scenario.ts` (déjà exporte `IS_GUIDED_DEMO`)
- Test: `web/tests-a11y/tour-highlight.test.tsx`, `web/tests-a11y/e2e/guided.e2e.ts`

**Interfaces:**
- Consumes: `useGuidedTour`, `GuidedTourCard`, `TourBridgeContext`, `GUIDED_STEPS`, `IS_GUIDED_DEMO`.
- Produces: `ringRect(target, agents, canvasToScreen, query)` (pure, exportée pour le test) et `TourHighlight({ target })`.

- [ ] **Step 1: Écrire le test du calcul de l'anneau (échoue)**

`web/tests-a11y/tour-highlight.test.tsx` :

```tsx
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'
import { ringRect, TourHighlight, AGENT_RING_RADIUS } from '@/components/agent-visualizer/tour-highlight'
import { TourBridgeContext } from '@/components/agent-visualizer/guided-tour-context'

afterEach(() => { cleanup(); document.body.replaceChildren() })

const toScreen = (x: number, y: number) => ({ x: x * 2 + 10, y: y * 2 + 20 })

test('an agent target is ringed around its screen position', () => {
  const agents = new Map([['k', { name: 'api-dev', x: 5, y: 7 }]])
  const r = ringRect({ kind: 'agent', name: 'api-dev' }, agents, toScreen, () => null)
  assert.deepEqual(r, { left: 20 - AGENT_RING_RADIUS, top: 34 - AGENT_RING_RADIUS, width: AGENT_RING_RADIUS * 2, height: AGENT_RING_RADIUS * 2 })
})

test('a missing agent, a missing element or no conversion gives no ring', () => {
  assert.equal(ringRect({ kind: 'agent', name: 'ghost' }, new Map(), toScreen, () => null), null)
  assert.equal(ringRect({ kind: 'agent', name: 'a' }, new Map([['k', { name: 'a', x: 0, y: 0 }]]), null, () => null), null)
  assert.equal(ringRect({ kind: 'dom', id: 'nope' }, new Map(), toScreen, () => null), null)
  assert.equal(ringRect({ kind: 'none' }, new Map(), toScreen, () => null), null)
})

test('a DOM target is ringed around its bounding box', () => {
  const el = { getBoundingClientRect: () => ({ left: 3, top: 4, width: 50, height: 20 }) } as unknown as Element
  assert.deepEqual(ringRect({ kind: 'dom', id: 'x' }, new Map(), toScreen, () => el), { left: 3, top: 4, width: 50, height: 20 })
})

test('the ring is decorative: hidden from assistive technology and not clickable', () => {
  const el = document.createElement('div'); el.setAttribute('data-tour-target', 'box'); document.body.appendChild(el)
  el.getBoundingClientRect = () => ({ left: 1, top: 1, width: 10, height: 10, right: 11, bottom: 11, x: 1, y: 1, toJSON() {} }) as DOMRect
  const view = render(
    <TourBridgeContext.Provider value={{ legendOpen: false, canvasToScreenRef: { current: null } }}>
      <TourHighlight target={{ kind: 'dom', id: 'box' }} getAgents={() => new Map()} />
    </TourBridgeContext.Provider>,
  )
  const ring = view.container.querySelector('[data-tour-ring]')
  assert.ok(ring)
  assert.equal(ring!.getAttribute('aria-hidden'), 'true')
  assert.match(ring!.getAttribute('class') ?? '', /pointer-events-none/)
})
```

- [ ] **Step 2: Lancer, vérifier l'échec** — module `tour-highlight` introuvable.

- [ ] **Step 3: Écrire `tour-highlight.tsx`**

```tsx
'use client'

import { useEffect, useState } from 'react'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import type { TourTarget } from '@/lib/guided-steps'
import { useTourBridge } from './guided-tour-context'

export const AGENT_RING_RADIUS = 48

export interface RingRect { left: number; top: number; width: number; height: number }
type NamedPoint = { name: string; x: number; y: number }
type ToScreen = ((worldX: number, worldY: number) => { x: number; y: number }) | null

/** Where the ring goes for a step target, or null when the target is not on screen (no ring, never an error). */
export function ringRect(
  target: TourTarget,
  agents: ReadonlyMap<string, NamedPoint>,
  toScreen: ToScreen,
  query: (id: string) => Element | null,
): RingRect | null {
  if (target.kind === 'dom') {
    const r = query(target.id)?.getBoundingClientRect()
    return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null
  }
  if (target.kind === 'agent' && toScreen) {
    const agent = [...agents.values()].find(a => a.name === target.name)
    if (!agent) return null
    const p = toScreen(agent.x, agent.y)
    return { left: p.x - AGENT_RING_RADIUS, top: p.y - AGENT_RING_RADIUS, width: AGENT_RING_RADIUS * 2, height: AGENT_RING_RADIUS * 2 }
  }
  return null
}

const queryTarget = (id: string) => document.querySelector(`[data-tour-target="${id}"]`)

/** Ring around the element a tour step is about. Follows moving agents on every frame; never animated itself. */
export function TourHighlight({ target, getAgents }: { target: TourTarget; getAgents: () => ReadonlyMap<string, NamedPoint> }) {
  const { canvasToScreenRef } = useTourBridge()
  const [rect, setRect] = useState<RingRect | null>(null)

  useEffect(() => {
    let raf = 0
    const tick = () => {
      const next = ringRect(target, getAgents(), canvasToScreenRef.current, queryTarget)
      setRect(prev => (prev && next && prev.left === next.left && prev.top === next.top && prev.width === next.width && prev.height === next.height) ? prev : next)
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [target, getAgents, canvasToScreenRef])

  if (!rect) return null
  return (
    <div
      data-tour-ring
      aria-hidden="true"
      className="pointer-events-none fixed rounded-lg"
      style={{
        left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8,
        zIndex: Z.detailCard - 1,
        border: `2px solid ${COLORS.textPrimary}`,
        boxShadow: `0 0 0 3px ${COLORS.panelBg}`,
      }}
    />
  )
}
```

- [ ] **Step 4: Lancer le test** — `pnpm --dir web exec node --import tsx --import ./tests-a11y/setup.ts --test tests-a11y/tour-highlight.test.tsx` → PASS.

- [ ] **Step 5: Publier `canvasToScreen` depuis `canvas.tsx`**

Dans `canvas.tsx`, après la ligne 81 (destructuration de `useCanvasCamera`) :

```tsx
const { canvasToScreenRef: tourCanvasToScreenRef } = useTourBridge()
tourCanvasToScreenRef.current = canvasToScreen
```

avec `import { useTourBridge } from './guided-tour-context'`. (`canvasToScreen` change d'identité seulement avec `mainCanvasRef`, stable.)

- [ ] **Step 6: Ouverture forcée de la légende dans `graph-legend.tsx`**

```tsx
import { useTourBridge } from './guided-tour-context'
// dans GraphLegend, après useState :
const { legendOpen: tourWantsOpen } = useTourBridge()
const shown = open || tourWantsOpen
```

Remplacer `open` par `shown` dans le rendu du panneau (`{open && (` → `{shown && (`), dans `aria-expanded`, `aria-controls` et le glyphe `▾`/`▸`. `toggle` reste inchangé et n'écrit `LEGEND_OPEN_KEY` que sur un clic de l'utilisateur : la visite ne touche jamais à la préférence. Ajouter `data-tour-target="legend-button"` au bouton « Legend ».

- [ ] **Step 7: Extraire `handleSeek` et monter la visite dans `index.tsx`**

1. Extraire le corps de `onSeek` (lignes ~833-841) en une fonction avant le `return` :

```tsx
const handleSeek = (time: number) => {
  seekingRef.current = true
  pause()
  seekToTime(time)
  setZoomToFitTrigger(n => n + 1)
  if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current)
  resumeTimerRef.current = setTimeout(() => { resumeTimerRef.current = null; seekingRef.current = false }, TIMING.seekCompleteDelayMs)
}
```

   et remplacer le prop par `onSeek={handleSeek}`. Aucun autre changement de comportement.

2. Importer et créer le hook :

```tsx
import { IS_GUIDED_DEMO, MOCK_DURATION } from "@/lib/mock-scenario"
import { GUIDED_STEPS } from "@/lib/guided-steps"
import { useGuidedTour } from "@/hooks/use-guided-tour"
import { GuidedTourCard } from "./guided-tour-card"
import { TourHighlight } from "./tour-highlight"
import { TourBridgeContext } from "./guided-tour-context"

const tour = useGuidedTour({ steps: GUIDED_STEPS, seek: handleSeek, play })
const canvasToScreenRef = useRef<…>(null)   // même type que TourBridge['canvasToScreenRef']
const tourBridge = useMemo(() => ({ legendOpen: Boolean(tour.step?.opensLegend), canvasToScreenRef }), [tour.step])
const getTourAgents = useCallback(() => frameRef.current.agents, [frameRef])
```

   `frameRef` vient déjà de `useAgentSimulation` (à ajouter à la destructuration si absent). Démarrage automatique en démo guidée :

```tsx
useEffect(() => { if (IS_GUIDED_DEMO) tour.start() }, [])   // eslint-disable-line react-hooks/exhaustive-deps
```

3. Envelopper l'arbre existant dans `<TourBridgeContext.Provider value={tourBridge}>` (à l'intérieur de `PanelRegistryContext.Provider`), et monter juste avant `<ToastRegion>` :

```tsx
{tour.active && tour.step && (
  <>
    <TourHighlight target={tour.step.target} getAgents={getTourAgents} />
    <GuidedTourCard steps={GUIDED_STEPS} index={tour.index} onNext={tour.next} onPrev={tour.prev} onGoTo={tour.goTo} onExit={tour.exit} />
  </>
)}
```

4. Bouton d'entrée, uniquement en démo (`bridge.useMockData`) et hors visite : dans `canvas-controls.tsx` n'est pas atteignable sans props ; le placer dans `index.tsx`, à côté du `ControlBar`, en bas à gauche, positionné comme le bouton « Legend » mais décalé à droite :

```tsx
{bridge.useMockData && !tour.active && (
  <button type="button" onClick={tour.start}
    className="pointer-events-auto absolute left-24 inline-flex min-h-6 min-w-6 items-center rounded-md px-2 py-1 font-mono text-[11px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--lens-focus-ring)]"
    style={{ bottom: CONTROL_BAR_BOTTOM + controlBarH + DOCK_GAP, zIndex: Z.info, background: COLORS.panelBg, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}>
    Guided tour
  </button>
)}
```

   (`controlBarH` : `useDockSnapshot().env.controlBarH`, comme dans `canvas-controls.tsx`.) Ajouter aux racines de `ControlBar`, `TopBar` et `TimelinePanel` un `data-tour-target="control-bar"` / `"top-bar"` / `"timeline-panel"` seulement si une étape y renvoie (aucune dans cette version : ne pas les ajouter, YAGNI).

   Le bouton « Guided tour » démarre à l'étape 1 sur le scénario courant : `handleSeek` rejoue `MOCK_SCENARIO`. Hors `?scenario=guided`, le scénario courant est le tour ou le classique, dont les instants ne correspondent pas aux étapes : **n'afficher ce bouton que si `IS_GUIDED_DEMO`** (condition `IS_GUIDED_DEMO && !tour.active`) et documenter `?scenario=guided` pour y accéder depuis une autre démo.

- [ ] **Step 8: Typecheck, lint, tests**

Run: `pnpm --dir web exec tsc --noEmit && pnpm --dir web run lint:a11y && pnpm test && pnpm run test:a11y`
Expected: PASS. Un échec d'`axe` sur la carte ou le bouton se corrige dans le composant.

- [ ] **Step 9: Écrire l'e2e (échoue sans le câblage, vert après)**

`web/tests-a11y/e2e/guided.e2e.ts`, sur le modèle d'`demo.e2e.ts` (mêmes `before`/`after`, `startDemoServer`) :

```ts
// The guided tour end to end, in a real browser: walks every step and checks that the card and the ring show.
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'
import { startDemoServer, type DemoServer } from './demo-server'
import { GUIDED_STEPS } from '../../lib/guided-steps'

let browser: Browser
let server: DemoServer

before(async () => { server = await startDemoServer(); browser = await chromium.launch() }, { timeout: 240_000 })
after(async () => { await browser?.close(); await server?.stop() })

test('the guided tour walks every step with Next and shows the card each time', async () => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await page.goto(`${server.url}/?scenario=guided`)
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  for (let i = 0; i < GUIDED_STEPS.length; i++) {
    await page.getByText(`Step ${i + 1} of ${GUIDED_STEPS.length}`).waitFor()
    assert.ok(await dialog.getByRole('heading', { name: GUIDED_STEPS[i].title }).isVisible(), `step ${i + 1}: ${GUIDED_STEPS[i].title}`)
    if (i < GUIDED_STEPS.length - 1) await page.getByRole('button', { name: 'Next' }).click()
  }
  assert.equal(await page.getByRole('button', { name: 'Next' }).isDisabled(), true)
  await page.getByRole('button', { name: 'Previous' }).click()
  await page.getByText(`Step ${GUIDED_STEPS.length - 1} of ${GUIDED_STEPS.length}`).waitFor()
})

test('legend steps open the legend and leave the saved preference alone', async () => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await page.goto(`${server.url}/?scenario=guided`)
  await page.getByRole('dialog').waitFor()
  const discoveries = GUIDED_STEPS.findIndex(s => s.opensLegend)
  await page.getByRole('combobox', { name: 'Go to step' }).selectOption(String(discoveries))
  await page.getByRole('region', { name: 'Graph legend' }).waitFor()
  assert.equal(await page.evaluate(() => window.localStorage.getItem('agent-viz-legend-open')), null)
})

test('Exit tour closes the card, keeps the app and has no accessibility violation', async () => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await page.goto(`${server.url}/?scenario=guided`)
  await page.getByRole('dialog').waitFor()
  const results = await new AxeBuilder({ page }).include('[role="dialog"]').analyze()
  assert.deepEqual(results.violations.map(v => v.id), [])
  await page.getByRole('button', { name: 'Exit tour' }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  assert.ok(await page.getByRole('button', { name: 'Guided tour' }).isVisible())
})
```

   L'e2e charge le serveur de démo avec `NEXT_PUBLIC_DEMO=1` ; le paramètre `?scenario=guided` suffit (priorité sur `NEXT_PUBLIC_DEMO_SCENARIO`).

- [ ] **Step 10: Lancer l'e2e**

Run: `pnpm --dir web run test:e2e -- --test-name-pattern guided` (si le filtre n'est pas accepté : `cd web && node --import tsx --test --test-concurrency=1 tests-a11y/e2e/guided.e2e.ts`)
Expected: PASS (3 tests). Prérequis : `pnpm --dir web exec playwright install chromium`.

- [ ] **Step 11: Vérification manuelle**

Run: `pnpm run dev:demo:guided`, ouvrir http://localhost:3000, fenêtre 1280×800. Parcourir les 14 étapes : l'anneau entoure bien chaque cible, la légende s'ouvre sur les étapes concernées, Précédent revient bien en arrière, `Exit tour` relance la lecture, essayer 2 thèmes sombres. Noter tout décalage d'anneau ; corriger `AGENT_RING_RADIUS` ou l'instant de l'étape.

- [ ] **Step 12: Commit**

```bash
git add web/components/agent-visualizer web/tests-a11y/tour-highlight.test.tsx web/tests-a11y/e2e/guided.e2e.ts
git commit -m "feat(demo): visite guidée (carte, surbrillance, points d'entrée)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Documentation

**Files:**
- Modify: `docs/demo.md`, `docs/reading-the-ui.md`, `README.md`

- [ ] **Step 1: `docs/demo.md`** — ajouter à la fin une section `## Visite guidée` (en français comme le reste du fichier) : lancement (`pnpm run dev:demo:guided` ou `?scenario=guided`), les contrôles (Suivant, Précédent, liste des étapes, `←` `→` et `Échap` quand le focus est dans la carte, `Exit tour`), le tableau des 14 étapes (titre, entrée de légende expliquée) tiré de `web/lib/guided-steps.ts`, et la liste des entrées « vues seulement dans une session réelle » (`DESCRIBED_ONLY`).

- [ ] **Step 2: `docs/reading-the-ui.md`** — en tête de chaque section de légende, une phrase « Voir en action : `?scenario=guided` (étape *<titre>*) », avec le titre exact de l'étape correspondante.

- [ ] **Step 3: `README.md`** — à côté des lignes `dev:demo` / `dev:demo:classic`, ajouter `pnpm run dev:demo:guided` : « visite guidée pas à pas ».

- [ ] **Step 4: Vérification finale**

Run: `pnpm test && pnpm run test:a11y && pnpm --dir web exec tsc --noEmit && pnpm --dir web run lint:a11y && pnpm --filter agent-lens run lint && pnpm run lint:scripts`
Expected: tout PASS.

- [ ] **Step 5: Commit, push, PR**

```bash
git add docs README.md
git commit -m "docs(demo): visite guidée

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
git push -u origin worktree-guided-demo-spec
gh pr create --repo jobailla/agent-lens --base develop --draft --title "feat(demo): visite guidée pas à pas" --body "Spec : docs/superpowers/specs/2026-10-09-guided-demo-design.md · Plan : docs/superpowers/plans/2026-10-09-guided-demo.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Auto-relecture (spec → tâches)

- Scénario dédié `guided`, `?scenario=guided`, script : Task 2.
- Étapes en données, `covers`, test de couverture lié à la légende : Tasks 1 et 3.
- Contrôleur `pause()` puis `seek` (via `handleSeek`, qui garde le zoom-to-fit et le garde-fou de la barre de lecture) : Tasks 4 et 5.
- Carte `role="dialog"` sans piège de focus, `aria-live`, retour du focus, Esc : Task 4.
- Surbrillance DOM (`data-tour-target`) et agents (`canvasToScreen`) : Task 5.
- Légende ouverte sans toucher la préférence : Task 5, Step 6 + e2e.
- Bouton « Guided tour » : Task 5 (limité à `IS_GUIDED_DEMO`, voir ci-dessous).
- Tests unitaires, rendu a11y, e2e, vérifications CI : dans chaque tâche.
- Documentation : Task 6.

Écarts assumés par rapport à la spec (consignés dans la spec) : `paused` et six autres entrées sont « décrites seulement » ; flèches clavier limitées à la carte ; contexte `TourBridge` au lieu de props ; bouton « Guided tour » visible seulement en démo guidée, car les instants des étapes n'ont de sens que sur `GUIDED_SCENARIO`.
