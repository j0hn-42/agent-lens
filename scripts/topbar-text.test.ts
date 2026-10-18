/**
 * Top bar texts in the interface language (#500, #501): pure logic. English is the text the bar had (compared with the
 * legacy functions); French says the same thing with the same figures and the same qualification.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ALL_SESSIONS_ID, type ConnectionStatus } from '../web/lib/bridge-types'
import {
  attentionAriaLabel, attentionCounterText, attentionTooltip, connectionText,
  moreText, selectionLabelText, unobservedSessionsText,
} from '../web/lib/top-bar-text'
import { connectionDisplay, topBarContextText, viewCountsText } from '../web/lib/chrome-utils'
import { selectionLabel } from '../web/lib/session-tree'
import { parseReconnectDetail, reconnectDetail } from '../web/lib/reconnect'
import { parseRelayScopeState, scopeNotices, scopeOptions, scopeSummary, type RelayScopeState } from '../web/lib/relay-scope'
import { TOP_BAR_LABELS, SESSIONS_LIST_NAME, PANEL_NAMES, PANEL_SUMMARIES } from '../web/lib/ui-glossary'
import { MESSAGES } from '../web/lib/messages'
import { SESSION_NOT_OBSERVED_HELP } from '../web/lib/session-model'
import type { UsageTotal } from '../web/lib/usage'

// ---- Attention counter (#501)

test('the attention counter is spelled out, never "1 waiting" alone', () => {
  assert.equal(attentionCounterText('en', 1, 0), '1 agent waiting')
  assert.equal(attentionCounterText('en', 2, 1), '2 agents waiting / 1 agent in error')
  assert.equal(attentionCounterText('en', 0, 3), '3 agents in error')
  assert.equal(attentionCounterText('fr', 1, 0), '1 agent en attente')
  assert.equal(attentionCounterText('fr', 2, 1), '2 agents en attente / 1 agent en erreur')
  assert.equal(attentionCounterText('fr', 0, 0), '')
  // The figures are the ones given
  assert.match(attentionCounterText('fr', 7, 12), /^7 agents .* \/ 12 agents /)
})

test('the accessible name starts with the visible text (WCAG 2.5.3) and says what a click does', () => {
  for (const locale of ['fr', 'en'] as const) {
    for (const [w, e] of [[1, 0], [0, 1], [2, 1]] as const) {
      const visible = attentionCounterText(locale, w, e)
      assert.ok(attentionAriaLabel(locale, w, e).startsWith(`${visible}. `), `${locale} ${w}/${e}`)
    }
  }
  assert.equal(attentionAriaLabel('en', 1, 0), '1 agent waiting. Go to the agent that needs you')
  assert.equal(attentionAriaLabel('en', 1, 1), '1 agent waiting / 1 agent in error. Go to the next agent that needs you')
  assert.equal(attentionAriaLabel('fr', 1, 0), '1 agent en attente. Aller à l’agent qui a besoin de vous')
})

test('the tooltip tells where a permission is answered outside VS Code only', () => {
  assert.equal(attentionTooltip('en', 1, 0, true), 'The agent that waits for a permission or failed. Click to select it.')
  assert.equal(attentionTooltip('en', 2, 0, false), 'Agents that wait for a permission or failed. Each click selects the next one, waiting agents first. A permission is answered where the agent runs (its terminal or editor), not on this page.')
  assert.match(attentionTooltip('fr', 1, 0, false), /^L’agent en attente .* Une autorisation se donne là où l’agent s’exécute/)
  assert.doesNotMatch(attentionTooltip('fr', 1, 0, true), /autorisation se donne/)
})

// ---- Connection

const STATUSES: ConnectionStatus[] = ['watching', 'connected', 'connecting', 'disconnected' as ConnectionStatus]

test('English connection texts are those of connectionDisplay, in every state', () => {
  for (const isDemo of [false, true]) {
    for (const status of STATUSES) {
      for (const detail of [null, reconnectDetail(2, 10_000)]) {
        const legacy = connectionDisplay(status, isDemo, detail)
        const now = connectionText('en', status, isDemo, detail)
        assert.deepEqual({ label: now.label, tone: now.tone, description: now.description }, legacy, `${status} demo=${isDemo} detail=${detail}`)
      }
    }
  }
})

test('French connection texts: same states and tones, a translated label and description', () => {
  const live = connectionText('fr', 'watching', false)
  assert.deepEqual([live.label, live.tone], ['EN DIRECT', 'ok'])
  assert.equal(connectionText('fr', 'connected', false).label, 'CONNECTÉ')
  assert.equal(connectionText('fr', 'connecting', false).tone, 'pending')
  const off = connectionText('fr', 'disconnected' as ConnectionStatus, false, reconnectDetail(2, 10_000))
  assert.equal(off.label, 'HORS LIGNE')
  assert.equal(off.tone, 'error')
  assert.deepEqual(off.detail, { text: 'reconnexion (tentative 2, nouvel essai dans 10 s)', lang: 'fr' })
  assert.equal(off.description, 'Relais hors ligne : reconnexion (tentative 2, nouvel essai dans 10 s)')
  // DEMO never masquerades as LIVE
  assert.equal(connectionText('fr', 'watching', true).label, 'DÉMO')
  assert.equal(connectionText('fr', 'watching', true).tone, 'demo')
})

test('an unknown detail keeps its own language instead of pretending to be French', () => {
  const off = connectionText('fr', 'disconnected' as ConnectionStatus, false, 'proxy refused')
  assert.deepEqual(off.detail, { text: 'proxy refused', lang: 'en' })
  // WCAG 3.1.2: a title attribute cannot declare its language, so the English detail stays out of the French tooltip
  assert.equal(off.description, 'Relais hors ligne')
  assert.equal(connectionText('en', 'disconnected' as ConnectionStatus, false, 'proxy refused').description, 'Relay offline: proxy refused')
})

test('parseReconnectDetail reads what reconnectDetail writes, and nothing else', () => {
  assert.deepEqual(parseReconnectDetail(reconnectDetail(3, 20_500)), { attempt: 3, seconds: 21 })
  assert.equal(parseReconnectDetail('reconnecting'), null)
  assert.equal(parseReconnectDetail('reconnecting (attempt x, retry in 3s)'), null)
})

// ---- Sessions button, finished sessions, More

test('the Sessions button label: All sessions, a team, a session', () => {
  assert.equal(selectionLabelText('en', ALL_SESSIONS_ID, []), selectionLabel(ALL_SESSIONS_ID, []))
  assert.equal(selectionLabelText('fr', ALL_SESSIONS_ID, []), 'Toutes les sessions')
  assert.equal(selectionLabelText('fr', null, []), 'Toutes les sessions')
  const sessions = [{ id: 's1', label: 'my-session' }]
  assert.equal(selectionLabelText('fr', 's1', sessions), 'my-session')
  assert.equal(selectionLabelText('en', 'team:alpha', []), selectionLabel('team:alpha', []))
  assert.match(selectionLabelText('fr', 'team:alpha', []), /alpha/)
})

test('the Sessions button texts exist in both languages', () => {
  assert.equal(MESSAGES.en['topbar.sessions.title'], `${SESSIONS_LIST_NAME} (L)`)
  assert.equal(unobservedSessionsText('en', 1), '1 session not observed')
  assert.equal(unobservedSessionsText('en', 3), '3 sessions not observed')
  assert.equal(unobservedSessionsText('fr', 1), '1 session non observée')
  assert.equal(unobservedSessionsText('fr', 3), '3 sessions non observées')
  assert.ok(SESSION_NOT_OBSERVED_HELP.length > 0)
})

test('More: English is TOP_BAR_LABELS, French starts its name with its visible text', () => {
  const en = moreText('en')
  assert.equal(en.more, TOP_BAR_LABELS.more)
  assert.equal(en.name, TOP_BAR_LABELS.moreName)
  assert.equal(en.help, TOP_BAR_LABELS.moreHelp)
  for (const n of [1, 2, 3]) {
    assert.equal(en.withFilters(n), TOP_BAR_LABELS.moreWithFilters(n))
    assert.deepEqual(en.nameParts(n), TOP_BAR_LABELS.moreNameWithFiltersParts(n))
  }
  const fr = moreText('fr')
  assert.equal(fr.more, 'Plus')
  assert.equal(fr.withFilters(1), 'Plus · 1 filtre')
  assert.equal(fr.withFilters(2), 'Plus · 2 filtres')
  for (const n of [1, 2]) assert.ok(fr.nameParts(n).before.startsWith(fr.withFilters(n)), 'label in name (2.5.3)')
})

test('the VS Code Context tooltip: English is the text it had', () => {
  assert.equal(MESSAGES.en['topbar.context.vscode'], `${PANEL_NAMES.context}: ${PANEL_SUMMARIES.context} come from the standalone relay, not available in VS Code`)
  assert.match(MESSAGES.fr['topbar.context.vscode'], /^Contexte : .*relais autonome.*VS Code$/)
})

// ---- Counts and totals read by screen readers

const counts = { active: 2, done: 3, stale: 4, idle: 1, error: 1 }

test('counts: English is unchanged, French carries the same figures', () => {
  assert.equal(viewCountsText(counts, null).spoken, '11 agents: 2 active - 4 last known state - 1 idle - 1 error - 3 done')
  assert.equal(viewCountsText(counts, null, 'en').spoken, viewCountsText(counts, null).spoken)
  assert.equal(viewCountsText(counts, null, 'en').drawn, viewCountsText(counts, null).drawn)
  assert.equal(viewCountsText(counts, null, 'fr').spoken, '11 agents : 2 actifs - 4 derniers états connus - 1 inactif - 1 en erreur - 3 terminés')
  assert.equal(viewCountsText(counts, null, 'fr').drawn, '11 agents : 2 actifs · 4 derniers connus · 1 inactif · 1 en erreur · 3 terminés')
  assert.equal(viewCountsText({ active: 0, done: 1, stale: 0, idle: 0, error: 0 }, null, 'fr').spoken, '1 agent : 0 actif - 1 terminé')
  assert.equal(viewCountsText({ ...counts, stale: 1 }, null, 'fr').spoken, '8 agents : 2 actifs - 1 dernier état connu - 1 inactif - 1 en erreur - 3 terminés')
  assert.equal(viewCountsText({ ...counts, stale: 1 }, null, 'fr').drawn, '8 agents : 2 actifs · 1 dernier connu · 1 inactif · 1 en erreur · 3 terminés')
  assert.equal(viewCountsText(counts, 5, 'fr').spoken, '5 sessions, 11 agents')
  assert.equal(viewCountsText(counts, 1, 'fr').spoken, '1 session, 11 agents')
})

const usage = (value: number | null, status: UsageTotal['status'], estimated = false): UsageTotal => ({ value, status, estimated })

test('totals: the qualification (at least / estimated / not reported) survives translation', () => {
  const en = (t: UsageTotal, c: UsageTotal) => topBarContextText(t, c, 'en')
  assert.deepEqual(en(usage(1200, 'available'), usage(0.5, 'available')), topBarContextText(usage(1200, 'available'), usage(0.5, 'available')))
  const fr = (t: UsageTotal, c: UsageTotal) => topBarContextText(t, c, 'fr')
  assert.deepEqual(fr(usage(null, 'unavailable'), usage(null, 'unavailable')), { tokens: 'jetons non communiqués', spoken: 'coût non communiqué' })
  assert.deepEqual(fr(usage(1200, 'available'), usage(null, 'unavailable')), { tokens: 'jetons dans le contexte : 1.2k', spoken: 'coût non communiqué' })
  assert.equal(fr(usage(1200, 'partial'), usage(2, 'partial')).tokens, 'jetons dans le contexte : au moins 1.2k')
  assert.equal(fr(usage(1200, 'partial', true), usage(2, 'partial', true)).tokens, 'jetons dans le contexte : au moins 1.2k estimé')
  assert.match(fr(usage(1200, 'available', true), usage(2, 'available', true)).spoken, /^estimation du coût du contexte \$2\.00 estimé$/)
  assert.match(fr(usage(1, 'partial'), usage(2, 'partial')).spoken, /^estimation du coût du contexte au moins \$2\.00$/)
})

// ---- Scope selector

const st = (over: Partial<RelayScopeState> = {}): RelayScopeState => ({
  ...parseRelayScopeState({
    relayVersion: '1', workspace: '/home/me/code/alpha', runtimes: ['claude'], hooksConfigured: true, disable1MContext: false,
    sessionCount: 2, allWorkspaces: false,
    skippedSessions: { watchLimit: 1, sizeLimit: 2, fileLimit: 1 },
    discovery: { projectDirsCapped: false, maxProjectDirs: 200, maxFilesPerDir: 500 },
  })!, ...over,
})

test('scope: English is unchanged, French says the same limits with the same figures', () => {
  const s = st()
  assert.equal(scopeSummary(s), 'Scanning this workspace only (alpha)')
  assert.equal(scopeSummary(s, 'fr'), 'Analyse de cet espace de travail seulement (alpha)')
  assert.equal(scopeSummary(st({ scope: 'all' }), 'fr'), null)
  assert.deepEqual(scopeNotices(s), [
    'At least 1 older transcript is not followed: more than 500 in one folder.',
    'At least 2 transcripts are too large to follow.',
    'At least 1 session is not followed: the watch limit is reached.',
  ])
  assert.deepEqual(scopeNotices(s, 'fr'), [
    'Au moins 1 transcription plus ancienne n’est pas suivie : plus de 500 dans un même dossier.',
    'Au moins 2 transcriptions sont trop volumineuses pour être suivies.',
    'Au moins 1 session n’est pas suivie : la limite de surveillance est atteinte.',
  ])
  const sessions = [{ projectId: 'p1', projectName: 'Alpha' }]
  assert.deepEqual(scopeOptions(sessions).map(o => o.label), ['This workspace', 'All workspaces', 'Project: Alpha'])
  assert.deepEqual(scopeOptions(sessions, 'fr').map(o => o.label), ['Cet espace de travail', 'Tous les espaces de travail', 'Projet : Alpha'])
  assert.deepEqual(scopeOptions(sessions, 'fr').map(o => o.value), scopeOptions(sessions).map(o => o.value))
})
