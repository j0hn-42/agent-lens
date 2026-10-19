// #502: the words of the agent card and the Sessions panel in French and English. The English output is the one of
// the helpers the card used before (nothing about a figure changes), the French one keeps every number and qualifier.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as T from '../web/lib/card-text'
import { boundedCount } from '../web/lib/event-loss'
import { healthText, findingText, sessionHealthText, type HealthVerdict, type LoopFinding } from '../web/lib/loop-detection'
import { filesReadText, durationText, resultText, delegationCountText, type DelegationDuration, type DelegationResult } from '../web/lib/delegation-report'
import { formatTokenUsage, type UsageTotal } from '../web/lib/usage'
import { getStateLabel, getActivityLabel } from '../web/lib/state-labels'
import { lastKnownStateText, silenceText } from '../web/hooks/simulation/freshness'
import { activeSummaryText } from '../web/lib/active-time'
import { GIT_STRIP_LABELS, groupHeading } from '../web/lib/ui-glossary'
import { formatTeamSummary, SESSION_STATUS_TEXT } from '../web/lib/chrome-utils'
import { formatAttention } from '../web/lib/attention'
import { formatRelativeTime } from '../web/lib/session-tree'
import { SESSION_NOT_OBSERVED_HELP, SESSION_INDEXED_HELP, SESSION_IMPORTED_HELP, SESSION_OFFLINE_HELP } from '../web/lib/session-model'
import { SESSION_LIST_LABELS, SESSIONS_LIST_NAME, CONTEXT_WINDOW_NAME, emptyMatch } from '../web/lib/ui-glossary'
import { MESSAGES } from '../web/lib/messages'

const USAGES: UsageTotal[] = [
  { value: null, status: 'unavailable', estimated: false },
  { value: 0, status: 'unavailable', estimated: true },
  { value: 1200, status: 'available', estimated: false },
  { value: 1200, status: 'available', estimated: true },
  { value: 128_500, status: 'partial', estimated: false },
  { value: 3_000_000, status: 'partial', estimated: true },
]

test('English: usage qualifiers are the ones of formatTokenUsage', () => {
  for (const u of USAGES) assert.equal(T.usageText('en', u), formatTokenUsage(u))
})

test('French: a qualified figure keeps its qualifier and its number', () => {
  assert.equal(T.usageText('fr', USAGES[0]), 'non communiqué')
  assert.equal(T.usageText('fr', USAGES[1]), 'non communiqué')
  assert.equal(T.usageText('fr', USAGES[2]), '1.2k')
  assert.equal(T.usageText('fr', USAGES[3]), '1.2k estimé')
  assert.equal(T.usageText('fr', USAGES[4]), 'au moins 128k')
  assert.equal(T.usageText('fr', USAGES[5]), 'au moins 3M estimé')
})

test('English: states, activities and last known state', () => {
  for (const s of ['idle', 'thinking', 'tool_calling', 'complete', 'error', 'paused', 'waiting_permission', 'some_new_state']) {
    assert.equal(T.stateText('en', s), getStateLabel(s))
    assert.equal(T.lastKnownStateText('en', s), lastKnownStateText(s))
  }
  for (const a of ['working', 'idle', 'done', 'x_y']) assert.equal(T.activityText('en', a), getActivityLabel(a))
  assert.equal(T.stateText('fr', 'some_new_state'), 'some new state', 'an unknown identifier is never invented')
})

test('English: counts that become a lower bound when events were lost', () => {
  for (const lost of [0, 1, 5]) for (const n of [0, 1, 2, 7]) {
    assert.equal(T.boundedCountText('en', n, lost, 'tool'), boundedCount(n, lost, 'tool'))
    assert.equal(T.boundedCountText('en', n, lost, 'toolError'), boundedCount(n, lost, 'tool error'))
  }
  assert.equal(T.replayLostText('en', 0), '')
  assert.equal(T.replayLostText('en', 1), 'at least 1 earlier event was not replayed')
  assert.equal(T.replayLostText('en', 40), 'at least 40 earlier events were not replayed')
})

test('French: a lower bound stays a lower bound, an incomplete count says so', () => {
  assert.equal(T.boundedCountText('fr', 4, 3, 'tool'), 'au moins 4 outils')
  assert.equal(T.boundedCountText('fr', 4, 0, 'tool'), '4 outils')
  assert.equal(T.boundedCountText('fr', 1, 0, 'toolError'), '1 erreur d’outil')
  assert.equal(T.boundedCountText('fr', 0, 2, 'toolError'), 'aucune erreur d’outil observée (incomplète)')
  assert.match(T.replayLostText('fr', 3), /^au moins 3 événements antérieurs/)
  assert.equal(T.replayLostText('fr', 0), '')
})

const VERDICTS: HealthVerdict[] = [
  { status: 'loop', calls: 9, comparable: 9, dropped: 0, lostEvents: 0, findings: [] },
  { status: 'unknown', calls: 0, comparable: 0, dropped: 0, lostEvents: 0, findings: [] },
  { status: 'clear', calls: 1, comparable: 1, dropped: 0, lostEvents: 0, findings: [] },
  { status: 'clear', calls: 12, comparable: 12, dropped: 0, lostEvents: 0, findings: [] },
  { status: 'incomplete', calls: 6, comparable: 6, dropped: 0, lostEvents: 0, findings: [] },
  { status: 'incomplete', calls: 20, comparable: 12, dropped: 3, lostEvents: 4, findings: [] },
  { status: 'incomplete', calls: 1, comparable: 1, dropped: 0, lostEvents: 1, findings: [] },
]
const FINDINGS: LoopFinding[] = [
  { kind: 'repeat', toolName: 'Read', count: 4, atLeast: true, toolUseIds: [] },
  { kind: 'repeat', toolName: 'Bash', count: 3, atLeast: false, toolUseIds: [] },
  { kind: 'edit-cycle', path: '/repo/src/a.ts', count: 3, atLeast: false, toolUseIds: [] },
  { kind: 'edit-cycle', path: 'C:\\repo\\b.ts', count: 5, atLeast: true, toolUseIds: [] },
]

test('English: loop verdicts and findings', () => {
  for (const v of VERDICTS) assert.equal(T.healthText('en', v), healthText(v))
  for (const f of FINDINGS) assert.equal(T.findingText('en', f), findingText(f))
  assert.equal(T.sessionLoopText('en', VERDICTS[0]), sessionHealthText(VERDICTS[0]))
  assert.equal(T.sessionLoopText('en', VERDICTS[2]), null)
  assert.equal(T.sessionLoopText('en', undefined), null)
})

test('French: a verdict keeps every figure, "at least" and the part that was not observed', () => {
  assert.equal(T.healthText('fr', VERDICTS[0]), 'Boucle observée')
  assert.equal(T.healthText('fr', VERDICTS[2]), 'Aucune boucle observée (1 appel d’outil)')
  assert.equal(T.healthText('fr', VERDICTS[3]), 'Aucune boucle observée (12 appels d’outil)')
  assert.equal(T.healthText('fr', VERDICTS[5]), 'Aucune boucle dans la partie observée (12 sur 20 appels d’outil comparables; historique antérieur abandonné; au moins 4 événements antérieurs de cette session non rejoués)')
  assert.equal(T.findingText('fr', FINDINGS[0]), 'Read appelé au moins 4× de suite avec la même entrée')
  assert.equal(T.findingText('fr', FINDINGS[2]), 'lecture → modification → échec 3× sur a.ts')
  assert.equal(T.findingText('fr', FINDINGS[3]), 'lecture → modification → échec au moins 5× sur b.ts')
})

const DURATIONS: DelegationDuration[] = [{ kind: 'measured', seconds: 42 }, { kind: 'recorded', seconds: 3725 }, { kind: 'not-reported' }, { kind: 'not-returned' }]
const RESULTS: DelegationResult[] = [
  { kind: 'returned', excerpt: 'Found it', truncated: false }, { kind: 'returned', excerpt: 'Found it', truncated: true },
  { kind: 'returned', excerpt: '  ', truncated: false }, { kind: 'error', excerpt: 'boom', truncated: false }, { kind: 'error', excerpt: '', truncated: false },
  { kind: 'not-returned', finished: true }, { kind: 'not-returned', finished: false },
]

test('English: the delegation report words are the ones of delegation-report', () => {
  for (const lost of [0, 3]) {
    for (const d of DURATIONS) assert.equal(T.durationText('en', d, lost), durationText(d, lost))
    for (const r of RESULTS) assert.equal(T.resultText('en', r, lost), resultText(r, lost))
    for (const n of [0, 1, 2, 9]) assert.equal(T.delegationCountText('en', n, lost), delegationCountText(n, lost))
    for (const filesReadCount of [0, 1, 4]) for (const readsNotConfirmed of [0, 1, 3]) {
      assert.equal(T.filesReadText('en', { filesReadCount, readsNotConfirmed }, lost), filesReadText({ filesReadCount, readsNotConfirmed }, lost))
    }
  }
})

test('French: the delegation report keeps durations, counts and the unknowns', () => {
  assert.equal(T.durationText('fr', DURATIONS[0]), '0:42 (mesurée)')
  assert.equal(T.durationText('fr', DURATIONS[1]), '1:02:05 (enregistrée)')
  assert.equal(T.durationText('fr', DURATIONS[2]), 'non communiqué')
  assert.equal(T.durationText('fr', DURATIONS[3], 2), 'aucun retour observé (incomplet)')
  assert.equal(T.filesReadText('fr', { filesReadCount: 2, readsNotConfirmed: 1 }), '2 fichiers, 1 non confirmé(s)')
  assert.equal(T.filesReadText('fr', { filesReadCount: 2, readsNotConfirmed: 1 }, 1), 'au moins 2 fichiers, au moins 1 non confirmé(s)')
  assert.equal(T.filesReadText('fr', { filesReadCount: 0, readsNotConfirmed: 0 }), 'aucun observé')
  assert.equal(T.delegationCountText('fr', 3, 1), 'au moins 3 sous-agents')
  assert.equal(T.resultText('fr', RESULTS[1]), 'Found it…', 'the report itself is data and stays as it came')
  assert.equal(T.resultText('fr', RESULTS[3]), 'Erreur : boom')
})

test('English: git labels, group headings, issue links', () => {
  const en = T.gitLabels('en')
  const L = GIT_STRIP_LABELS
  assert.equal(en.title, L.title)
  assert.equal(en.lost, L.lost)
  assert.equal(en.newTab.trim(), L.newTab.trim())
  assert.equal(en.branch, L.branch)
  assert.equal(en.detached, L.detached)
  assert.equal(en.seen('1:02'), L.seen('1:02'))
  for (const n of [1, 2, 5]) for (const inc of [false, true]) assert.equal(en.commits(n, inc), L.commits(n, inc))
  assert.equal(en.commitsList, L.commitsList)
  assert.equal(en.amended, `(${L.amended})`)
  for (const n of [1, 3]) { assert.equal(en.omittedCommits(n), L.omittedCommits(n)); assert.equal(en.omittedPrs(n), L.omittedPrs(n)) }
  assert.equal(en.prsList, L.prsList)
  assert.equal(en.pr(12, 'o/r'), L.pr(12, 'o/r'))
  assert.equal(en.pr(13, null), L.pr(13, null))
  assert.deepEqual(en.prStates, L.prStates)
  assert.equal(T.groupHeadingText('en', 'team', 'alpha'), groupHeading('team', 'alpha'))
  assert.equal(T.groupHeadingText('en', 'workflow', 'w'), groupHeading('workflow', 'w'))
  assert.equal(T.groupHeadingText('en', undefined, 'x'), groupHeading(undefined, 'x'))
  assert.equal(T.issueLinkText('en', { kind: 'issue', number: 7, title: 'T', url: 'u', state: 'open' }), 'Issue #7 T')
  assert.equal(T.issueLinkText('en', { kind: 'pr', number: 8, title: '', url: 'u', state: 'open', draft: true }), 'PR #8 (draft)')
  assert.equal(T.groupHeadingText('fr', 'team', 'alpha'), 'Équipe alpha')
  assert.equal(T.groupHeadingText('fr', 'workflow', 'w'), 'Workflow w')
  assert.equal(T.gitLabels('fr').commits(5, true), '5 commits observés (incomplet)')
  assert.equal(T.gitLabels('fr').omittedCommits(3), '3 commits antérieurs non conservés (les 20 plus récents sont listés)')
  assert.equal(T.gitLabels('fr').pr(13, null), 'PR #13 (dépôt non communiqué)')
})

test('English: silence, last event and active time', () => {
  for (const ms of [0, 59_999, 60_000, 7 * 60_000 + 5000, 3 * 3_600_000, 26 * 3_600_000 + 90_000]) {
    for (const kind of ['silent', 'permission'] as const) {
      assert.equal(T.silenceText('en', { kind, ms }, 'thinking'), silenceText({ kind, ms }, 'thinking'))
    }
  }
  assert.equal(T.silenceText('fr', { kind: 'silent', ms: 7 * 60_000 }, 'thinking'), 'dernier état connu : Réflexion, silencieux depuis 7 min')
  assert.equal(T.silenceText('fr', { kind: 'permission', ms: 3 * 3_600_000 }, 'thinking'), 'en attente d’autorisation depuis 3 h 0 min')
  const clock = (ms: number) => `t${ms}`
  assert.equal(T.lastEventText('en', 5, 'live', clock), 'last event t5')
  assert.equal(T.lastEventText('en', 5, 'imported', clock), 'last event t5 (imported transcript)')
  assert.equal(T.lastEventText('en', 5, 'history', clock), 'history received t5')
  assert.equal(T.lastEventText('en', undefined, undefined, clock), 'no event observed')
  assert.equal(T.lastEventText('en', Number.NaN, 'live', clock), 'no event observed')
  for (const f of ['fresh', 'stale', 'interrupted', 'error', 'closed', 'never-observed'] as const) assert.ok(T.freshnessText('fr', f).length > 0)
  const fields = [{}, { activeMs: 90_000 }, { activeSince: 1000 }, { activeSince: 1000, activeMs: 90_000 }, { activeMs: Number.NaN }]
  for (const f of fields) for (const fresh of ['fresh', 'stale', 'closed'] as const) for (const span of [0, 12_000, 25 * 3_600_000]) {
    assert.equal(T.activeSummaryText('en', f, fresh, span), activeSummaryText(f, fresh, span))
  }
  assert.equal(T.activeSummaryText('fr', { activeSince: 1, activeMs: 90_000 }, 'fresh', 12_000), 'actif depuis 0:12 · 1:42 au total')
  assert.equal(T.activeSummaryText('fr', { activeSince: 1 }, 'stale', 0), 'temps d’activité inconnu', 'a stale counter is still unknown, never a number')
})

test('English: the Sessions panel words are the ones it showed before', () => {
  for (const [members, working, kind] of [[1, 0, 'team'], [3, 2, 'workflow'], [1, 1, undefined], [0, 0, 'workflow']] as const) {
    assert.equal(T.teamSummaryText('en', 'alpha', members, working, kind), formatTeamSummary('alpha', members, working, kind))
  }
  for (const [w, e] of [[0, 0], [2, 0], [0, 1], [1, 3]]) assert.equal(T.sessionAttentionLabel('en', { waiting: w, errors: e }), formatAttention(w, e) || null)
  assert.equal(T.sessionAttentionLabel('en', undefined), null)
  assert.equal(T.sessionAttentionLabel('fr', { waiting: 0, errors: 0 }), null)
  for (const sec of [0, 4, 5, 59, 60, 3599, 3600, 86_399, 86_400, 400_000]) assert.equal(T.relativeTimeText('en', 0, sec * 1000), formatRelativeTime(0, sec * 1000))
  for (const kind of ['new-activity', 'active', 'completed', 'unobserved', 'indexed', 'imported', 'offline'] as const) assert.equal(T.sessionStatusText('en', kind), SESSION_STATUS_TEXT[kind])
  assert.equal(T.sessionStatusHelp('en', 'unobserved'), SESSION_NOT_OBSERVED_HELP)
  assert.equal(T.sessionStatusHelp('en', 'indexed'), SESSION_INDEXED_HELP)
  assert.equal(T.sessionStatusHelp('en', 'imported'), SESSION_IMPORTED_HELP)
  assert.equal(T.sessionStatusHelp('en', 'offline'), SESSION_OFFLINE_HELP)
  const en = MESSAGES.en
  assert.equal(en['sessions.title'], SESSIONS_LIST_NAME)
  assert.equal(en['sessions.activeOnly'], SESSION_LIST_LABELS.activeOnly)
  assert.equal(en['sessions.activeOnlyHelp'], SESSION_LIST_LABELS.activeOnlyHelp)
  assert.equal(en['sessions.hide'].replace('{label}', 'x'), SESSION_LIST_LABELS.hideNamed('x'))
  assert.equal(en['sessions.empty.match'], emptyMatch('sessions'))
  assert.equal(en['card.contextWindow'], CONTEXT_WINDOW_NAME)
  assert.equal(T.sharedNounCount(1, 'session'), '1 session')
  assert.equal(T.sharedNounCount(0, 'session'), '0 sessions')
})

test('French: team summary, attention and ages keep their figures', () => {
  assert.equal(T.teamSummaryText('fr', 'alpha', 3, 2, 'team'), 'Équipe alpha : 3 membres, 2 au travail')
  assert.equal(T.teamSummaryText('fr', 'w', 1, 0, 'workflow'), 'Workflow w : 1 agent, 0 au travail')
  assert.equal(T.sessionAttentionLabel('fr', { waiting: 2, errors: 1 }), '2 en attente / 1 erreur')
  assert.equal(T.sessionAttentionLabel('fr', { waiting: 0, errors: 3 }), '3 erreurs')
  assert.equal(T.relativeTimeText('fr', 0, 90_000), 'il y a 1 min')
  assert.equal(T.relativeTimeText('fr', 0, 2000), 'à l’instant')
})
