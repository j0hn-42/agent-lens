// #373: a surface covered by the message catalog never mixes the two languages. For each locale, the surfaces
// already translated (Settings tab by tab, the canvas controls and their View panel, the agent card, the Sessions panel, the
// command palette, the legend, the whole top bar) are rendered and every visible
// text, accessible name, tooltip and description must be a value of that locale's catalog (placeholders filled in)
// or an entry of an explicit allowlist (proper names, symbols). A subtree marked data-i18n-exempt (it carries its own
// lang) is left out. Surfaces not yet translated (the panels)
// are out of this test on purpose: see docs/reading-the-ui.md. Control by control, the top bar also has
// topbar-i18n.test.tsx.
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import { SettingsDialog, type SettingsDialogProps } from '@/components/agent-visualizer/settings-dialog'
import { visibleSettingsTabs, SETTINGS_TAB_LABEL, type SettingsTab } from '@/lib/settings-tabs'

const ALL_SETTINGS_TABS = visibleSettingsTabs({ notifications: true, announcements: true })
import { CanvasControls } from '@/components/agent-visualizer/canvas-controls'
import { CommandPalette } from '@/components/agent-visualizer/command-palette'
import { GraphLegend } from '@/components/agent-visualizer/graph-legend'
import { TourBridgeContext } from '@/components/agent-visualizer/guided-tour-context'
import { buildPaletteItems, type PaletteSource } from '@/lib/command-palette'
import { sessionAttentionLabel } from '@/lib/card-text'
import { STATE_LABEL_SHORT } from '@/lib/canvas-constants'
import { LEGEND_ENTRY_IDS } from '@/lib/legend-entries'
import { REPEAT_THRESHOLD, CYCLE_THRESHOLD } from '@/lib/loop-detection'
import { DEFAULT_CALM_LAYERS } from '@/lib/motion-layers'
import * as C from '@/lib/card-text'
import { AgentDetailCard, AgentGoneCard } from '@/components/agent-visualizer/agent-detail-card'
import { SessionListPanel, type SessionListAgent } from '@/components/agent-visualizer/session-list-panel'
import { FreshnessAnnouncer } from '@/components/agent-visualizer/freshness-announcer'
import { createFreshnessClock } from '@/hooks/use-freshness-clock'
import { TopBar, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'
import { reconnectDetail } from '@/lib/reconnect'
import { parseRelayScopeState } from '@/lib/relay-scope'
import { setMobileView } from './mobile-media'
import type { SessionInfo } from '@/lib/bridge-types'
import type { DelegationRow } from '@/lib/delegation-report'
import type { GitState } from '@/lib/git-state'
import { setLocaleChoice } from '@/lib/locale'
import { DEFAULT_RULES } from '@/lib/notification-rules'
import { LOCALES, MESSAGES, translate, type Locale, type MessageKey } from '@/lib/messages'
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

function foreignWords(locale: Locale, strings: string[], extra: ReadonlySet<string> = new Set()): string[] {
  const foreign = locale === 'fr' ? ENGLISH : FRENCH
  const hits: string[] = []
  for (const s of strings) if (!FIXTURE_DATA.has(s) && !extra.has(s)) for (const w of wordsOf(s)) if (foreign.has(w)) hits.push(`${w} in "${s}"`)
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
    const body = v.split(/\{\w+\}/).map(escapeRe).join('[\\p{L}\\p{N}.,:;#/+≥×%·()<$\'’ -]+')
    return new RegExp(`^${body}(?: \\([+\\-0]\\))?$`, 'u')
  })
}

/** The rendered strings that are neither a value of the locale's catalog nor an allowlisted name. */
function strangers(locale: Locale, strings: string[], extra: { allow?: ReadonlySet<string>; data?: readonly RegExp[] } = {}): string[] {
  const patterns = catalogPatterns(locale)
  // An issue or a PR of the links list: its number and its title are data, only "draft" is a word
  const issueLink = new RegExp(`^(PR|Issue) #\\d+(?: \\(${locale === 'fr' ? 'brouillon' : 'draft'}\\))?(?: Title \\d+)?$`)
  const known = (s: string) => ALLOWLIST.has(s) || FIXTURE_DATA.has(s) || extra.allow?.has(s) || DATA.some(d => d.test(s)) || extra.data?.some(d => d.test(s)) || issueLink.test(s) || patterns.some(p => p.test(s))
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
  for (const tab of ALL_SETTINGS_TABS) {
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
      for (const key of [...SETTINGS_TAB_KEYS[tab], 'settings.title', 'settings.tabs', ...ALL_SETTINGS_TABS.map(t => SETTINGS_TAB_LABEL[t])] as MessageKey[]) {
        assert.ok(strings.includes(MESSAGES[locale][key]), `${key} was rendered`)
      }
      for (const other of ALL_SETTINGS_TABS.filter(t => t !== tab)) {
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

// The columns and agent rows (#502): figures, durations and money are data of the fixtures; ":" separates the English word the canvas
// draws from its gloss; the dash is the sign of "no data"; and the activity cell keeps its English relative time in a lang=en passage,
// so only the words before it remain in the catalog's language.
const COLUMN_DATA: readonly RegExp[] = [/^[≥~]*[\d.]+[kM]?$/, /^≥?\d+[dhms]( \d+[hms])?\+?$/, /^[≥~]*<?\$[\d.]+$/, /^\d+ h \d+ min$/, /^\d+ min$/]
const columnAllow = (locale: Locale): ReadonlySet<string> => new Set([':', '—', ',', MESSAGES[locale]['cols.activity.value'].replace(' {when}', '')])
/** The money placeholder of the cost sentences may hold "<$0.0001" */
const panelStrangers = (locale: Locale, strings: string[]) => strangers(locale, strings, { allow: columnAllow(locale), data: COLUMN_DATA })

for (const d of ['fix login', 'refactor api', 'docs', 'alpha', 'beta', 'main', 'feat/x', 'Reviewer', 'My own name', 'tempo-team', 'scratch', 'build', 'Writer', 'claude-opus-4-5-20251101']) FIXTURE_DATA.add(d)

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
    assert.deepEqual(foreignWords(locale, strings, columnAllow(locale)), [])
    assert.deepEqual([...new Set(panelStrangers(locale, strings))], [])
  })
}

// ---- The Sessions panel, columns and agent rows (#502) ----

for (const d of ['Planner', 'Scribe', 'Checker', 'Runner', 'Reader', 'Fixer', 'ui-designer']) FIXTURE_DATA.add(d)

const PANEL_NOW = NOW
/** One agent row per way the row can speak: fresh, a tool, last known, silent for a permission, closed after an error, a sub-agent. */
const columnAgents: SessionListAgent[] = [
  { ...panelAgent('a:p', 'a', 'thinking', 'Planner'), kind: 'main', model: 'claude-opus-4-5-20251101', tokensUsed: 12_400, tokenStatus: 'partial', tokensEstimated: true, activeMs: 95_000, lastEventAt: PANEL_NOW, spawnTime: 1 },
  { ...panelAgent('a:s', 'a', 'thinking', 'Scribe'), kind: 'subagent', parentKey: 'a:p', tokensUsed: 800, lastEventAt: PANEL_NOW, spawnTime: 2 },
  { ...panelAgent('a:r', 'a', 'tool_calling', 'Runner'), kind: 'subagent', parentKey: 'a:p', currentTool: 'Read', lastEventAt: PANEL_NOW, spawnTime: 3 },
  { ...panelAgent('a:c', 'a', 'thinking', 'Checker'), kind: 'teammate', lastEventAt: PANEL_NOW - 60_000, spawnTime: 4 },
  { ...panelAgent('a:w', 'a', 'waiting_permission', 'Reader'), lastEventAt: PANEL_NOW - 10 * 60_000, spawnTime: 5 },
  { ...panelAgent('a:e', 'a', 'error', 'Fixer'), lastEventAt: PANEL_NOW - 3 * 60_000, spawnTime: 6 },
]
const columnSessions: SessionInfo[] = [
  { id: 'a', label: 'fix login', status: 'active', startTime: 0, lastActivityTime: 3_000, runtime: 'claude', projectId: 'pa', projectName: 'alpha', branch: 'main', startTimeWatched: true },
  { id: 'e', label: 'scratch', status: 'active', startTime: 0, lastActivityTime: 0, lastActivityUnknown: true, runtime: 'codex', imported: true },
]
const columnsPanel = () => (
  <SessionListPanel
    visible onClose={noop} sessions={columnSessions} selectedSessionId="__all__" sessionsWithActivity={new Set()}
    onSelectSession={noop} onCloseSession={noop} agents={new Map(columnAgents.map(a => [a.id, a]))} selectedAgentId={null} onSelectAgent={noop}
    now={5000} activeOnly={false} observedSessionIds={new Set(['a'])} freshnessClock={createFreshnessClock({ now: () => PANEL_NOW, isHidden: () => true })}
  />
)
for (const locale of LOCALES) {
  test(`the Sessions panel columns and agent rows (state words, roles, qualifiers) speak only ${locale}`, () => {
    setLocaleChoice(locale)
    const view = render(columnsPanel())
    const dialog = view.container.querySelector('#sessions-panel') as HTMLElement
    const strings = surfaceStrings(dialog)
    assert.deepEqual(foreignWords(locale, strings, columnAllow(locale)), [])
    assert.deepEqual([...new Set(panelStrangers(locale, strings))], [])
    const spoken = (s: string) => strings.some(x => x.includes(s))
    // The column names and the qualifiers of the figures survive the translation
    for (const key of ['cols.model', 'cols.runtime', 'cols.branch', 'cols.tokens', 'cols.cost', 'cols.time', 'cols.activity'] as MessageKey[]) assert.ok(strings.includes(MESSAGES[locale][key]), `${key} was rendered`)
    assert.ok(spoken(C.usageText(locale, { value: 12_400, status: 'partial', estimated: true })), 'at least / estimated kept on the tokens')
    assert.ok(spoken(MESSAGES[locale]['cols.model.none']), 'a model not reported says so')
    assert.ok(spoken(MESSAGES[locale]['cols.branch.none']), 'a branch not recorded says so')
    assert.ok(spoken(MESSAGES[locale]['cols.activity.unknown']), 'an activity unknown says so')
    // Roles and state words
    for (const key of ['sessions.role.agent', 'sessions.role.subAgent', 'sessions.role.teammate'] as MessageKey[]) assert.ok(spoken(MESSAGES[locale][key]), `${key} was rendered`)
    const state = (st: string) => C.stateText(locale, st)
    assert.ok(strings.includes(state('thinking')), 'the state word of a fresh agent')
    assert.ok(strings.includes(C.lastKnownStateText(locale, 'thinking')), 'a stale status stays a last known one')
    assert.ok(strings.includes(C.silenceText(locale, { kind: 'permission', ms: 10 * 60_000 - 0 }, 'waiting_permission')), 'a pending permission is told apart')
    assert.ok(strings.includes(MESSAGES[locale]['sessions.agent.closed'].replace('{rest}', C.lastKnownStateText(locale, 'error'))), 'a closed agent keeps its last known state')
    assert.ok(strings.includes('Read'), 'the tool is data, shown as it came')
    // The canvas draws the English word under each agent: in French the row quotes it in lang=en, then glosses it
    const quoted = Array.from(dialog.querySelectorAll('[data-drawn-state]')).map(e => ({ text: e.textContent, lang: e.getAttribute('lang'), exempt: e.hasAttribute('data-i18n-exempt') }))
    if (locale === 'fr') {
      assert.deepEqual([...new Set(quoted.map(q => q.text))].sort(), ['error', 'thinking', 'waiting'].sort())
      for (const q of quoted) assert.deepEqual([q.lang, q.exempt], ['en', true])
    } else {
      assert.deepEqual(quoted, [], 'in English the row already says the drawn word')
    }
    // Everything still English declares it
    for (const e of Array.from(dialog.querySelectorAll('[data-i18n-exempt]'))) assert.equal(e.getAttribute('lang'), 'en', 'an exempt subtree declares lang=en')
    // No column cell is left declared English as a whole: only a passage of a different language is
    assert.equal(dialog.querySelectorAll('[data-column="model"][lang="en"]').length, 0, 'the model column follows the page language')
    const activityCells = Array.from(dialog.querySelectorAll('[data-column="activity"]'))
    assert.ok(activityCells.length > 0)
    for (const c of activityCells) assert.equal(langOf(c), locale, 'the activity column name follows the language')
  })

  test(`the announcement of agents that stop reporting speaks only ${locale}`, () => {
    setLocaleChoice(locale)
    let now = NOW
    const listeners = new Set<() => void>()
    const fake = { getNow: () => now, subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } } }
    const mk = (id: string, extra: object = {}) => [id, { id, name: id, state: 'thinking', lastEventAt: NOW, ...extra }] as const
    const agents = new Map([mk('Planner'), mk('Scribe'), mk('Checker'), mk('Reader')])
    const view = render(<FreshnessAnnouncer agents={agents} clock={fake} />)
    const region = view.getByRole('status')
    assert.equal(region.textContent, '', 'the baseline is not announced')
    assert.equal(region.getAttribute('lang'), locale, 'the announcement declares its language')
    // One agent now has its status from a replayed history: it did not stop reporting, a history was received
    view.rerender(<FreshnessAnnouncer agents={new Map([...agents, mk('Reader', { freshnessSource: 'history' })])} clock={fake} />)
    const history = MESSAGES[locale]['freshness.announce.history.one'].replace('{names}', 'Reader') + '.'
    assert.equal(region.textContent, history, 'a history received is not a stop in reporting')
    now += 31_000
    act(() => { for (const l of [...listeners]) l() })
    const text = region.textContent ?? ''
    const stale = MESSAGES[locale]['freshness.announce.stale.other'].replace('{names}', 'Planner, Scribe, Checker') + '.'
    assert.equal(text, stale)
    view.rerender(<FreshnessAnnouncer agents={new Map([...agents].map(([id, a]) => [id, { ...a, state: id === 'Scribe' ? 'complete' : a.state }]))} clock={fake} />)
    assert.equal(region.textContent, MESSAGES[locale]['freshness.announce.closed.one'].replace('{names}', 'Scribe') + '.', 'a closed agent is announced as closed')
    assert.deepEqual(foreignWords(locale, [text, history, region.textContent ?? ''].map(x => x.replace(/Planner|Scribe|Checker|Reader/g, ''))), [])
  })
}

// ---- The command palette and the legend (#503) ----

// What only the two palette and legend tests allow (a module-level addition would widen the net of the tests above):
// key caps are symbols, "+3" is the figure of the legend's folded-branch badge icon, "Actions", "Sessions" and "Agents" are the
// same word in both languages (they stay in code), and the rest is data of the fixtures below (names, branches).
const LOCAL_ALLOW: ReadonlySet<string> = new Set(['F', 'Z', 'G', 'M', 'V', '?', 'L', 'C', 'T', 'P', 'Y', 'S', '$', '+3', 'Actions', 'Sessions', 'Agents',
  'payments-api', 'web-app', 'imported-run', 'indexed-run', 'main-agent', 'reviewer', 'helper', 'alpha', 'feat/refund', 'session payments-api', 'squad', 'crew', 'workflow-run', 'idle-flow', 'solo-flow',
  // The tour label comes from the tour: in French it sits in an exempt lang=en span, in English it is simply the page's language
  'Tour this session',
  ':'])
// A detail is a list of facts ("Claude Code, alpha, vue actuelle", "1 en attente / 2 erreurs"): each fact is checked
const LOCAL_DATA: readonly RegExp[] = [/^workflow, \d+ agents?$/]
const listed = (locale: Locale, strings: string[]) => strangers(locale, strings, { allow: LOCAL_ALLOW, data: LOCAL_DATA })
  .filter(s => !((s.includes(', ') || s.includes(' / ')) && strangers(locale, s.split(/, | \/ /), { allow: LOCAL_ALLOW, data: LOCAL_DATA }).length === 0))

const paletteSessions: SessionInfo[] = [
  { id: 's1', label: 'payments-api', status: 'active', startTime: 0, lastActivityTime: 1, runtime: 'claude', projectName: 'alpha', branch: 'feat/refund' },
  { id: 's2', label: 'web-app', status: 'completed', startTime: 0, lastActivityTime: 1 },
  { id: 's3', label: 'imported-run', status: 'active', startTime: 0, lastActivityTime: 1, imported: true },
  { id: 's4', label: 'indexed-run', status: 'active', startTime: 0, lastActivityTime: 1, indexedOnly: true },
]

function paletteItemsFor(locale: Locale) {
  const src: PaletteSource = {
    locale, singleKeyEnabled: true, selectedSessionId: 's1', sessions: paletteSessions, launchAvailable: true,
    agents: [
      { id: 's1:main', name: 'main-agent', sessionId: 's1', sessionLabel: 'payments-api', isMain: true, role: 'ui-designer' },
      { id: 's1:r', name: 'reviewer', sessionId: 's1', sessionLabel: 'payments-api', kind: 'teammate' },
      { id: 's1:h', name: 'helper', sessionId: 's1', sessionLabel: 'payments-api', kind: 'subagent' },
    ],
    actions: {
      togglePlayPause: noop, zoomToFit: noop, toggleFullscreen: noop, toggleHexGrid: noop, toggleMute: noop, openShortcuts: noop, openSettings: noop,
      togglePresentation: noop, clearHistory: noop, exportSession: noop,
    },
    attention: { detail: sessionAttentionLabel(locale, { waiting: 1, errors: 2 }) ?? '', movesFocus: false, run: noop },
    notifications: { on: true, run: noop },
    tour: { label: 'Tour this session', run: noop },
    themes: { current: 'neon', options: [{ id: 'neon', label: 'Neon' }, { id: 'contrast', label: MESSAGES[locale]['theme.contrast'], alias: 'High contrast' }], set: noop },
    togglePanel: noop, selectSession: noop, selectAgent: noop,
  }
  return buildPaletteItems(src)
}

for (const locale of LOCALES) {
  test(`the command palette (every group, detail, status line and search) speaks only ${locale}`, () => {
    setLocaleChoice(locale)
    const strings: string[] = []
    const view = render(<CommandPalette open onClose={noop} items={paletteItemsFor(locale)} />)
    const dialog = view.getByRole('dialog', { name: MESSAGES[locale]['palette.title'] })
    assert.equal(langOf(dialog), locale, `the palette declares lang=${locale}`)
    const scan = () => strings.push(...surfaceStrings(view.container))
    const input = view.getByRole('combobox', { name: MESSAGES[locale]['palette.search'] })
    scan()
    // Nothing found, one result, and a search by the other language's name
    for (const q of ['zzzz', 'neon']) { fireEvent.change(input, { target: { value: q } }); scan() }
    if (locale === 'fr') {
      fireEvent.change(input, { target: { value: 'full screen' } })
      assert.ok(view.getByRole('option', { name: /plein écran/ }), 'the English name finds the command in French')
    }
    // The tour label comes from the tour (English): it declares its own language
    fireEvent.change(input, { target: { value: 'Tour this' } })
    const tour =view.getAllByRole('option').find(o => (o.textContent ?? '').includes('Tour this session'))!
    assert.equal(langOf(tour.querySelector('span[lang]') ?? tour), 'en')
    if (locale === 'fr') assert.ok(tour.querySelector('span[lang][data-i18n-exempt]'), 'the tour label is left out of the check by data-i18n-exempt')
    if (locale === 'fr') assert.equal(tour.querySelector('[lang]')?.getAttribute('lang'), 'en')

    for (const key of ['palette.title', 'palette.hint', 'palette.group.panels', 'palette.group.themes', 'palette.none', 'palette.count.one', 'palette.currentView', 'palette.theme.current'] as MessageKey[]) {
      // A detail sits inside a list of facts ("alpha, vue actuelle"): the words only have to be there
      const shape = new RegExp(MESSAGES[locale][key].split(/\{\w+\}/).map(escapeRe).join('.+'))
      assert.ok(strings.some(x => shape.test(x)), `${key} was rendered`)
    }
    assert.ok(strings.includes(MESSAGES[locale]['palette.key.shiftF']), 'the Shift+F key cap is in the language')
    assert.ok(strings.some(x => x === MESSAGES[locale]['palette.panel.toggle'].replace('{name}', locale === 'fr' ? 'Fichiers' : 'Files')), 'the Files panel is named in the language')
    assert.ok(strings.length > 60, 'the palette was rendered')
    assert.deepEqual(foreignWords(locale, strings, LOCAL_ALLOW), [])
    assert.deepEqual([...new Set(listed(locale, strings))], [])
  })

  test(`the legend (every entry, the on-screen count, the complete reference) speaks only ${locale}`, () => {
    setLocaleChoice(locale)
    const legendTeams = [
      { key: 'a', name: 'squad', color: '#ffffff', teamKind: 'team', memberNames: ['x'] },
      { key: 'b', name: 'crew', color: '#eeeeee', teamKind: 'team', memberNames: ['x', 'y'] },
      { key: 'c', name: 'workflow-run', color: '#dddddd', teamKind: 'workflow', memberNames: ['x', 'y', 'z'] },
      { key: 'd', name: 'idle-flow', color: '#cccccc', teamKind: 'workflow', memberNames: [] },
      { key: 'e', name: 'solo-flow', color: '#bbbbbb', teamKind: 'workflow', memberNames: ['x'] },
    ] as never
    const bridge = { legendOpen: false, canvasToScreenRef: { current: null }, startTour: noop, startTourLabel: 'Guided tour' }
    const strings: string[] = []
    const show = (present?: readonly (typeof LEGEND_ENTRY_IDS)[number][]) => {
      const view = render(<TourBridgeContext.Provider value={bridge}><GraphLegend teams={legendTeams} present={present} locale={locale} /></TourBridgeContext.Provider>)
      const toggle = view.getByRole('button', { name: new RegExp(MESSAGES[locale]['legend.name']) })
      // The open state is saved between renders: click only when it is closed
      if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle)
      const region = view.getByRole('region', { name: MESSAGES[locale]['legend.region'] })
      assert.equal(langOf(region), locale, `the legend declares lang=${locale}`)
      assert.equal(region.closest('[data-i18n-exempt]'), null, 'the legend is no longer exempt')
      strings.push(...surfaceStrings(view.container))
      // The guided tour is not translated: its button says so
      const tourButton = view.getByRole('button', { name: 'Guided tour' })
      assert.equal(langOf(tourButton), 'en')
      assert.ok(tourButton.hasAttribute('data-i18n-exempt'), 'the tour button is left out of the check by data-i18n-exempt')
      return { view, region }
    }
    // Every entry
    const all = show()
    assert.equal(new Set([...all.region.querySelectorAll('[data-legend-entry]')].map(e => e.getAttribute('data-legend-entry'))).size, LEGEND_ENTRY_IDS.length, 'every entry is listed')
    cleanup()
    // Entries on screen: the count, then the complete reference, one symbol, none
    const some = show(['state-idle', 'shape-main'])
    fireEvent.click(some.view.getByRole('button', { name: MESSAGES[locale]['legend.showAll'] }))
    strings.push(...surfaceStrings(some.view.container))
    cleanup()
    show(['state-idle'])
    cleanup()
    show([])
    cleanup()

    const T = (key: MessageKey, params?: Record<string, string | number>) => translate(locale, key, params)
    for (const x of [
      T('legend.onScreen.other', { n: 2 }), T('legend.complete', { n: LEGEND_ENTRY_IDS.length }), T('legend.none'), T('legend.footer'), T('legend.ctxTokens'), T('legend.section.states'),
      T('legend.mark-loop', { repeat: REPEAT_THRESHOLD, cycle: CYCLE_THRESHOLD }), T('legend.mark-repeated', { rule: T('legend.repeatRule') }),
      T('legend.state.waiting_permission.long'), T('card.contextWindow'), T('learnMore.text'), T('legend.name'),
    ]) assert.ok(strings.includes(x), `"${x}" was rendered`)
    assert.ok(strings.includes(T('legend.onScreen.one', { n: 1 })), 'one symbol: singular')
    assert.ok(strings.includes(T('count.member.one', { n: 1 })), 'a one-member team')
    assert.ok(strings.includes('workflow, 3 agents'), 'a workflow counts its agents')
    // A workflow counts its agents with the rule of the language: French counts 0 and 1 as singular
    assert.ok(strings.includes(`workflow, ${T('count.agent.one', { n: 1 })}`), 'one agent: singular')
    assert.ok(strings.includes(`workflow, ${T(locale === 'fr' ? 'count.agent.one' : 'count.agent.other', { n: 0 })}`), 'no agent: the rule of the language')
    // WCAG 1.4.1 / 1.3.3: the canvas draws the English state word under each agent. The legend, the text equivalent of the colour,
    // quotes that word as drawn (lang=en) and glosses it in the language of the page
    for (const [id, state] of [['state-complete', 'complete'], ['state-waiting_permission', 'waiting_permission'], ['state-tool_calling', 'tool_calling']] as const) {
      const row = all.region.querySelector(`[data-legend-entry="${id}"]`)!
      const drawn = [...row.querySelectorAll('[lang="en"]')].map(e => e.textContent)
      if (locale === 'fr') {
        assert.deepEqual(drawn, [STATE_LABEL_SHORT[state]], `${id}: the drawn word is quoted in an element lang=en`)
        assert.ok((row.textContent ?? '').includes(T(`legend.state.${state}.long` as MessageKey)), `${id}: and glossed in French`)
      }
    }
    if (locale === 'fr') assert.ok([...all.region.querySelector('[data-legend-entry="state-complete"]')!.querySelectorAll('[lang="en"]')].some(e => e.textContent === 'done'), 'state-complete contains "done" in a lang=en element')
    assert.ok(strings.length > 150, 'the legend was rendered')
    assert.deepEqual(foreignWords(locale, strings, LOCAL_ALLOW), [])
    assert.deepEqual([...new Set(listed(locale, strings))], [])
  })
}

// ---- The whole top bar (#500, #501) ----

const barNoop = () => {}
const barBase: TopBarProps = {
  sessions: [{ id: 's1', label: 'alpha-run', status: 'active', startTime: 1, lastActivityTime: 2 }],
  selectedSessionId: ALL_SESSIONS_ID, sessionsWithActivity: new Set(['other']),
  showSessions: false, onToggleSessions: barNoop, isVSCode: false, connectionStatus: 'connected',
  activeAgentCount: 2, staleAgentCount: 1, idleAgentCount: 1, errorAgentCount: 1, doneAgentCount: 3, totalTokens: 1200, totalCost: 1, unattributedCost: 0.5,
  showFileAttention: false, showConversation: false, showCostOverlay: false, showTimeline: false, isMuted: false,
  onTogglePanel: barNoop, onToggleTimeline: barNoop, onToggleStats: barNoop, showStats: false, onToggleMute: barNoop, onOpenShortcuts: barNoop,
  onToggleHideInactive: barNoop, onOpenSettings: barNoop, onToggleFullscreen: barNoop, onOpenPalette: barNoop, notifyState: 'off', onToggleNotify: barNoop,
  onToggleShowFinished: barNoop, finishedSessionCount: 2, hideInactive: true,
  attention: { waiting: 1, errors: 2 }, onJumpToAttention: barNoop,
}
const barScope = parseRelayScopeState({
  relayVersion: '1', workspace: '/home/me/code/alpha', runtimes: ['claude'], hooksConfigured: true, disable1MContext: false,
  sessionCount: 1, allWorkspaces: false, skippedSessions: { watchLimit: 1, sizeLimit: 2, fileLimit: 2 },
  discovery: { projectDirsCapped: false, maxProjectDirs: 200, maxFilesPerDir: 500 },
})!

for (const locale of LOCALES) {
  test(`the whole top bar (every state, folded or not) speaks only ${locale}`, () => {
    setLocaleChoice(locale)
    const T = (key: MessageKey, params?: Record<string, string | number>) => translate(locale, key, params)
    const strings: string[] = []
    const keep = (props: Partial<TopBarProps>) => {
      const view = render(<TopBar {...barBase} {...props} />)
      const header = view.container.querySelector('header') as HTMLElement
      assert.equal(langOf(header), locale, `the bar declares lang=${locale}`)
      strings.push(...surfaceStrings(header))
      // What the relay wrote in English declares it
      for (const e of Array.from(header.querySelectorAll('[data-i18n-exempt]'))) assert.equal(e.getAttribute('lang'), 'en', 'an exempt subtree declares lang=en')
      cleanup()
    }
    // Wide: every filter, an attention counter, a scope with its ceilings, every connection state
    keep({ scope: { state: { ...barScope, runtimeProblems: [{ runtime: 'opencode', message: 'OpenCode: database not found.' }] }, sessions: [{ id: 'a', label: 'a', status: 'active', startTime: 0, lastActivityTime: 1, projectId: 'p', projectName: 'Alpha' }] as never, projectId: null, pending: false, error: 'The relay refused the change of scope (500)', onChoose: barNoop } })
    keep({ connectionStatus: 'watching', selectedSessionId: 's1', showFinished: true })
    keep({ connectionStatus: 'connecting', attention: { waiting: 0, errors: 1 }, notifyState: 'denied', isMuted: true })
    keep({ connectionStatus: 'disconnected', connectionDetail: reconnectDetail(2, 10_000), onRetryConnection: barNoop })
    keep({ connectionStatus: 'disconnected', connectionDetail: 'proxy refused', onRetryConnection: barNoop })
    keep({ isDemo: true, onExitDemo: barNoop, isVSCode: true, notifyState: 'on' })
    keep({ selectedSessionId: 'team:alpha', attention: { waiting: 2, errors: 0 } })
    // Folded under 1024 px, then under 768 px: More names the filters that are on
    setMobileView(true)
    keep({})
    keep({ hideInactive: false, finishedSessionCount: 0 })
    setMobileView(false)

    for (const x of [
      T('topbar.sessions.button', { label: T('sessions.allSessions') }), T('topbar.sessions.title'), T('topbar.sessions.newActivity'), T('topbar.sessions.unobserved.one', { n: 1 }),
      T('topbar.attention.waiting.one', { n: 1 }) + ' / ' + T('topbar.attention.error.other', { n: 2 }),
      T('topbar.attention.title.many'),
      T('topbar.connection.watching'), T('topbar.connection.connecting'), T('topbar.connection.offline'), T('topbar.connection.demo'), T('topbar.connection.retry'), T('topbar.connection.exitDemo'),
      T('topbar.connection.reconnecting', { attempt: 2, seconds: 10 }),
      T('topbar.finished.label', { n: 2 }), T('topbar.finished.title'),
      T('topbar.more'), T('topbar.more.help'), T('topbar.more.withFilters.other', { n: 2 }),
      T('topbar.toolbar'), T('topbar.sidePanels'), T('topbar.context.vscode'),
      T('scope.group'), T('scope.select'), T('scope.title'), T('scope.option.workspace'), T('scope.option.all'), T('scope.summary', { name: 'alpha' }),
    ]) assert.ok(strings.includes(x), `"${x}" was rendered`)
    assert.ok(strings.some(s => s.endsWith(T('topbar.attention.answerWhere'))), 'the tooltip says where a permission is answered')
    assert.ok(strings.some(s => s.includes(T('scope.notice.fileLimit.other', { n: 2, max: 500 }))), 'the ceilings are worded in the language')
    assert.ok(strings.length > 60, 'the bar was rendered')

    // Not catalog values on their own: the panel labels drawn without their shortcut, the symbols, the lists of figures read aloud
    const panelLabels = (['files', 'conversation', 'context', 'system', 'cost', 'timeline', 'stats'] as const).map(p => T(`topbar.panel.${p}.name` as MessageKey).replace(/ \([A-Z]\)$/, ''))
    const spokenCost = new RegExp(`^${escapeRe(T('topbar.context.costName'))} [\\p{L}\\p{N}.,:;$<>·()' -]+$`, 'u')
    const spokenUnattributed = new RegExp(`^${escapeRe(T('topbar.context.unattributed', { cost: '$0.500' }))}$`)
    // The text read aloud joins catalog values with ", ", " - " and " : " (a figure follows its words)
    const spokenLine = (s: string) => /, /.test(s) && s.split(', ').every(part =>
      strangers(locale, part.split(' - ').flatMap(x => (strangers(locale, [x], { data: [spokenCost, spokenUnattributed] }).length === 0 ? [x] : x.split(' : '))), { data: [spokenCost, spokenUnattributed] }).length === 0)
    // Names of the fixtures (a session, a project): data as it came
    const fixtureNames = new Set(['alpha-run', 'alpha', 'Alpha', 'a', 'proxy refused'])
    const unknown = strangers(locale, strings, { allow: new Set([...panelLabels, '?', ...fixtureNames]), data: [spokenCost, spokenUnattributed] }).filter(s => !spokenLine(s))
    assert.deepEqual(unknown, [])
    assert.deepEqual(foreignWords(locale, strings.filter(s => !s.includes('OpenCode') && !s.includes('The relay refused') && s !== 'proxy refused'), new Set(['alpha-run'])), [])
  })
}
