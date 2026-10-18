// #373: a surface covered by the message catalog never mixes the two languages. For each locale, the surfaces
// already translated (Settings tab by tab, the canvas controls and their View panel, the agent card, the Sessions panel) are rendered and every visible
// text, accessible name, tooltip and description must be a value of that locale's catalog (placeholders filled in)
// or an entry of an explicit allowlist (proper names, symbols). A subtree marked data-i18n-exempt (it carries its own
// lang, for instance the legend, still English) is left out. Surfaces not yet translated (top bar, panels, palette,
// legend) are out of this test on purpose: see docs/reading-the-ui.md. The top bar controls translated in #373 have
// their own test (topbar-i18n.test.tsx) until the whole bar can join this one.
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import { SettingsDialog, type SettingsDialogProps } from '@/components/agent-visualizer/settings-dialog'
import { SETTINGS_TABS, SETTINGS_TAB_LABEL, type SettingsTab } from '@/lib/settings-tabs'
import { CanvasControls } from '@/components/agent-visualizer/canvas-controls'
import { DEFAULT_CALM_LAYERS } from '@/lib/motion-layers'
import * as C from '@/lib/card-text'
import { AgentDetailCard, AgentGoneCard } from '@/components/agent-visualizer/agent-detail-card'
import { SessionListPanel, type SessionListAgent } from '@/components/agent-visualizer/session-list-panel'
import { createFreshnessClock } from '@/hooks/use-freshness-clock'
import type { SessionInfo } from '@/lib/bridge-types'
import type { DelegationRow } from '@/lib/delegation-report'
import type { GitState } from '@/lib/git-state'
import { setLocaleChoice } from '@/lib/locale'
import { DEFAULT_RULES } from '@/lib/notification-rules'
import { LOCALES, MESSAGES, type Locale, type MessageKey } from '@/lib/messages'
import type { NotifyState } from '@/hooks/use-attention-alerts'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  setLocaleChoice('auto')
  window.localStorage.clear()
})

// Function words that belong to one language only. Small on purpose: a hit is a sentence of the wrong language.
const ENGLISH = new Set(['the', 'and', 'for', 'with', 'of', 'when', 'that', 'this', 'your', 'stops', 'nothing', 'each', 'are', 'is', 'was', 'there', 'already', 'hides', 'follow', 'subtitles', 'sensitive', 'seen', 'live', 'what', 'mute', 'least', 'observed', 'reported', 'estimated', 'incomplete', 'none', 'confirmed', 'tool', 'tools', 'calls', 'earlier', 'search', 'filter', 'hide', 'rename', 'expand', 'collapse'])
const FRENCH = new Set(['le', 'la', 'les', 'des', 'du', 'pour', 'avec', 'et', 'une', 'sont', 'est', 'dans', 'sur', 'aux', 'que', 'qui', 'pas', 'vos', 'votre', 'cette', 'ou', 'rien', 'chaque'])

function wordsOf(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean)
}

const ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'aria-description', 'alt', 'aria-valuetext'] as const

/** Every string a person or a screen reader gets from the rendered tree, minus the subtrees marked data-i18n-exempt. */
function surfaceStrings(root: Node): string[] {
  const out: string[] = []
  const exempt = (n: Node) => (n instanceof Element ? n : n.parentElement)?.closest('[data-i18n-exempt]') != null
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = (n.textContent ?? '').trim()
    if (t && !exempt(n)) out.push(t)
  }
  const el = root as Element
  el.querySelectorAll(ATTRIBUTES.map(a => `[${a}]`).join(',')).forEach(e => {
    if (exempt(e)) return
    for (const a of ATTRIBUTES) { const v = e.getAttribute(a); if (v) out.push(v) }
  })
  return out
}

function foreignWords(locale: Locale, strings: string[]): string[] {
  const foreign = locale === 'fr' ? ENGLISH : FRENCH
  const hits: string[] = []
  for (const s of strings) if (!FIXTURE_DATA.has(s)) for (const w of wordsOf(s)) if (foreign.has(w)) hits.push(`${w} in "${s}"`)
  return hits
}

// Not in the catalog on purpose, the same in both languages: proper names of themes (THEME_LABELS) and symbols.
const ALLOWLIST = new Set(['Catppuccin Macchiato', 'Catppuccin Mocha', 'Catppuccin Frappe', 'Midnight', 'Graphite', 'Neon', 'Ember', 'Anthropic', '✓', '✕', '▸', '▾',
  // Data and technical identifiers of the card and the Sessions panel fixtures (names, paths, branches, git commands, models): never translated
  'MCP', 'Claude Code', 'Codex', 'GitHub Copilot', 'Pi', 'Gemini CLI', 'OpenCode', '⟳', '⎇', '/', '!', 'Σ', '·', '(', ')', '└', '✎', '⤓', '◌', '⚙', 'agent:', '.', ','])
/** Exact data values of the fixtures below (names, paths, branches, models, an excerpt); filled by them */
const FIXTURE_DATA = new Set<string>()
/** Data the fixtures carry (an agent name, a path, a model, an excerpt): shown as it came, in no language of ours. */
const DATA = [/^\d+ (sessions?|agents?)$/, /^Phase \S+$/, /^\(\d+\)$/, /^Workflow \S+$/, /^[\d.]+[kM]?$/, /^\((≥ )?\d+%\)$/, /^(Opus|Sonnet|Haiku) [\d.]+$/, /^git (checkout \/ switch|status|commit|branch --show-current)$/, /^PR #\d+ \([\w./-]+\)$/, /^[a-f0-9]{7}$/, /^\+?\d+(:\d\d)+$/]

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One regex per catalog value: a {placeholder} stands for a number or a short word. A shortcut hint " (+)" may follow. */
function catalogPatterns(locale: Locale): RegExp[] {
  return (Object.values(MESSAGES[locale]) as string[]).map(v => {
    // A placeholder stands for data or a figure: a word, a number, a time ("1:02"), a phrase built from other catalog values
    const body = v.split(/\{\w+\}/).map(escapeRe).join('[\\p{L}\\p{N}.,:;#/+≥×%·()\'’ -]+')
    return new RegExp(`^${body}(?: \\([+\\-0]\\))?$`, 'u')
  })
}

/** The rendered strings that are neither a value of the locale's catalog nor an allowlisted name. */
function strangers(locale: Locale, strings: string[]): string[] {
  const patterns = catalogPatterns(locale)
  // An issue or a PR of the links list: its number and its title are data, only "draft" is a word
  const issueLink = new RegExp(`^(PR|Issue) #\\d+(?: \\(${locale === 'fr' ? 'brouillon' : 'draft'}\\))?(?: Title \\d+)?$`)
  const known = (s: string) => ALLOWLIST.has(s) || FIXTURE_DATA.has(s) || DATA.some(d => d.test(s)) || issueLink.test(s) || patterns.some(p => p.test(s))
  // A line built from several parts ("branch · git commit · seen +1:02") is fine when every part is
  const parts = (s: string) => s.replace(/^· /, '').split(' · ')
  return strings.filter(s => !known(s) && !((s.startsWith('· ') || s.includes(' · ')) && parts(s).every(known)))
}

/** The nearest declared language of an element. */
const langOf = (el: Element) => el.closest('[lang]')?.getAttribute('lang')

const noop = () => {}
const settingsProps = (state: NotifyState): SettingsDialogProps => ({
  open: true, onClose: noop,
  hexGrid: true, onHexGridChange: noop,
  muted: false, onToggleMute: noop,
  showFinished: false, onShowFinishedChange: noop,
  hideInactive: true, onHideInactiveChange: noop,
  singleKeyEnabled: true, onSingleKeyEnabledChange: noop,
  onOpenShortcuts: noop,
  notifications: { state, onToggle: noop, rules: { ...DEFAULT_RULES, cost: true }, onRulesChange: noop },
  announcements: { level: 'important', onLevelChange: noop },
  quota: { show: true, onShowChange: noop },
  presentation: { active: false, onActiveChange: noop, options: { subtitles: true, mask: true, follow: true }, onOptionChange: noop },
  onResetPrefs: noop,
})

const NOTIFY_STATES: NotifyState[] = ['on', 'off', 'denied', 'unsupported']

/** Strings of what is shown: a hidden subtree (an unselected tab panel of Settings, #533) is left out. */
function shownStrings(root: Element): string[] {
  const copy = root.cloneNode(true) as Element
  copy.querySelectorAll('[hidden]').forEach(e => e.remove())
  return surfaceStrings(copy)
}

/** Settings in tabs (#533): each tab is checked alone, with the keys only that tab renders. */
const SETTINGS_TAB_KEYS: Record<SettingsTab, MessageKey[]> = {
  general: ['settings.section.appearance', 'settings.theme', 'settings.language', 'settings.hexGrid.help', 'settings.quota', 'settings.quota.help', 'settings.quota.setup', 'settings.section.sound', 'settings.sound.help'],
  sessions: ['settings.section.sessions', 'settings.showFinished.help', 'settings.hideInactive.help', 'settings.section.presentation', 'settings.presentation.help', 'settings.presentation.subtitles.help', 'settings.presentation.mask.help', 'settings.presentation.follow.help'],
  notifications: ['settings.section.notifications', 'settings.notify.unsupported', 'settings.notify.denied', 'settings.notify.rulesPending', 'settings.notify.invalid', 'settings.notify.cost.help',
    'settings.section.announcements', 'settings.announce.level', 'settings.announce.level.all', 'settings.announce.level.important', 'settings.announce.help'],
  keyboard: ['settings.section.keyboard', 'settings.singleKey.help', 'settings.shortcuts', 'settings.section.reset', 'settings.reset', 'settings.reset.help'],
}

for (const locale of LOCALES) {
  for (const tab of SETTINGS_TABS) {
    test(`Settings, tab ${tab} (every notification state, an invalid threshold included) speaks only ${locale}`, () => {
      setLocaleChoice(locale)
      const strings: string[] = []
      for (const state of NOTIFY_STATES) {
        const view = render(<SettingsDialog {...settingsProps(state)} />)
        const dialog = view.getByRole('dialog')
        assert.equal(langOf(dialog), locale, `the dialog declares lang=${locale}`)
        fireEvent.click(view.getByRole('tab', { name: MESSAGES[locale][SETTINGS_TAB_LABEL[tab]] }))
        if (tab === 'notifications' && state === 'on') {
          fireEvent.change(view.getByLabelText(MESSAGES[locale]['settings.notify.threshold']), { target: { value: '-1' } })
          assert.ok(view.getByRole('alert'), 'the invalid threshold message is rendered')
        }
        strings.push(...shownStrings(dialog))
        cleanup()
      }
      for (const key of [...SETTINGS_TAB_KEYS[tab], 'settings.title', 'settings.tabs', ...SETTINGS_TABS.map(t => SETTINGS_TAB_LABEL[t])] as MessageKey[]) {
        assert.ok(strings.includes(MESSAGES[locale][key]), `${key} was rendered`)
      }
      for (const other of SETTINGS_TABS.filter(t => t !== tab)) {
        assert.ok(!strings.includes(MESSAGES[locale][SETTINGS_TAB_KEYS[other][1]]), `${other} is not shown in ${tab}`)
      }
      assert.deepEqual(foreignWords(locale, strings), [])
      assert.deepEqual(strangers(locale, strings), [])
    })
  }

  test(`the canvas controls and their View panel speak only ${locale}`, () => {
    const view = render(
      <CanvasControls
        teams={[]} zoomBy={noop} doZoomToFit={noop} animationsPaused={false} pausedBySystem={false}
        locale={locale} calmLayers={DEFAULT_CALM_LAYERS} onToggleCalmLayer={noop}
        neverHide={false} toolExpiryS={120} onToggleAnimationsPaused={noop} onToggleNeverHide={noop} onChangeToolExpiry={noop}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: MESSAGES[locale]['controls.view'] }))
    const panel = view.getByRole('dialog', { name: MESSAGES[locale]['controls.viewSettings'] })
    assert.equal(langOf(panel), locale, `the View panel declares lang=${locale}`)
    // An exempt subtree (the legend, still English) must say so to a screen reader with its own lang
    for (const e of Array.from(document.querySelectorAll('[data-i18n-exempt]'))) assert.equal(e.getAttribute('lang'), 'en', 'an exempt subtree declares lang=en')
    const strings = surfaceStrings(document.body)
    assert.ok(strings.length > 5)
    assert.deepEqual(foreignWords(locale, strings), [])
    assert.deepEqual(strangers(locale, strings), [])
  })
}

test('the theme tooltip names the themes as the options do', () => {
  for (const locale of LOCALES) {
    setLocaleChoice(locale)
    const view = render(<SettingsDialog {...settingsProps('on')} />)
    const select = view.getByRole('combobox', { name: MESSAGES[locale]['settings.theme'] }) as HTMLSelectElement
    const tooltip = (select.getAttribute('title') ?? '').toLowerCase()
    for (const option of Array.from(select.options)) {
      const label = (option.textContent ?? '').toLowerCase()
      const name = label.startsWith('catppuccin') ? 'catppuccin' : label
      assert.ok(tooltip.includes(name), `${locale}: the tooltip "${tooltip}" names the option "${option.textContent}"`)
    }
    cleanup()
  }
})

test('the detector does catch a sentence or a short label of the wrong language', () => {
  assert.notDeepEqual(foreignWords('fr', ['Hides prompts and paths']), [])
  assert.notDeepEqual(foreignWords('en', ['Masque les chemins']), [])
  // A short untranslated label has no function word: only the catalog check sees it
  assert.deepEqual(foreignWords('fr', ['Cost threshold (USD)']), [])
  assert.deepEqual(strangers('fr', ['Cost threshold (USD)']), ['Cost threshold (USD)'])
  assert.deepEqual(strangers('fr', ['Legend']), ['Legend'])
  assert.deepEqual(strangers('fr', [MESSAGES.fr['settings.notify.threshold'], '2 min', `${MESSAGES.fr['controls.zoomIn']} (+)`, 'Midnight']), [])
})

// ---- The agent card (#502) ----

const NOW = 1_700_000_000_000
const clock = createFreshnessClock({ now: () => NOW, isHidden: () => true })
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
const g = globalThis as unknown as Record<string, unknown>
const realFetch = g.fetch

for (const d of ['Orchestrator', 'tempo', 'repo-a', 'github › list', 'xhigh', 'scout', 'fixer', 'Explore', '/repo/src/a.ts', '/repo/src/b.ts', 'Found the payment module', 'Found the payment module…', 'boom', 'feat/386-git-strip', 'abc1234', 'def5678', 'test: git strip (#386)', 'feat: git strip (#386)', 'o/r', 'Title 7', 'ui-designer', 'ui-designer-1', 'ui-designer-2', '/repo/src/edit.ts', 'edit.ts', 'Read', 'a.ts']) FIXTURE_DATA.add(d)

const cardBase = { id: 's1:main', name: 'Orchestrator', state: 'thinking' as const, tokensUsed: 5000, tokensMax: 10000, toolCalls: 4, timeAlive: 125, lastEventAt: NOW, freshnessSource: 'live' as const, spawnTime: 10 }

const gitState: GitState = {
  head: { ref: { kind: 'branch', name: 'feat/386-git-strip' }, source: 'commit', callId: 'c2', time: 72 },
  commits: [
    { sha: 'abc1234', branch: 'feat/386-git-strip', message: 'test: git strip (#386)', amend: false, callId: 'c2', toolUseId: 'u2', time: 72 },
    { sha: 'def5678', branch: 'feat/386-git-strip', message: 'feat: git strip (#386)', amend: true, callId: 'c3', time: 80 },
  ],
  omittedCommits: 3,
  prs: [
    { number: 12, repo: 'o/r', url: 'https://github.com/o/r/pull/12', state: 'merged', callId: 'c4', time: 130 },
    { number: 13, repo: null, state: 'closed', callId: 'c5', time: 140 },
    { number: 14, repo: 'o/r', state: 'draft', callId: 'c6', time: 150 },
  ],
  omittedPrs: 2,
  seen: ['c2', 'c3', 'c4', 'c5', 'c6'],
}

const rows: DelegationRow[] = [
  { agentId: 's1:scout', name: 'scout', subagentType: 'Explore', linkVerified: true, tokens: { value: 1200, status: 'partial', estimated: true },
    filesRead: ['/repo/src/a.ts', '/repo/src/b.ts'], filesReadCount: 2, readsNotConfirmed: 1, duration: { kind: 'measured', seconds: 42 },
    result: { kind: 'returned', excerpt: 'Found the payment module', truncated: true } },
  { agentId: 's1:fixer', name: 'fixer', linkVerified: false, tokens: { value: null, status: 'unavailable', estimated: false },
    filesRead: [], filesReadCount: 0, readsNotConfirmed: 0, duration: { kind: 'not-returned' }, result: { kind: 'not-returned', finished: false } },
  { agentId: 's1:b', name: 'scout', linkVerified: true, tokens: { value: 10, status: 'available', estimated: false },
    filesRead: [], filesReadCount: 0, readsNotConfirmed: 2, duration: { kind: 'recorded', seconds: 5 },
    result: { kind: 'error', excerpt: 'boom', truncated: false } },
  { agentId: 's1:c', name: 'fixer', linkVerified: true, tokens: { value: 10, status: 'available', estimated: false },
    filesRead: [], filesReadCount: 0, readsNotConfirmed: 0, duration: { kind: 'not-reported' }, result: { kind: 'not-returned', finished: true } },
]

const noopSelect = () => {}

for (const locale of LOCALES) {
  test(`the agent card (every section, freshness and health state, replay loss) speaks only ${locale}`, async () => {
    setLocaleChoice(locale)
    const strings: string[] = []
    const keep = (view: ReturnType<typeof render>) => {
      const dialog = view.getByRole('dialog')
      assert.equal(langOf(dialog), locale, `the card declares lang=${locale}`)
      strings.push(...surfaceStrings(dialog))
      cleanup()
    }
    const card = (agent: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      render(<AgentDetailCard agent={{ ...cardBase, ...agent } as never} onClose={noop} freshnessClock={clock} {...extra} />)

    // Every section at once, with a replay loss so the totals read "at least"
    keep(card(
      {
        kind: 'teammate', teamKind: 'workflow', teamName: 'tempo', activity: 'working', model: 'claude-opus-4-5', modelSource: 'runtime',
        requestedModel: 'claude-sonnet-4-5', modelsUsed: ['claude-opus-4-5'], effort: 'xhigh', tokenStatus: 'partial', tokensMaxAssumed: true,
        currentTool: 'mcp__github__list', sessionLabel: 'repo-a', git: gitState, activeMs: 90_000,
      },
      {
        toolErrors: 2, replayLost: 3, onSelectAgent: noopSelect, delegation: rows,
        health: { status: 'loop', calls: 9, comparable: 9, dropped: 0, lostEvents: 0, findings: [
          { kind: 'repeat', toolName: 'Read', count: 4, atLeast: true, toolUseIds: [] },
          { kind: 'edit-cycle', path: '/repo/src/edit.ts', count: 3, atLeast: false, toolUseIds: [] },
          { kind: 'repeat', toolName: 'Read', count: 5, atLeast: false, toolUseIds: [] },
          { kind: 'repeat', toolName: 'Read', count: 6, atLeast: false, toolUseIds: [] },
          { kind: 'repeat', toolName: 'Read', count: 7, atLeast: false, toolUseIds: [] },
          { kind: 'repeat', toolName: 'Read', count: 8, atLeast: false, toolUseIds: [] },
        ] },
        sessionHealth: { status: 'incomplete', calls: 20, comparable: 12, dropped: 3, lostEvents: 4, findings: [] },
      },
    ))
    // Same card, no loss: exact counts and the other duration and result words
    keep(card({ git: gitState, tokenStatus: 'unavailable', tokensMaxAssumed: true, kind: 'teammate', teamName: 'tempo' }, { toolErrors: 1, delegation: rows, health: { status: 'clear', calls: 1, comparable: 1, dropped: 0, lostEvents: 0, findings: [] } }))
    keep(card({ tokenStatus: 'available' }, { toolErrors: 0, health: { status: 'unknown', calls: 0, comparable: 0, dropped: 0, lostEvents: 0, findings: [] } }))
    keep(card({ tokenStatus: 'available', toolCalls: 1 }, { replayLost: 1, toolErrors: 0, delegation: [rows[1], rows[3]] }))
    keep(card({ toolCalls: 0 }, { replayLost: 2, toolErrors: 0, delegation: [rows[1], rows[3]], health: { status: 'incomplete', calls: 6, comparable: 6, dropped: 0, lostEvents: 0, findings: [] } }))
    // Freshness: silent, waiting for permission, history, imported transcript, error, never observed
    keep(card({ lastEventAt: NOW - 7 * 60_000 - 5_000 }))
    keep(card({ state: 'waiting_permission', lastEventAt: NOW - 3 * 3_600_000 }))
    keep(card({ freshnessSource: 'history', lastEventAt: NOW - 600_000 }))
    keep(card({ freshnessSource: 'imported', lastEventAt: NOW - 600_000 }))
    keep(card({ state: 'error', lastEventAt: NOW - 1000 }))
    keep(card({ state: 'complete', lastEventAt: undefined, freshnessSource: undefined }))
    keep(card({ state: 'paused', lastEventAt: NOW - 1000, tokensMaxAssumed: false }))
    keep(card({ state: 'idle' }))

    // Issue links: a failed load, then a list with its Launch button
    g.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) })
    let view = card({ sessionId: 's1', name: 'ui-designer-1', agentType: 'ui-designer' }, { relayOrigin: 'http://127.0.0.1:4321' })
    await flush()
    keep(view)
    g.fetch = async () => ({ ok: true, json: async () => ({ role: 'ui-designer', links: [{ kind: 'issue', number: 7, title: 'Title 7', state: 'open', url: 'https://github.com/o/r/issues/7' }, { kind: 'pr', number: 8, title: 'Title 7', state: 'open', draft: true, url: 'https://github.com/o/r/pull/8' }] }) })
    view = card({ sessionId: 's2', name: 'ui-designer-2', agentType: 'ui-designer' }, { relayOrigin: 'http://127.0.0.1:4322', launch: { maxConcurrent: 2, launches: new Map() } })
    await flush()
    keep(view)
    g.fetch = realFetch

    // The card of a node that left the graph
    for (const name of ['scout', null]) {
      const gone = render(<AgentGoneCard name={name} onClose={noop} />)
      const dialog = gone.getByRole('dialog')
      assert.equal(langOf(dialog), locale, `the gone card declares lang=${locale}`)
      strings.push(...surfaceStrings(dialog))
      cleanup()
    }

    for (const key of ['card.delegation.title', 'card.git.title', 'card.contextWindow', 'card.freshness.stale', 'card.health.loop', 'card.issueLinks.unavailable', 'card.workflowAgent', 'card.gone.unnamed'] as MessageKey[]) {
      assert.ok(strings.includes(MESSAGES[locale][key]), `${key} was rendered`)
    }
    assert.ok(strings.length > 150, 'the card was rendered in every state')
    assert.deepEqual(foreignWords(locale, strings), [])
    assert.deepEqual([...new Set(strangers(locale, strings))], [])
  })
}

// ---- The Sessions panel (#502) ----

for (const d of ['fix login', 'refactor api', 'docs', 'alpha', 'beta', 'main', 'feat/x', 'Reviewer', 'My own name', 'tempo-team', 'scratch', 'build']) FIXTURE_DATA.add(d)

const panelSessions: SessionInfo[] = [
  { id: 'a', label: 'fix login', status: 'active', startTime: 0, lastActivityTime: 30, runtime: 'claude', projectId: 'pa', projectName: 'alpha', branch: 'main' },
  { id: 'b', label: 'refactor api', status: 'completed', startTime: 0, lastActivityTime: 20, runtime: 'codex', projectId: 'pb', projectName: 'beta', branch: 'feat/x', originalLabel: 'My own name' },
  { id: 'c', label: 'docs', status: 'active', startTime: 0, lastActivityTime: 10, runtime: 'claude', projectId: 'pb', projectName: 'beta' },
  { id: 'd', label: 'docs', status: 'active', startTime: 0, lastActivityTime: 10, runtime: 'claude', teamName: 'tempo-team', memberName: 'Reviewer' },
  { id: 'e', label: 'scratch', status: 'active', startTime: 0, lastActivityTime: 0, lastActivityUnknown: true, runtime: 'codex', imported: true },
  { id: 'f', label: 'scratch', status: 'active', startTime: 0, lastActivityTime: 1, indexedOnly: true },
]
const panelTeams = new Map([['tempo-team', { name: 'tempo-team', leadSessionId: 'a', kind: 'team' as const, members: [{ name: 'Reviewer' }, { name: 'Writer' }] }]])
const panelAgent = (id: string, sessionId: string, state: string, name = id): SessionListAgent =>
  ({ id, sessionId, parentKey: null, name, state, tokensUsed: 1, spawnTime: 1, lastEventAt: Date.now() }) as SessionListAgent

function sessionsPanel(extra: Partial<React.ComponentProps<typeof SessionListPanel>> = {}) {
  const agents = [
    panelAgent('a:m', 'a', 'waiting_permission', 'Reviewer'), panelAgent('a:s', 'a', 'error', 'Reviewer'),
    { ...panelAgent('c:w', 'c', 'thinking', 'Writer'), teamKind: 'workflow', phase: 'build' } as SessionListAgent,
    { ...panelAgent('c:x', 'c', 'thinking', 'Writer'), teamKind: 'workflow' } as SessionListAgent,
  ]
  return (
    <SessionListPanel
      visible onClose={noop} sessions={panelSessions} selectedSessionId="__all__" sessionsWithActivity={new Set()}
      onSelectSession={noop} onCloseSession={noop} onRenameSession={noop} onExportSession={noop} canExportSession={() => true}
      agents={new Map(agents.map(a => [a.id, a]))} selectedAgentId={null} onSelectAgent={noop} now={5000}
      observedSessionIds={new Set(['a', 'b'])} freshnessClock={clock}
      teams={panelTeams} teamMemberCounts={new Map([['tempo-team', 2]])} teamWorking={new Map([['tempo-team', 1]])}
      health={new Map([['a', { status: 'loop', calls: 9, comparable: 9, dropped: 0, lostEvents: 0, findings: [] }]])} {...extra}
    />
  )
}

for (const locale of LOCALES) {
  test(`the Sessions panel (titles, filters, actions, states, announcements) speaks only ${locale}`, () => {
    setLocaleChoice(locale)
    const strings: string[] = []
    const view = render(sessionsPanel())
    const dialog = view.container.querySelector('#sessions-panel') as HTMLElement
    assert.equal(langOf(dialog), locale, `the panel declares lang=${locale}`)
    const scan = () => strings.push(...surfaceStrings(dialog))
    const announced = () => strings.push(document.querySelector('[data-panel-announcer]')?.textContent ?? '')
    const named = (key: MessageKey) => new RegExp(MESSAGES[locale][key].replace('{label}', '.*'))
    scan()
    // Every session listed, with search and filters, an empty search and a cleared filter
    fireEvent.click(view.getByRole('button', { name: MESSAGES[locale]['sessions.activeOnly'] }))
    announced()
    scan()
    fireEvent.change(view.getByRole('searchbox'), { target: { value: 'docs' } })
    fireEvent.change(view.getByRole('combobox', { name: MESSAGES[locale]['sessions.filter.project'] }), { target: { value: 'pb' } })
    fireEvent.change(view.getByRole('combobox', { name: MESSAGES[locale]['sessions.filter.runtime'] }), { target: { value: 'claude' } })
    announced()
    scan()
    fireEvent.change(view.getByRole('searchbox'), { target: { value: 'nothing at all' } })
    announced()
    scan()
    fireEvent.click(view.getByRole('button', { name: MESSAGES[locale]['sessions.filter.clear'] }))
    announced()
    // Rename, fold, and the announcements they make
    fireEvent.click(view.getAllByRole('button', { name: named('sessions.rename') })[0])
    scan()
    fireEvent.keyDown(view.getByRole('textbox'), { key: 'Escape' })
    fireEvent.click(view.getAllByRole('button', { name: named('sessions.collapse') }).find(b => !(b as HTMLButtonElement).disabled)!)
    announced()
    scan()
    // Offline relay and the unobserved states
    view.rerender(sessionsPanel({ relayOffline: true, observedSessionIds: new Set(['a']) }))
    scan()
    // Nothing yet, nothing active
    view.rerender(sessionsPanel({ sessions: [] }))
    scan()
    view.rerender(sessionsPanel({ sessions: [panelSessions[1]], observedSessionIds: new Set() }))
    fireEvent.click(view.getByRole('button', { name: MESSAGES[locale]['sessions.activeOnly'] }))
    scan()

    // The words the panel owns were all rendered (not a vacuous pass)
    for (const key of ['sessions.title', 'sessions.allSessions', 'sessions.project.none', 'sessions.team.wholeView', 'sessions.phase.none', 'sessions.health.loop', 'sessions.activityUnknown', 'sessions.empty.none', 'sessions.empty.active', 'sessions.empty.match', 'sessions.search.hint', 'sessions.status.imported', 'sessions.status.indexed', 'sessions.status.offline', 'sessions.status.completed', 'sessions.announce.collapsed', 'sessions.rename.help'] as MessageKey[]) {
      const shape = new RegExp(`${MESSAGES[locale][key].split(/\{\w+\}/).map(escapeRe).join('.+')}$`)
      assert.ok(strings.some(x => shape.test(x)), `${key} was rendered`)
    }
    assert.ok(strings.some(x => x === C.sessionAttentionLabel(locale, { waiting: 1, errors: 1 })), 'the attention count was rendered')
    // What stays English must say so with its own lang
    for (const e of Array.from(dialog.querySelectorAll('[data-i18n-exempt]'))) assert.equal(e.getAttribute('lang'), 'en', 'an exempt subtree declares lang=en')
    assert.ok(strings.length > 80, 'the panel was rendered in every state')
    assert.deepEqual(foreignWords(locale, strings), [])
    assert.deepEqual([...new Set(strangers(locale, strings))], [])
  })
}
