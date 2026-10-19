// #373 (panels 1): the words of the Conversation, Context and Files panels in French and English. English output is
// the one of the helpers the panels used before (no figure, count or qualifier changes); French keeps every number and
// every qualifier ("au moins", "estimé", "incomplet", "non communiqué").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as P from '../web/lib/panel-text'
import { MESSAGES, LOCALES, type MessageKey } from '../web/lib/messages'
import { describeWaste, formatWasteTokens, type WasteItem } from '../web/lib/waste'
import { conflictHeading, describeConflictEditors, type FileConflict } from '../web/lib/file-conflicts'
import { boundedCount, replayLostSentence } from '../web/lib/event-loss'
import { formatDroppedMessages } from '../web/lib/chrome-utils'
import { checksLabel, type ChecksSummary } from '../web/lib/session-work'
import { FILE_TIMELINE_LABELS, GIT_STRIP_LABELS, groupHeading, memberNoun } from '../web/lib/ui-glossary'
import { pairChipLabel, pairSpokenLabel, pairAnnouncement, pairEmptyText, type PairState } from '../web/lib/pair-filter'
import { formatTokenUsage, qualify, type UsageTotal } from '../web/lib/usage'
import { RESUME_UNAVAILABLE_TEXT } from '../web/lib/resume-command'
import { teamChipGroups, COMM_LABELS } from '../web/lib/feed-utils'
import { ROLE_COLORS } from '../web/lib/colors'
import { COMPACTION_LABEL } from '../web/lib/compaction'

const USAGES: UsageTotal[] = [
  { value: null, status: 'unavailable', estimated: false },
  { value: 0, status: 'unavailable', estimated: true },
  { value: 1200, status: 'available', estimated: false },
  { value: 1200, status: 'available', estimated: true },
  { value: 128_500, status: 'partial', estimated: false },
  { value: 3_000_000, status: 'partial', estimated: true },
]

const ITEMS: WasteItem[] = [
  { agentId: 's:a', kind: 'reread', toolName: 'Read', target: '/x.ts', repeats: 1, lastAt: 0, tokens: 0, costsKnown: 0, costsUnknown: 1, estimated: false },
  { agentId: 's:a', kind: 'reread', toolName: 'Read', target: '/x.ts', repeats: 3, lastAt: 0, tokens: 400, costsKnown: 2, costsUnknown: 1, estimated: true },
  { agentId: 's:a', kind: 'identical', toolName: 'Glob', target: '*.ts', repeats: 2, lastAt: 0, tokens: 90, costsKnown: 2, costsUnknown: 0, estimated: false },
  { agentId: 's:a', kind: 'identical', toolName: 'Bash', target: 'ls', repeats: 1, lastAt: 0, tokens: 90, costsKnown: 1, costsUnknown: 0, estimated: true },
]

test('English: waste sentences and token costs are the ones of lib/waste', () => {
  for (const it of ITEMS) for (const lost of [0, 5]) assert.equal(P.wasteDescribeText('en', it, lost), describeWaste(it, lost))
  for (const it of ITEMS) assert.equal(P.wasteTokensText('en', it), formatWasteTokens(it))
})

test('French: a repeat keeps its count and its lower bound; an unreported cost stays unreported', () => {
  assert.equal(P.wasteDescribeText('fr', ITEMS[1], 0), 'relu 3 fois, sans modification vue entre-temps')
  assert.equal(P.wasteDescribeText('fr', ITEMS[1], 4), 'relu au moins 3 fois, sans modification vue entre-temps')
  assert.equal(P.wasteDescribeText('fr', ITEMS[2], 0), 'même Glob relancé 2 fois, sans modification vue entre-temps')
  assert.equal(P.wasteDescribeText('fr', ITEMS[3], 0), 'même commande Bash relancée 1 fois, juste après elle-même')
  assert.equal(P.wasteTokensText('fr', ITEMS[0]), 'jetons non communiqués')
  assert.equal(P.wasteTokensText('fr', ITEMS[1]), 'au moins 400 jetons estimés')
})

test('English: spoken tokens are qualify() + " tokens"; French keeps at least / estimated', () => {
  for (const u of USAGES) {
    if (u.value === null || u.status === 'unavailable') continue
    assert.equal(P.tokensSpoken('en', u), `${formatTokenUsage(u)} tokens`)
  }
  assert.equal(P.tokensSpoken('fr', USAGES[2]), '1.2k jetons')
  assert.equal(P.tokensSpoken('fr', USAGES[3]), '1.2k jetons estimés')
  assert.equal(P.tokensSpoken('fr', USAGES[4]), 'au moins 128k jetons')
  assert.equal(P.tokensSpoken('fr', USAGES[5]), 'au moins 3M jetons estimés')
  assert.equal(qualify(USAGES[4], '128k'), 'at least 128k')
})

const CONFLICT: FileConflict = { path: '/a.ts', lastEditTime: 1, editors: [{ agent: 's:alpha', edits: 2 }, { agent: 's:beta', edits: 1 }] }

test('English: conflicts are worded like lib/file-conflicts', () => {
  const label = (k: string) => k.split(':')[1]
  assert.equal(P.conflictEditorsText('en', CONFLICT, label), describeConflictEditors(CONFLICT, label))
  for (const [n, lost] of [[0, 0], [0, 3], [1, 0], [2, 0], [1, 3], [4, 2]] as const) assert.equal(P.conflictHeadingText('en', n, lost), conflictHeading(n, lost))
})

test('French: a conflict count keeps its lower bound, and no conflict is only said for the observed part', () => {
  const label = (k: string) => k.split(':')[1]
  assert.equal(P.conflictEditorsText('fr', CONFLICT, label), 'modifié par alpha : 2 modifications réussies ; beta : 1 modification réussie')
  assert.equal(P.conflictHeadingText('fr', 2, 0), '2 conflits')
  assert.equal(P.conflictHeadingText('fr', 1, 3), 'au moins 1 conflit')
  assert.equal(P.conflictHeadingText('fr', 0, 3), 'Aucun conflit dans la partie observée')
  assert.equal(P.conflictHeadingText('fr', 0, 0), null)
})

test('English: counts over an incomplete graph are the ones of boundedCount, the lost sentence of replayLostSentence', () => {
  for (const [n, lost] of [[0, 0], [0, 2], [1, 0], [3, 0], [1, 4], [5, 4]] as const) assert.equal(P.boundedFilesText('en', n, lost), boundedCount(n, lost, 'file'))
  for (const lost of [0, 1, 7]) assert.equal(P.lostSentence('en', lost), replayLostSentence(lost))
  assert.equal(P.boundedFilesText('fr', 0, 2), 'aucun fichier observé (incomplet)')
  assert.equal(P.boundedFilesText('fr', 3, 2), 'au moins 3 fichiers')
  assert.equal(P.boundedFilesText('fr', 1, 0), '1 fichier')
  assert.equal(P.lostSentence('fr', 1), 'au moins 1 événement antérieur n’a pas été rejoué par le relais')
  assert.equal(P.lostSentence('fr', 7), 'au moins 7 événements antérieurs n’ont pas été rejoués par le relais')
})

test('English: the file timeline sentences are the ones of FILE_TIMELINE_LABELS', () => {
  const L = FILE_TIMELINE_LABELS
  for (const n of [1, 2, 9]) for (const inc of [false, true]) assert.equal(P.fileTimelineText('en').summary(n, inc), L.summary(n, inc))
  assert.equal(P.fileTimelineText('en').summaryOf('/a.ts').trim(), L.summaryOf('/a.ts').trim())
  for (const n of [1, 4]) assert.equal(P.fileTimelineText('en').omitted(n), L.omitted(n))
  assert.equal(P.fileTimelineText('en').list('/a.ts'), L.list('/a.ts'))
  assert.equal(P.fileTimelineText('en').noCallId, L.noCallId)
  assert.equal(P.fileTimelineText('en').noCommits, L.noCommits)
  for (const k of ['read', 'edited', 'written'] as const) assert.equal(P.fileTimelineText('en').kinds[k], L.kinds[k])
  assert.equal(P.fileTimelineText('fr').summary(3, true), '3 étapes observées (incomplet)')
  assert.equal(P.fileTimelineText('fr').summary(1, false), '1 étape observée')
})

test('English: dropped markers, new-message counts, copy and export messages are the original ones', () => {
  for (const n of [0, 1, 12]) assert.equal(P.droppedText('en', n), formatDroppedMessages(n))
  assert.equal(P.droppedText('fr', 1), '… 1 message plus ancien supprimé')
  assert.equal(P.droppedText('fr', 12), '… 12 messages plus anciens supprimés')
  assert.equal(P.droppedText('fr', 0), null)
  assert.equal(P.newMessagesText('en', 1), '1 new message')
  assert.equal(P.newMessagesText('en', 3), '3 new messages')
  assert.equal(P.newMessagesText('fr', 3), '3 nouveaux messages')
  // comms-export.ts (copiedMessage, exportSavedMessage) is behind the "@/" alias: its messages are spelled out here
  assert.equal(P.copiedText('en', 'DISPATCH', 0, 0), 'DISPATCH copied')
  assert.equal(P.copiedText('en', 'DISPATCH', 5, 0), 'DISPATCH copied (truncated: 5 characters were cut)')
  assert.equal(P.copiedText('en', 'DISPATCH', 0, 1), 'DISPATCH copied; 1 secret redacted (best effort)')
  assert.equal(P.copiedText('en', 'DISPATCH', 0, 3), 'DISPATCH copied; 3 secrets redacted (best effort)')
  assert.equal(P.copiedText('en', 'DISPATCH', 7, 2), 'DISPATCH copied; 2 secrets redacted (best effort) (truncated: 7 characters were cut)')
  assert.equal(P.copiedText('fr', 'ENVOI', 7, 2), 'ENVOI copié ; 2 secrets masqués (au mieux) (tronqué : 7 caractères coupés)')
  assert.equal(P.exportSavedText('en', 0), 'Conversation exported as Markdown')
  assert.equal(P.exportSavedText('en', 1), 'Conversation exported as Markdown; 1 secret redacted (best effort)')
  assert.equal(P.exportSavedText('en', 2), 'Conversation exported as Markdown; 2 secrets redacted (best effort)')
  assert.equal(P.exportSavedText('fr', 1), 'Conversation exportée en Markdown ; 1 secret masqué (au mieux)')
  assert.equal(P.t('en', 'conv.exportFailed'), 'Export failed: this view cannot save files')
})

test('English: pair filter texts are the ones of lib/pair-filter', () => {
  const nameOf = (k: string) => k.toUpperCase()
  const pairs: PairState[] = [{ a: '', b: '' }, { a: 'x', b: '' }, { a: '', b: 'y' }, { a: 'x', b: 'x' }, { a: 'x', b: 'y' }]
  for (const p of pairs) {
    assert.equal(P.pairChipLabelText(p, nameOf), pairChipLabel(p, nameOf))
    assert.equal(P.pairSpokenText('en', p, nameOf), pairSpokenLabel(p, nameOf))
    for (const count of [0, 1, 4]) assert.equal(P.pairAnnouncementText('en', p, nameOf, count), pairAnnouncement(p, nameOf, count))
    assert.equal(P.pairEmptyTextT('en', p, nameOf), pairEmptyText(p, nameOf))
  }
  assert.equal(P.pairAnnouncementText('fr', pairs[4], nameOf, 0), 'Aucun message entre X et Y')
  assert.equal(P.pairAnnouncementText('fr', pairs[4], nameOf, 1), 'Affichage de 1 message entre X et Y')
  assert.equal(P.pairAnnouncementText('fr', pairs[4], nameOf, 4), 'Affichage de 4 messages entre X et Y')
  assert.equal(P.pairAnnouncementText('fr', pairs[0], nameOf, 0), 'Filtre de paire effacé')
  assert.equal(P.pairSpokenText('fr', pairs[1], nameOf), 'X et aucun agent')
})

const CHECKS: ChecksSummary[] = [
  { state: 'passing', total: 4, failing: 0, pending: 0 },
  { state: 'failing', total: 5, failing: 2, pending: 0 },
  { state: 'failing', total: 5, failing: 2, pending: 1 },
  { state: 'pending', total: 3, failing: 0, pending: 3 },
  { state: 'none', total: 0, failing: 0, pending: 0 },
  { state: 'unknown', total: 0, failing: 0, pending: 0 },
  { state: 'unknown', total: 2, failing: 0, pending: 0 },
]

test('English: checks are worded like checksLabel; French keeps each count', () => {
  for (const c of CHECKS) assert.equal(P.checksText('en', c), checksLabel(c))
  assert.equal(P.checksText('fr', CHECKS[0]), '4 sur 4 réussies')
  assert.equal(P.checksText('fr', CHECKS[2]), '2 en échec, 1 en attente sur 5')
  assert.equal(P.checksText('fr', CHECKS[6]), 'vérifications inconnues (2 communiquées)')
})

test('English: resume reasons, role and communication labels are the original ones', () => {
  for (const [k, v] of Object.entries(RESUME_UNAVAILABLE_TEXT)) assert.equal(P.resumeUnavailableText('en', k as keyof typeof RESUME_UNAVAILABLE_TEXT), v)
  for (const k of ['dispatch', 'return', 'return_error', 'message'] as const) assert.equal(P.commLabelText('en', k), COMM_LABELS[k])
  for (const type of ['assistant', 'thinking', 'user', 'compaction', 'system']) assert.equal(P.roleLabelText('en', type, undefined), (ROLE_COLORS[type] ?? ROLE_COLORS.assistant).label)
  assert.equal(P.roleLabelText('en', 'compaction', undefined), COMPACTION_LABEL)
  assert.equal(P.roleLabelText('en', 'assistant', 'codex'), 'CODEX')
  assert.equal(P.roleLabelText('fr', 'assistant', 'codex'), 'CODEX')
  assert.equal(P.roleLabelText('fr', 'thinking', undefined), 'RÉFLEXION')
  assert.equal(P.commLabelText('fr', 'return_error'), 'RETOUR (ERREUR)')
})

test('English: team chip headings and labels are the ones of teamChipGroups', () => {
  const items = [
    { sessionId: 'aaaaaaaaaaaa', teamName: 'alpha', teamKind: 'team' as const, name: 'a' },
    { sessionId: 'aaaaaaaaaaaa', teamName: 'alpha', teamKind: 'team' as const, name: 'b' },
    { sessionId: 'bbbbbbbbbbbb', teamName: 'tempo', teamKind: 'workflow' as const, name: 'c' },
  ]
  const groups = teamChipGroups(items, undefined)
  for (const g of groups) {
    const texts = P.teamChipTexts('en', g)
    assert.equal(texts.heading, g.heading)
    assert.equal(texts.label, g.label)
  }
  const fr = P.teamChipTexts('fr', groups[0])
  assert.equal(fr.heading, 'Équipe alpha')
  assert.equal(fr.label, 'Équipe alpha, 2 membres')
  assert.equal(P.teamChipTexts('fr', groups[1]).label, 'Workflow tempo, 1 agent')
  assert.equal(groupHeading('team', 'x'), 'Team x')
  assert.equal(memberNoun('workflow', 1), 'agent')
  assert.equal(GIT_STRIP_LABELS.title, 'Git (observed)')
})

test('Edit sentences: English words are the original ones, French keeps the line counts', () => {
  const one = [{ old: 'a\nb', next: 'c' }]
  assert.equal(P.editSentenceText('en', { added: 1, removed: 2, blocks: null }, one, undefined), '2 lines replaced by 1')
  assert.equal(P.editSentenceText('fr', { added: 1, removed: 2, blocks: null }, one, undefined), '2 lignes remplacées par 1')
  assert.equal(P.editSentenceText('en', { added: 3, removed: 0, blocks: null }, [{ old: '', next: 'x\ny\nz' }], undefined), '3 lines inserted')
  assert.equal(P.editSentenceText('fr', { added: 1, removed: 0, blocks: null }, [{ old: '', next: 'x' }], undefined), '1 ligne insérée')
  assert.equal(P.editSentenceText('en', { added: 0, removed: 1, blocks: null }, [{ old: 'x', next: '' }], undefined), 'text removed from 1 line')
  assert.equal(P.editSentenceText('fr', { added: 0, removed: 2, blocks: null }, [{ old: 'x\ny', next: '' }], undefined), 'texte supprimé de 2 lignes')
  assert.equal(P.editSentenceText('en', { added: 1, removed: 1, blocks: 2 }, [{ old: 'a', next: 'b' }, { old: '', next: 'c' }], undefined), 'old: 1 line, new: 1 line')
  assert.equal(P.editSentenceText('en', { added: 1, removed: 2, blocks: null }, one, 'error'), 'call failed, not applied: asked old 2 lines, new 1 line')
  assert.equal(P.editSentenceText('fr', { added: 1, removed: 2, blocks: null }, one, 'cancelled'), 'appel annulé, non appliqué : demandé, ancien texte 2 lignes, nouveau texte 1 ligne')
  assert.equal(P.editSentenceText('en', { added: 0, removed: 0, blocks: null }, [{ old: '', next: '' }], undefined), null)
})

test('every key used by the panels exists in both locales with the same placeholders', () => {
  for (const prefix of ['conv.', 'pair.', 'tok.', 'files.', 'waste.', 'ctx.', 'resume.', 'cap.', 'sw.', 'tool.']) {
    const keys = (Object.keys(MESSAGES.fr) as MessageKey[]).filter(k => k.startsWith(prefix))
    assert.ok(keys.length > 0, prefix)
    for (const l of LOCALES) for (const k of keys) assert.ok(MESSAGES[l][k], `${l}.${k}`)
  }
})
