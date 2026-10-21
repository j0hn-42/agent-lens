// #373: a surface covered by the message catalog never mixes the two languages. For each locale, the surfaces
// already translated (Settings tab by tab, the canvas controls and their View panel, the agent card, the Sessions panel, the
// command palette, the legend, the guided tour, the panel titles, the whole top bar and the Conversation, Files and
// Context panels) are rendered and every visible
// text, accessible name, tooltip and description must be a value of that locale's catalog (placeholders filled in)
// or an entry of an explicit allowlist (proper names, symbols). A subtree marked data-i18n-exempt (it carries its own
// lang) is left out. The Timeline panel is rendered here too, with no exemption of its own. The words the canvas draws for the
// Cost and Stats overlays are out of this test on purpose: see docs/reading-the-ui/language.md. Control by control, the top bar also has
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
import { emptySnapshot, evaluateTriggers } from '@/lib/notification-rules'
import { STATE_LABEL_SHORT } from '@/lib/canvas-constants'
import { drawnStatusText } from '@/components/agent-visualizer/canvas/team-style'
import { LEGEND_ENTRY_IDS } from '@/lib/legend-entries'
import { REPEAT_THRESHOLD, CYCLE_THRESHOLD } from '@/lib/loop-detection'
import { DEFAULT_CALM_LAYERS } from '@/lib/motion-layers'
import * as C from '@/lib/card-text'
import { viewCountsText } from '@/lib/chrome-utils'
import { PANEL_NAMES } from '@/lib/ui-glossary'
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
import { GuidedTourCard } from '@/components/agent-visualizer/guided-tour-card'
import { TourOffer } from '@/components/agent-visualizer/tour-offer'
import { SystemPanel } from '@/components/agent-visualizer/system-panel'
import { TimelinePanel } from '@/components/agent-visualizer/timeline-panel'
import { FileAttentionPanel } from '@/components/agent-visualizer/file-attention-panel'
import { ProjectContextPanel } from '@/components/agent-visualizer/project-context-panel'
import { guidedSteps } from '@/lib/guided-steps'
import { buildLiveTourSteps } from '@/lib/live-tour'
import { panelName } from '@/lib/command-palette'
import { ControlBar } from '@/components/agent-visualizer/control-bar'
import { GlassContextMenu } from '@/components/agent-visualizer/glass-context-menu'
import { contextMenuItems } from '@/components/agent-visualizer/context-menu-items'
import { ShortcutsDialog } from '@/components/agent-visualizer/shortcuts-dialog'
import { SHORTCUTS } from '@/lib/shortcuts'
import { shortcutKeyCap } from '@/lib/shortcuts-text'
import { ConversationHarness, createPanelRegistry } from './conversation-harness'
import { clearPair, setPair } from '@/lib/pair-filter-store'
import type { Agent, FileAttention, TimelineBlock, TimelineEntry } from '@/lib/agent-types'
import type { AgentLink } from '@/hooks/simulation/types'
import { SCENE } from '@/lib/colors'
import { emptyWasteLedger, recordToolStart, recordToolEnd, type WasteLedger } from '@/lib/waste'
import type { ProjectContextData } from '@/lib/project-context'
import type { SessionCapabilities } from '@/lib/session-capabilities'
import type { ResumableSession } from '@/lib/resume-command'
import type { ConversationMessage } from '@/hooks/simulation/types'

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
    // A placeholder stands for data or a figure: a word, a number, a time ("1:02"), a phrase built from other catalog values.
    // "&" is accepted only inside the panel name "Files & repeats" (#518), not in any parameter (#613)
    // A value written with a leading or trailing space (a part joined to another) is matched as the text node renders, trimmed
    const placeholder = `(?:[\\p{L}\\p{N}.,:;#/+≥×%·()<$'’ _—~*-]|${escapeRe(PANEL_NAMES.files)})+`
    const body = v.trim().split(/\{\w+\}/).map(escapeRe).join(placeholder)
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

test('control: a placeholder accepts "&" only inside the Files & repeats name, not in any parameter (#613)', () => {
  assert.deepEqual(strangers('en', [`Open ${PANEL_NAMES.files}`]), [])
  assert.deepEqual(strangers('en', ['Open a & b']), ['Open a & b'])
})

/** The nearest declared language of an element. */
const langOf = (el: Element) => el.closest('[lang]')?.getAttribute('lang')

const noop = () => {}
const settingsProps = (state: NotifyState): SettingsDialogProps => ({
  open: true, onClose: noop,
  hexGrid: true, onHexGridChange: noop,
  muted: false, onToggleMute: noop,
  showMode: 'active', onShowModeChange: noop,
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
  sessions: ['settings.section.sessions', 'settings.section.presentation', 'settings.presentation.help', 'settings.presentation.subtitles.help', 'settings.presentation.mask.help', 'settings.presentation.follow.help'],
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
// draws from its gloss; the dash is the sign of "no data". The relative time of the activity column and the Σ totals are in the
// catalog's language too (#501): nothing in the panel is exempt but the quoted state word.
const COLUMN_DATA: readonly RegExp[] = [/^[≥~]*[\d.]+[kM]?$/, /^≥?\d+[dhms]( \d+[hms])?\+?$/, /^[≥~]*<?\$[\d.]+$/, /^\d+ h \d+ min$/, /^\d+ min$/]
const columnAllow = (_locale: Locale): ReadonlySet<string> => new Set([':', '—', ','])
/** The money placeholder of the cost sentences may hold "<$0.0001" */
/** A Σ total: figures as drawn, then the catalog's own words for "estimated" and "incomplete" (#501) */
const rollupShape = (locale: Locale) => new RegExp(`^~\\$[\\d.]+ · [\\d.]+[kM]?( ${escapeRe(MESSAGES[locale]['rollup.estimated'])})?( ${escapeRe(MESSAGES[locale]['rollup.incomplete'])})?$`)
const panelStrangers = (locale: Locale, strings: string[]) => strangers(locale, strings, { allow: columnAllow(locale), data: [...COLUMN_DATA, rollupShape(locale)] })

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

for (const d of ['Planner', 'Scribe', 'Checker', 'Runner', 'Reader', 'Fixer', 'Tester', 'Idler', 'Closer', 'ui-designer']) FIXTURE_DATA.add(d)

const PANEL_NOW = NOW
/**
 * One agent row per way the row can speak: fresh, a tool, last known, silent for a permission, closed after an error, a
 * sub-agent, a teammate at work, a teammate whose reported activity differs from its state, a finished agent.
 */
const columnAgents: SessionListAgent[] = [
  { ...panelAgent('a:p', 'a', 'thinking', 'Planner'), kind: 'main', model: 'claude-opus-4-5-20251101', tokensUsed: 12_400, tokenStatus: 'partial', tokensEstimated: true, activeMs: 95_000, lastEventAt: PANEL_NOW, spawnTime: 1 },
  { ...panelAgent('a:s', 'a', 'thinking', 'Scribe'), kind: 'subagent', parentKey: 'a:p', tokensUsed: 800, lastEventAt: PANEL_NOW, spawnTime: 2 },
  { ...panelAgent('a:r', 'a', 'tool_calling', 'Runner'), kind: 'subagent', parentKey: 'a:p', currentTool: 'Read', lastEventAt: PANEL_NOW, spawnTime: 3 },
  { ...panelAgent('a:c', 'a', 'thinking', 'Checker'), kind: 'teammate', lastEventAt: PANEL_NOW - 60_000, spawnTime: 4 },
  { ...panelAgent('a:w', 'a', 'waiting_permission', 'Reader'), lastEventAt: PANEL_NOW - 10 * 60_000, spawnTime: 5 },
  { ...panelAgent('a:e', 'a', 'error', 'Fixer'), lastEventAt: PANEL_NOW - 3 * 60_000, spawnTime: 6 },
  { ...panelAgent('a:t', 'a', 'thinking', 'Tester'), kind: 'teammate', activity: 'working', lastEventAt: PANEL_NOW, spawnTime: 7 },
  { ...panelAgent('a:i', 'a', 'thinking', 'Idler'), kind: 'teammate', activity: 'idle', lastEventAt: PANEL_NOW, spawnTime: 8 },
  { ...panelAgent('a:d', 'a', 'complete', 'Closer'), lastEventAt: PANEL_NOW, spawnTime: 9 },
]
const columnSessions: SessionInfo[] = [
  { id: 'a', label: 'fix login', status: 'active', startTime: 0, lastActivityTime: 3_000, runtime: 'claude', projectId: 'pa', projectName: 'alpha', branch: 'main', startTimeWatched: true },
  { id: 'e', label: 'scratch', status: 'active', startTime: 0, lastActivityTime: 0, lastActivityUnknown: true, runtime: 'codex', imported: true },
]
const columnsPanel = () => (
  <SessionListPanel
    visible onClose={noop} sessions={columnSessions} selectedSessionId="__all__" sessionsWithActivity={new Set()}
    onSelectSession={noop} onCloseSession={noop} agents={new Map(columnAgents.map(a => [a.id, a]))} selectedAgentId={null} onSelectAgent={noop}
    now={5000} activeOnly={false} observedSessionIds={new Set(['a'])} agentCounts={{ active: 2, done: 1, stale: 3, idle: 0, error: 1 }} freshnessClock={createFreshnessClock({ now: () => PANEL_NOW, isHidden: () => true })}
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
    // The Σ totals and the relative time are worded in the language, with their qualifiers (#501)
    assert.ok(strings.some(x => x.includes(MESSAGES[locale]['rollup.session'])), 'the session total is named')
    assert.ok(strings.some(x => /^[~≥]?\$/.test(x) && (x.includes(MESSAGES[locale]['rollup.estimated']) || x.includes(MESSAGES[locale]['rollup.incomplete']))), 'a Σ total keeps its qualifier')
    assert.ok(strings.some(x => x.includes(C.relativeTimeText(locale, 3_000, 5_000))), 'the activity column says how long ago')
    const counts = dialog.querySelector('[data-testid="sessions-agent-counts"]')
    assert.ok(counts, 'the agent counts were rendered')
    assert.equal(counts.closest('[lang]')?.getAttribute('lang'), locale, 'the agent counts sit in the language of the interface, no passage is marked English')
    assert.ok(strings.includes(viewCountsText({ active: 2, done: 1, stale: 3, idle: 0, error: 1 }, 2, locale).spoken), 'the full wording of the counts is read')
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
      // One row per kind of agent: the quoted word is the one the canvas draws under that node (drawnStatusText, which
      // draw-agents.ts draws: freshness.test.tsx), then the French gloss of that same word follows
      const expected: Array<[string, string | null, string?]> = [
        ['a:p', 'thinking', 'Réflexion'], // fresh main agent
        ['a:s', 'thinking', 'Réflexion'], // fresh sub-agent
        ['a:r', null], // a tool: the row shows the tool, no state word quoted
        ['a:c', 'last known state: Thinking', 'dernier état connu : Réflexion'], // teammate, stale for 60 s
        ['a:w', 'last known state: Waiting for permission', 'en attente d’autorisation depuis 10 min'], // agent silent for 10 min on a permission
        ['a:e', 'error', 'fermé, dernier état connu : Erreur'], // closed after an error
        ['a:t', 'working', 'Au travail'], // teammate at work: its activity is drawn, and glossed
        ['a:i', 'idle', 'Inactif'], // teammate reported idle while its state still says thinking: never "idle : Réflexion"
        ['a:d', 'done', 'Terminé'], // finished agent
      ]
      for (const [id, word, gloss] of expected) {
        const agent = columnAgents.find(a => a.id === id)!
        const row = dialog.querySelector(`[data-row-key="agent:${id}"]`)!
        const span = row.querySelector('[data-drawn-state]')
        if (word === null) { assert.equal(span, null, `${id}: no state word quoted next to a tool`); continue }
        assert.equal(drawnStatusText(agent, PANEL_NOW), word, `${id}: precondition, the canvas draws "${word}"`)
        assert.equal(span?.textContent, word, `${id}: the row quotes the word drawn under the node`)
        const cell = span!.parentElement!
        assert.equal(cell.textContent, `${word} : ${gloss}`, `${id}: then glosses that word in French`)
        // Never cut, so no tooltip to repeat it: a tooltip would mix the English quote into a French attribute that
        // cannot declare its own language, and reaches neither the keyboard nor touch (the e2e reflow test checks the cut)
        assert.equal(cell.hasAttribute('title'), false, `${id}: the cell wraps, it carries no tooltip`)
        assert.equal(cell.classList.contains('truncate'), false, `${id}: the quote and its gloss are never cut by an ellipsis`)
      }
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
    tour: { label: MESSAGES[locale]['tour.button.session'], run: noop },
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
    // The tour label is the catalog one (#557): no language of its own, nothing left out of the check
    fireEvent.change(input, { target: { value: MESSAGES[locale]['tour.button.session'].split(' ')[0] } })
    const tour = view.getAllByRole('option').find(o => (o.textContent ?? '').includes(MESSAGES[locale]['tour.button.session']))!
    assert.ok(tour, 'the tour command is listed')
    assert.equal(tour.querySelector('[lang]'), null, 'the tour label declares no language of its own')
    assert.equal(tour.querySelector('[data-i18n-exempt]'), null, 'the tour label is no longer exempt')
    scan()

    for (const key of ['palette.title', 'palette.hint', 'palette.group.panels', 'palette.group.themes', 'palette.none', 'palette.count.one', 'palette.currentView', 'palette.theme.current'] as MessageKey[]) {
      // A detail sits inside a list of facts ("alpha, vue actuelle"): the words only have to be there
      const shape = new RegExp(MESSAGES[locale][key].split(/\{\w+\}/).map(escapeRe).join('.+'))
      assert.ok(strings.some(x => shape.test(x)), `${key} was rendered`)
    }
    assert.ok(strings.includes(MESSAGES[locale]['palette.key.shiftF']), 'the Shift+F key cap is in the language')
    assert.ok(strings.some(x => x === MESSAGES[locale]['palette.panel.toggle'].replace('{name}', MESSAGES[locale]['palette.panelName.files'])), 'the Files panel is named in the language')
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
    const bridge = { legendOpen: false, canvasToScreenRef: { current: null }, startTour: noop, startTourLabel: MESSAGES[locale]['tour.button.demo'] }
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
      // The tour button (#557) is in the language of the legend and checked like the rest
      const tourButton = view.getByRole('button', { name: MESSAGES[locale]['tour.button.demo'] })
      assert.equal(langOf(tourButton), locale)
      assert.equal(tourButton.closest('[data-i18n-exempt]'), null, 'the tour button is no longer exempt')
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
  activeAgentCount: 2, staleAgentCount: 1, idleAgentCount: 1, errorAgentCount: 1, doneAgentCount: 3, totalTokens: 1_200_000, totalCost: 1, unattributedTokens: 900_000, unattributedCost: 0.5,
  showFileAttention: false, showConversation: false, showCostOverlay: false, showTimeline: false, isMuted: false,
  onTogglePanel: barNoop, onToggleTimeline: barNoop, onToggleStats: barNoop, showStats: false, onToggleMute: barNoop, onOpenShortcuts: barNoop,
  onChangeShowMode: barNoop, onOpenSettings: barNoop, onToggleFullscreen: barNoop, onOpenPalette: barNoop, notifyState: 'off', onToggleNotify: barNoop,
  showMode: 'active',
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
    keep({ connectionStatus: 'watching', selectedSessionId: 's1', showMode: 'all' })
    keep({ connectionStatus: 'connecting', attention: { waiting: 0, errors: 1 }, notifyState: 'denied', isMuted: true })
    keep({ connectionStatus: 'disconnected', connectionDetail: reconnectDetail(2, 10_000), onRetryConnection: barNoop })
    keep({ connectionStatus: 'disconnected', connectionDetail: 'proxy refused', onRetryConnection: barNoop })
    keep({ isDemo: true, onExitDemo: barNoop, isVSCode: true, notifyState: 'on' })
    keep({ selectedSessionId: 'team:alpha', attention: { waiting: 2, errors: 0 } })
    // Folded under 1024 px, then under 768 px: More names the filters that are on
    setMobileView(true)
    keep({})
    keep({ showMode: 'all' })
    setMobileView(false)

    for (const x of [
      T('topbar.sessions.button', { label: T('sessions.allSessions') }), T('topbar.sessions.title'), T('topbar.sessions.newActivity'), T('topbar.sessions.unobserved.one', { n: 1 }),
      T('topbar.attention.waiting.one', { n: 1 }) + ' / ' + T('topbar.attention.error.other', { n: 2 }),
      T('topbar.attention.title.many'),
      T('topbar.connection.watching'), T('topbar.connection.connecting'), T('topbar.connection.offline'), T('topbar.connection.demo'), T('topbar.connection.retry'), T('topbar.connection.exitDemo'),
      T('topbar.connection.reconnecting', { attempt: 2, seconds: 10 }),
      T('show.hideInactive'), T('show.hideInactive.title.all', { n: 10 }),
      T('topbar.more'), T('topbar.more.help'), T('topbar.more.withFilters.one', { n: 1 }),
      T('topbar.toolbar'), T('topbar.sidePanels'), T('topbar.context.vscode'),
      T('scope.group'), T('scope.select'), T('scope.title'), T('scope.option.workspace'), T('scope.option.all'), T('scope.summary', { name: 'alpha' }),
    ]) assert.ok(strings.includes(x), `"${x}" was rendered`)
    assert.ok(strings.some(s => s.endsWith(T('topbar.attention.answerWhere'))), 'the tooltip says where a permission is answered')
    assert.ok(strings.some(s => s.includes(T('scope.notice.fileLimit.other', { n: 2, max: 500 }))), 'the ceilings are worded in the language')
    assert.ok(strings.length > 60, 'the bar was rendered')

    // Not catalog values on their own: the panel labels drawn without their shortcut, the symbols, the lists of figures read aloud
    const panelLabels = (['files', 'conversation', 'context', 'system', 'cost', 'timeline', 'stats'] as const).map(p => T(`topbar.panel.${p}.name` as MessageKey).replace(/ \([A-Z]\)$/, ''))
    // The spoken cost is the name, then one amount in the exact qualifiers of the language (usage.partial, usage.estimated, both, or none)
    const amount = '<?\\$\\d[\\d.]*'
    const qualifiers = ['{v}', 'usage.partial', 'usage.estimated', 'usage.partialEstimated'].map(k => (k === '{v}' ? k : MESSAGES[locale][k as MessageKey]).split('{v}').map(escapeRe).join(amount))
    const spokenCost = new RegExp(`^${escapeRe(T('topbar.context.costName'))} (?:${qualifiers.join('|')})$`)
    const spokenUnattributed = new RegExp(`^${escapeRe(T('topbar.context.unattributed', { tokens: '900k', cost: '$0.500' }))}$`)
    // The text read aloud joins catalog values with ", ", " - " and " : " (a figure follows its words)
    const spokenLine = (s: string) => /, /.test(s) && s.split(', ').every(part =>
      strangers(locale, part.split(' - ').flatMap(x => (strangers(locale, [x], { data: [spokenCost, spokenUnattributed] }).length === 0 ? [x] : x.split(' : '))), { data: [spokenCost, spokenUnattributed] }).length === 0)
    // Names of the fixtures (a session, a project): data as it came
    const fixtureNames = new Set(['alpha-run', 'alpha', 'Alpha', 'a'])
    // An unknown connection detail is exempt (data-i18n-exempt, lang=en) only on a page that is not in English; in English it is the page's own language, so it is data like the names above
    if (locale === 'en') fixtureNames.add('proxy refused')
    const unknown = strangers(locale, strings, { allow: new Set([...panelLabels, '?', ...fixtureNames]), data: [spokenCost, spokenUnattributed] }).filter(s => !spokenLine(s))
    assert.deepEqual(unknown, [])
    assert.deepEqual(foreignWords(locale, strings.filter(s => !s.includes('OpenCode') && !s.includes('The relay refused') && !fixtureNames.has(s)), new Set(['alpha-run'])), [])
  })
}

// ---- The guided tour and the titles of the panels (#557) ----
// The tour (card, steps, offer, buttons) and the titles of the panels used to be English, declared lang=en and left out of
// this check by data-i18n-exempt. They are in the catalog now: nothing is exempt, and no allowlist is widened here.
// A live step joins several catalog sentences, so its body is checked for foreign function words, not sentence by sentence.
const TOUR_ALL = { entries: [...LEGEND_ENTRY_IDS], agentFor: { 'state-error': 'k' }, labels: { k: 'refactor-api' } }
/** The mode name of a Grep call is a technical identifier (files_with_matches), quoted as the tool spells it */
const withoutIdentifier = (s: string) => s.replace('files_with_matches', '')
const withoutNumber = (s: string) => s.replace(/^\d+\. /, '')

for (const locale of LOCALES) {
  const T = (key: MessageKey, params?: Record<string, string | number>) => translate(locale, key, params)

  test(`the demo tour (every step, the step list, the card buttons) speaks only ${locale}`, () => {
    setLocaleChoice(locale)
    const steps = guidedSteps(locale)
    const strings: string[] = []
    steps.forEach((_, i) => {
      const view = render(<GuidedTourCard steps={steps} index={i} onNext={noop} onPrev={noop} onGoTo={noop} onExit={noop} />)
      const dialog = view.getByRole('dialog')
      assert.equal(langOf(dialog), locale, `the card declares lang=${locale}`)
      assert.equal(dialog.closest('[data-i18n-exempt]'), null, 'the tour is no longer exempt')
      assert.ok(view.getByRole('combobox', { name: T('tour.card.goto') }), 'the step list is named in the language')
      strings.push(...surfaceStrings(view.container))
      cleanup()
    })
    for (const key of ['tour.card.exit', 'tour.card.prev', 'tour.card.next'] as MessageKey[]) assert.ok(strings.includes(T(key)), `${key} was rendered`)
    assert.ok(strings.includes(T('tour.card.step', { n: 2, total: steps.length })), 'the position of a step')
    for (const s of steps) assert.ok(strings.includes(s.title) && strings.includes(s.body), `step ${s.id} was rendered`)
    assert.ok(strings.length > 100)
    assert.deepEqual(foreignWords(locale, strings.map(withoutIdentifier)), [])
    assert.deepEqual([...new Set(strangers(locale, strings.map(withoutNumber)))], [])
  })

  test(`the tour of a real session (every group, the stale notice) speaks only ${locale}`, () => {
    setLocaleChoice(locale)
    const steps = buildLiveTourSteps(TOUR_ALL, locale)
    const strings: string[] = []
    const chrome: string[] = []
    steps.forEach((s, i) => {
      const view = render(<GuidedTourCard steps={steps} index={i} stale={i === 0} onNext={noop} onPrev={noop} onGoTo={noop} onExit={noop} />)
      assert.equal(langOf(view.getByRole('dialog')), locale)
      const here = surfaceStrings(view.container)
      strings.push(...here)
      chrome.push(...here.filter(x => x !== s.body))
      cleanup()
    })
    assert.ok(strings.includes(T('tour.card.stale')), 'the stale notice')
    assert.ok(strings.some(x => x.includes(T('tour.live.highlighted', { label: 'refactor-api' }))), 'the highlighted agent is quoted in the language')
    assert.ok(steps.length >= 15)
    assert.deepEqual(foreignWords(locale, strings.map(withoutIdentifier)), [])
    // Sessions is the same word in both languages (the title of its group has no catalog key)
    assert.deepEqual([...new Set(strangers(locale, chrome.map(withoutNumber), { allow: new Set(['Sessions']) }))], [])
  })

  test(`the tour offer and the tour buttons speak only ${locale}`, () => {
    setLocaleChoice(locale)
    const label = T('tour.button.session')
    const view = render(<TourOffer open label={label} onStart={noop} onDismiss={noop} />)
    const region = view.getByRole('region', { name: T('tour.offer.title') })
    assert.equal(langOf(region), locale, `the offer declares lang=${locale}`)
    assert.equal(region.closest('[data-i18n-exempt]'), null)
    view.getByRole('button', { name: T('tour.offer.start') })
    view.getByRole('button', { name: T('tour.offer.later') })
    const strings = surfaceStrings(view.container)
    const announced = `${T('tour.offer.title')} ${T('tour.offer.body', { label })}`
    assert.ok(strings.includes(announced), 'the live region announces the offer')
    assert.equal(langOf(view.getByRole('status')), locale)
    assert.ok(strings.includes(T('tour.offer.body', { label })))
    assert.deepEqual(foreignWords(locale, strings), [])
    assert.deepEqual([...new Set(strangers(locale, strings.filter(s => s !== announced)))], [])
  })

  test(`the panel titles are the names of the palette and of the top bar, in ${locale}`, () => {
    setLocaleChoice(locale)
    const view = render(<>
      <SystemPanel visible samples={[]} onClose={noop} />
      <TimelinePanel visible timelineEntries={new Map()} currentTime={0} onClose={noop} />
      <FileAttentionPanel visible fileAttention={new Map()} onClose={noop} />
      <ProjectContextPanel visible sessionId={null} unavailableReason="demo" fetchContext={async () => 'unavailable'} onClose={noop} />
    </>)
    const headings = Array.from(view.container.querySelectorAll('h2')).map(h => ({ text: h.textContent, lang: langOf(h.querySelector('[lang]') ?? h) }))
    for (const text of [panelName(locale, 'system'), T('panel.heading.timeline'), T('panel.heading.files'), T('panel.heading.context')]) {
      const h = headings.find(x => x.text?.toLowerCase() === text.toLowerCase())
      assert.ok(h, `a panel is titled ${text}`)
      assert.equal(h.lang, locale, `${text} declares lang=${locale}`)
    }
    // The System panel is named by its heading: the palette says "Système" / "System", the title says the same word
    assert.ok(view.getByRole('region', { name: panelName(locale, 'system') }))
  })

  test(`under 768 px a panel drawer is named like the palette and the top bar name it, in ${locale}`, () => {
    setLocaleChoice(locale)
    setMobileView(true)
    try {
      for (const [id, el] of [
        ['timeline', <TimelinePanel key="t" visible timelineEntries={new Map()} currentTime={0} onClose={noop} />],
        ['files', <FileAttentionPanel key="f" visible fileAttention={new Map()} onClose={noop} />],
        ['context', <ProjectContextPanel key="c" visible sessionId={null} unavailableReason="demo" fetchContext={async () => 'unavailable'} onClose={noop} />],
        ['system', <SystemPanel key="s" visible samples={[]} onClose={noop} />],
      ] as const) {
        const view = render(el)
        const dialog = view.getByRole('dialog', { name: new RegExp(`^${escapeRe(panelName(locale, id))}$`, 'i') })
        assert.ok(dialog.hasAttribute('data-mobile-drawer'), `${id} is a drawer`)
        // WCAG 3.1.2: an aria-label cannot declare its language, so the name comes from an element that does
        const nameId = dialog.getAttribute('aria-labelledby')
        assert.ok(nameId, `${id}: the drawer is named by an element, not by an aria-label`)
        const nameEl = document.getElementById(nameId)
        assert.ok(nameEl, `${id}: the naming element exists`)
        assert.equal(langOf(nameEl.querySelector('[lang]') ?? nameEl), locale, `${id}: the drawer name declares lang=${locale}`)
        assert.equal(dialog.getAttribute('lang'), null, `${id}: the drawer body is not all in ${locale}, so the dialog itself has no lang`)
        const buttonName = MESSAGES[locale][`topbar.panel.${id}.name` as MessageKey].replace(/ \([A-Z]\)$/, '')
        assert.equal(panelName(locale, id), buttonName, `${id}: the drawer, the palette and the top bar button agree`)
        cleanup()
      }
    } finally { setMobileView(false) }
  })
}

// ─── Context menu, playback bar and shortcuts dialog (#586, #587, #588) ──────────────────────────────

const menuActions = { showStats: true, showGrid: false, toggleStats: noop, zoomToFit: noop, toggleGrid: noop, clearHistory: noop, reloadSessionEvents: noop, showAgentDetails: noop }
// The icons of the menu items are decorative glyphs. Key caps that are key names, the same in both languages (letters, digits, symbols)
const KEY_CAPS = new Set(SHORTCUTS.flatMap(s => s.display.split(' / ').flatMap(p => p.split('+'))).filter(p => /^[A-Za-z0-9$,?+-]$|^Ctrl$|^Cmd$/.test(p)))
const BAR_DATA: readonly RegExp[] = [/^\d+([.,]\d+)?$/, /^\d+:\d\d(:\d\d)?$/, /^\d+([.,]\d+)?x$/, /^\d+:\d\d(:\d\d)? (of|sur) \d+:\d\d(:\d\d)?$/]
const BAR_SYMBOLS = ['⏸', '▶', '⟲', '…']
// A visible label is a glyph and a word ("⏸ Review"): the glyph is decorative, the word is checked
const barStrangers = (locale: Locale, strings: string[]) => strangers(locale, strings.map(s => BAR_SYMBOLS.reduce((t, g) => t.split(g).join(''), s).trim()).filter(Boolean), { allow: new Set(['x']), data: BAR_DATA })

for (const locale of LOCALES) {
  test(`the context menu of the canvas and of an agent, armed or not, speaks only ${locale}`, () => {
    setLocaleChoice(locale)
    const strings: string[] = []
    for (const onAgent of [true, false]) {
      const view = render(<GlassContextMenu position={{ x: 10, y: 10 }} items={contextMenuItems(onAgent, menuActions, locale)} onClose={noop} />)
      const menu = view.getByRole('menu')
      assert.equal(langOf(menu), locale, `the menu declares lang=${locale}`)
      assert.equal(menu.getAttribute('aria-label'), MESSAGES[locale]['menu.name'])
      strings.push(...surfaceStrings(view.container))
      if (!onAgent) {
        fireEvent.click(view.getByRole('menuitem', { name: new RegExp(escapeRe(MESSAGES[locale]['menu.clear'])) }))
        strings.push(...surfaceStrings(view.container))
        assert.equal(view.getByRole('status').textContent, MESSAGES[locale]['menu.clear.confirm'], 'the armed confirmation is announced')
      }
      cleanup()
    }
    assert.ok(strings.length > 8)
    assert.deepEqual(strangers(locale, strings, { allow: new Set(['✓', 'ℹ', '🔍', '📊', '⬡', '⟲', '↻']) }), [], `${locale}: strings outside the catalog`)
    assert.deepEqual(foreignWords(locale, strings), [], `${locale}: words of the other language`)
  })

  test(`the playback bar (live, offline, demo, review, confirmation, truncated history) speaks only ${locale}`, () => {
    setLocaleChoice(locale)
    const strings: string[] = []
    const common = { isPlaying: false, speed: 1, currentTime: 75, totalDuration: 3725, onPlayPause: noop, onRestart: noop, onSpeedChange: noop, onSeek: noop, timelineEvents: [], eventCount: 3, droppedEvents: 250, onResumeLive: noop, onEnterReview: noop }
    const toolbarLang = (view: ReturnType<typeof render>) => assert.equal(langOf(view.getByRole('toolbar')), locale, `the bar declares lang=${locale}`)
    for (const live of [{ connectionStatus: 'watching' }, { connectionStatus: 'connected' }, { connectionStatus: 'disconnected' }, { connectionStatus: 'connecting' }, { isDemo: true }] as const) {
      const view = render(<ControlBar {...common} {...live} />)
      toolbarLang(view)
      strings.push(...surfaceStrings(view.container))
      cleanup()
    }
    const review = render(<ControlBar {...common} isReviewing />)
    toolbarLang(review)
    strings.push(...surfaceStrings(review.container))
    assert.ok(review.getByRole('slider', { name: MESSAGES[locale]['bar.position'] }))
    fireEvent.click(review.getByRole('button', { name: MESSAGES[locale]['bar.clear'] }))
    strings.push(...surfaceStrings(review.container))
    assert.ok(review.getByRole('group', { name: MESSAGES[locale]['bar.confirmGroup'] }))
    assert.ok(strings.length > 20)
    assert.deepEqual(barStrangers(locale, strings), [], `${locale}: strings outside the catalog`)
    assert.deepEqual(foreignWords(locale, strings), [], `${locale}: words of the other language`)
  })

  test(`every button of the playback bar has its visible text in its accessible name (WCAG 2.5.3), in ${locale}`, () => {
    setLocaleChoice(locale)
    const common = { isPlaying: false, speed: 1, currentTime: 75, totalDuration: 3725, onPlayPause: noop, onRestart: noop, onSpeedChange: noop, onSeek: noop, timelineEvents: [], eventCount: 3, droppedEvents: 250, onResumeLive: noop, onEnterReview: noop }
    // What a sighted user reads on the button: decorative glyphs (aria-hidden) and screen-reader-only text do not count
    const visibleText = (b: Element) => {
      const c = b.cloneNode(true) as Element
      c.querySelectorAll('[aria-hidden="true"], .sr-only').forEach(n => n.remove())
      return (c.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
    }
    const checked: string[] = []
    const check = (container: HTMLElement) => {
      for (const b of Array.from(container.querySelectorAll('button'))) {
        const visible = visibleText(b)
        if (!visible) continue
        const name = (b.getAttribute('aria-label') ?? b.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
        assert.ok(name.includes(visible), `${locale}: the name "${name}" must contain the visible text "${visible}"`)
        checked.push(visible)
      }
    }
    for (const live of [{ connectionStatus: 'watching' }, { isDemo: true }] as const) {
      const view = render(<ControlBar {...common} {...live} />)
      check(view.container)
      cleanup()
    }
    const review = render(<ControlBar {...common} isReviewing />)
    check(review.container)
    fireEvent.click(review.getByRole('button', { name: MESSAGES[locale]['bar.clear'] }))
    check(review.container)
    const live = render(<ControlBar {...common} connectionStatus="watching" />)
    check(live.container)
    assert.ok(checked.includes(MESSAGES[locale]['bar.review'].toLowerCase()), 'the Review button was checked')
    assert.ok(checked.includes(MESSAGES[locale]['bar.clear'].toLowerCase()), 'Clear history was checked')
    assert.ok(checked.some(x => /^\d+([.,]\d+)?x$/.test(x)), 'the speed buttons were checked')
  })

  test(`the shortcuts dialog (title, groups, every shortcut, the single-key switch) speaks only ${locale}`, () => {
    setLocaleChoice(locale)
    const view = render(<ShortcutsDialog open onClose={noop} singleKeyEnabled onSingleKeyEnabledChange={noop} />)
    const dialog = view.getByRole('dialog', { name: MESSAGES[locale]['shortcut.title'] })
    assert.equal(langOf(dialog), locale, `the dialog declares lang=${locale}`)
    const strings = surfaceStrings(view.container)
    assert.ok(strings.length > SHORTCUTS.length)
    const capsOfTheLocale = new Set(SHORTCUTS.map(d => shortcutKeyCap(d, locale)))
    assert.deepEqual(strangers(locale, strings, { allow: new Set([...KEY_CAPS, ...capsOfTheLocale]) }), [], `${locale}: strings outside the catalog`)
    assert.deepEqual(foreignWords(locale, strings, capsOfTheLocale), [], `${locale}: words of the other language`)
    assert.ok(view.getByRole('switch', { name: new RegExp(escapeRe(MESSAGES[locale]['settings.singleKey'])) }))
    assert.equal(view.container.querySelectorAll('kbd').length, SHORTCUTS.length, 'each shortcut is listed with its key cap')
  })
}

// ---- The Conversation, Context and Files panels (#599, suite de #373) ----
// What the data brings is left as it came: file names, texts of messages and tools, the content of CLAUDE.md, the titles
// of PRs. Each such piece declares lang="en" and data-i18n-exempt; everything else is a value of the catalog.

for (const d of ['orchestrator', 'audit-ux', 'explore', 'plan the work', 'think about it', 'audit the ux please', 'ux audit done', 'auditing', 'scanning files', '**/*.ts', 'ls', 's1:main', 's1:main, s2:main',
  'alpha (session Main)', 'beta (session Fix)', 'alpha', 'beta', 'toolu_read1', 'toolu_edit2', 'CLAUDE.md', 'MEMORY.md', 'feat/b', 'feat/a',
  'github', 'Notion', 'issue_read', 'loop', 'kit', 'lint', 'kit:lint', 'Project', 'AutoMem', 'Default', 'Orchestrator']) FIXTURE_DATA.add(d)

const PANEL_DATA = [/^[≥~]+[\d.,]+[kM]?$/, /^[\w-]+ \([\p{L}’ ]+\)$/u, /^(?:Filtrer une paire :|Copier le message [\p{L} ()]+,|Filter pair|Copy [\p{L} ()]+,) [\w-]+ -> [\w-]+$/u, /^https:\/\/[\w./-]+$/, /^\/[\w./-]+$/, /^\.{3}$/, /^#\d+(?: \(brouillon\)| \(draft\))? PR title \d+$/, /^#\d+ Orphan issue$/, /^(?:PR|Issue) #\d+ .*$/, /^(?:PR|issue) #\d+$/, /^[\w-]+ ↔ [\w-]+$/, /^[\w-]+ -> [\w-]+ - [\p{L}() ]+$/u]
/**
 * WCAG 2.5.3 Label in Name: a control whose accessible name is an aria-label must contain the text it shows
 * (what a voice user says), in the language of the panel. Hidden (sr-only) text is not visible text.
 */
function labelInNameViolations(root: Element): string[] {
  const norm = (x: string) => x.replace(/[≥~]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
  const out: string[] = []
  for (const el of Array.from(root.querySelectorAll('button[aria-label], a[aria-label], [role="tab"][aria-label]'))) {
    const clone = el.cloneNode(true) as Element
    for (const h of Array.from(clone.querySelectorAll('.sr-only, svg'))) h.remove()
    const name = norm(el.getAttribute('aria-label') ?? '')
    // each piece of visible text (a text element of its own) must be in the name; symbols and bare numbers alone are not words
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const piece = norm(n.textContent ?? '')
      if (/\p{L}/u.test(piece) && !name.includes(piece)) out.push(`visible "${piece}" is not in the name "${name}"`)
    }
  }
  return out
}

const PANEL_ALLOW = new Set(['✓', '↔', '→', '●', '○', '$', '×', '–', '+', '-', '—', '.', '/', '…', ',', ':', '·', 'PR', 'issue', 'CLAUDE', 'Conversation', '#',
  // the words around a path ("dans" / "in", "de" / "of"): the path is a piece of its own, lang="en"
  'dans', 'in', 'de', 'of'])

const msgOf = (id: string, type: ConversationMessage['type'], timestamp: number, content: string, extra: Record<string, unknown> = {}) =>
  ({ id, type, timestamp, content, ...extra }) as ConversationMessage

const convAgent = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ id, agentKey: id, sessionId: id.split(':')[0], localId: id, displayName: name, name, parentKey: null, state: 'idle', isMain: false, ...extra }) as unknown as Agent

const longText = 'a long message '.repeat(20)

const TOOL_MESSAGES: ConversationMessage[] = [
  msgOf('t1', 'tool_call', 10, 'Edit a.ts', { toolName: 'Edit', inputData: { file_path: '/repo/src/a.ts', old_string: 'one\ntwo\nthree\nfour\nfive\nsix', new_string: 'x' }, callOutcome: 'error' }),
  msgOf('t2', 'tool_call', 11, 'Edit b.ts', { toolName: 'Edit', inputData: { file_path: '/repo/src/b.ts', old_string: 'a', new_string: 'b\nc' } }),
  msgOf('t3', 'tool_call', 12, 'MultiEdit', { toolName: 'MultiEdit', inputData: { file_path: '/repo/src/c.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: '', new_string: 'new' }] } }),
  msgOf('t4', 'tool_call', 13, 'Write', { toolName: 'Write', inputData: { file_path: '/repo/src/d.ts', content: 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10' } }),
  msgOf('t5', 'tool_call', 14, 'Read', { toolName: 'Read', inputData: { file_path: '/repo/src/e.ts', offset: 5, limit: 10 } }),
  msgOf('t6', 'tool_call', 15, 'Read', { toolName: 'Read', inputData: { file_path: '/repo/src/f.ts', offset: 3 } }),
  msgOf('t7', 'tool_call', 16, 'Grep', { toolName: 'Grep', inputData: { pattern: 'needle', path: '/repo/src', glob: '*.ts' } }),
  msgOf('t8', 'tool_call', 17, 'Glob', { toolName: 'Glob', inputData: { pattern: '**/*.ts', path: '/repo/src' } }),
  msgOf('t9', 'tool_call', 18, 'Bash', { toolName: 'Bash', inputData: { command: 'git status && pytest -q', description: 'check the tree' } }),
  msgOf('t10', 'tool_call', 19, 'Todo', { toolName: 'TodoWrite', inputData: { todos: [{ content: 'write it', status: 'completed' }, { content: 'test it', status: 'in_progress' }, { content: 'ship it', status: 'pending' }] } }),
  msgOf('t11', 'tool_call', 20, 'Search', { toolName: 'WebSearch', inputData: { query: 'wcag language of parts' } }),
  msgOf('t12', 'tool_call', 21, 'Fetch', { toolName: 'WebFetch', inputData: { url: 'https://example.com/page', prompt: 'summarise' } }),
  msgOf('t13', 'tool_call', 22, 'Ask', { toolName: 'AskUserQuestion', inputData: { questions: [{ question: 'which one', options: ['first', 'second'] }] } }),
  msgOf('t14', 'tool_call', 23, 'Task', { toolName: 'Task', inputData: { subagent_type: 'Explore', description: 'look around' } }),
  msgOf('t15', 'tool_call', 24, 'Patch', { toolName: 'apply_patch', inputData: { patch: '*** Begin Patch\n*** Update File: /repo/src/p.ts\n-old\n+new\n*** End Patch' } }),
  msgOf('t16', 'tool_call', 25, 'no input', { toolName: 'Custom' }),
  msgOf('t17', 'tool_result', 26, `< ${'output '.repeat(40)}`, { toolName: 'Bash', resultPill: { kind: 'link', link: { kind: 'pr', number: 7, url: 'https://github.com/o/r/pull/7' } } }),
  msgOf('t18', 'tool_result', 27, '< 3 files', { toolName: 'Glob', resultPill: { kind: 'count', files: 3 } }),
]

const CONVERSATIONS = new Map<string, ConversationMessage[]>([
  ['s1:o', [
    msgOf('a1', 'assistant', 1, 'plan the work'),
    msgOf('a0', 'thinking', 1.5, 'think about it'),
    msgOf('u1', 'user', 1.6, 'plan the work'),
    msgOf('c1', 'compaction', 1.7, 'context compacted'),
    msgOf('d1', 'dispatch', 2, 'audit the ux please', { from: 's1:o', to: 's1:u' }),
    msgOf('m1', 'message', 3, 'plan the work', { from: 's1:o', to: 's1:u' }),
    msgOf('l1', 'assistant', 3.5, longText),
    ...TOOL_MESSAGES,
  ]],
  ['s1:u', [msgOf('a2', 'assistant', 4, 'auditing'), msgOf('r1', 'return', 5, 'ux audit done', { from: 's1:u', to: 's1:o' }), msgOf('r2', 'return', 5.5, 'ux audit done', { from: 's1:u', to: 's1:o', isError: true })]],
  ['s1:e', [msgOf('a3', 'assistant', 6, 'scanning files')]],
])
const CONV_AGENTS = new Map<string, Agent>([
  ['s1:o', convAgent('s1:o', 'orchestrator', { isMain: true, state: 'thinking' })],
  ['s1:u', convAgent('s1:u', 'audit-ux', { teamName: 'alpha', teamColor: '#ff8800', kind: 'teammate', state: 'tool_calling' })],
  ['s1:e', convAgent('s1:e', 'explore', { state: 'complete', kind: 'subagent' })],
])

for (const locale of LOCALES) {
  test(`the Conversation panel (pill, tabs, search, pair filter, every message and tool row, copy feedback) speaks only ${locale}`, async () => {
    setLocaleChoice(locale)
    const registry = createPanelRegistry()
    const strings: string[] = []
    const props = { conversations: CONVERSATIONS, agents: CONV_AGENTS, links: new Map(), teams: new Map(), droppedMessages: new Map([['s1:o', 3], ['s1:u', 1]]), onAgentClick: noop }
    const view = render(<ConversationHarness registry={registry} selectedAgentId={null} {...props} />)
    const pill = view.getByRole('button', { name: new RegExp(escapeRe(translate(locale, 'conv.open', { name: panelName(locale, 'conversation') }))) })
    assert.equal(langOf(pill), locale, 'the pill declares its language')
    // WCAG 3.1.2: an aria-label cannot declare a language, so the name of the pill comes from elements that do (#373)
    assert.equal(pill.getAttribute('aria-label'), null, 'the pill has no aria-label')
    const nameParts = (pill.getAttribute('aria-labelledby') ?? '').split(' ').map(id => document.getElementById(id))
    assert.equal(nameParts.length, 2, 'the pill is named by a sentence and a preview')
    const [leadEl, previewEl] = nameParts as HTMLElement[]
    assert.equal(langOf(leadEl), locale, 'the sentence of the name is in the interface language')
    assert.equal(previewEl.getAttribute('lang'), 'en', 'the preview of the name declares lang=en')
    assert.ok(previewEl.hasAttribute('data-i18n-exempt'), 'the preview is data, like the other message texts')
    assert.ok(leadEl.hidden && previewEl.hidden, 'both are hidden: the name is read once, not twice')
    assert.doesNotMatch(leadEl.textContent ?? '', /please explore|build the thing/i, 'no message text in the sentence')
    // WCAG 2.5.3: the visible words are in the accessible name
    const visible = Array.from(pill.querySelectorAll('span:not([hidden]):not([aria-hidden])')).map(e => (e.textContent ?? '').replace(/\.\.\.$/, '').trim()).filter(Boolean)
    const accessibleName = `${leadEl.textContent} ${previewEl.textContent}`.toLowerCase()
    assert.ok(visible.length >= 2, 'the pill shows a role, an agent and a preview')
    for (const v of visible) assert.ok(accessibleName.includes(v.toLowerCase()) || /\.\.\.$/.test(v) || v.length === 0, `"${v}" is in the accessible name`)
    strings.push(...surfaceStrings(view.container))
    fireEvent.click(pill)
    assert.equal(langOf(view.getByRole('log')), locale, 'the open panel declares its language')
    strings.push(...surfaceStrings(view.container))
    // the long texts of the messages and of the tools, expanded
    const showAll = [MESSAGES[locale]['tool.showAll'], MESSAGES[locale]['conv.showAll'].split(' (')[0]]
    for (const b of Array.from(view.container.querySelectorAll('button[aria-expanded="false"]'))) {
      if (showAll.some(w => (b.textContent ?? '').trim().startsWith(w))) fireEvent.click(b)
    }
    strings.push(...surfaceStrings(view.container))
    // search with no match, then with some
    fireEvent.click(view.getByRole('button', { name: MESSAGES[locale]['conv.search'] }))
    const box = view.getByRole('searchbox', { name: MESSAGES[locale]['conv.search'] })
    fireEvent.change(box, { target: { value: 'zzz-no-match' } })
    strings.push(...surfaceStrings(view.container))
    fireEvent.change(box, { target: { value: 'plan' } })
    strings.push(...surfaceStrings(view.container))
    fireEvent.change(box, { target: { value: '' } })
    // pair filter: the picker, then a pair
    fireEvent.click(view.getAllByRole('button', { name: MESSAGES[locale]['conv.pair.button'] })[0])
    strings.push(...surfaceStrings(view.container))
    const selects = view.getAllByRole('combobox')
    assert.equal(selects.length, 2)
    fireEvent.change(selects[0], { target: { value: 's1:o' } })
    fireEvent.change(selects[1], { target: { value: 's1:u' } })
    await flush()
    strings.push(...surfaceStrings(view.container))
    assert.deepEqual(labelInNameViolations(view.container), [], `${locale}: the name of a control contains its visible text (WCAG 2.5.3)`)
    // a copy action and the tool toggle
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true })
    fireEvent.click(view.getAllByRole('button', { name: new RegExp(`^${escapeRe(MESSAGES[locale]['conv.row.copy'])}`) })[0])
    await flush()
    strings.push(...surfaceStrings(view.container))
    fireEvent.click(view.getByRole('button', { name: MESSAGES[locale]['conv.toolCalls'] }))
    clearPair()
    fireEvent.click(view.getByRole('tab', { name: new RegExp(escapeRe('audit-ux')) }))
    strings.push(...surfaceStrings(view.container))
    assert.ok(strings.length > 60, `${strings.length} strings`)
    assert.deepEqual(strangers(locale, strings, { allow: PANEL_ALLOW, data: PANEL_DATA }), [], `${locale}: strings outside the catalog`)
    assert.deepEqual(foreignWords(locale, strings), [], `${locale}: words of the other language`)
    // what the data brings declares lang="en" and is left out of the check on purpose
    assert.ok(view.container.querySelector('[lang="en"][data-i18n-exempt]'), 'message and tool texts declare lang="en"')
  })
}

// ---- Files panel ----

const FP = '/repo/src/'
const fileOf = (name: string, extra: Partial<FileAttention> = {}): FileAttention =>
  ({ path: `${FP}${name}`, reads: 0, edits: 0, totalTokens: 0, lastAccessed: 1, agents: ['s1:main'], ...extra })
const PANEL_FILES = new Map<string, FileAttention>([
  ['a', fileOf('a.ts', { reads: 2, edits: 2, totalTokens: 3000, tokensPartial: true, tokensEstimated: true, agents: ['s1:main', 's2:main'],
    readers: [{ agent: 's1:main', started: 2, succeeded: 1 }],
    editors: [{ agent: 's1:main', started: 1, succeeded: 1, lastEditTime: 3 }, { agent: 's2:main', started: 1, succeeded: 1, lastEditTime: 5 }],
    timeline: { steps: [{ kind: 'read', callId: 'c1', toolUseId: 'toolu_read1', agentId: 's1:main', time: 1 }, { kind: 'edited', callId: 'c2', toolUseId: 'toolu_edit2', agentId: 's1:main', time: 2 }, { kind: 'written', callId: 'c3', agentId: 's1:main', time: 3 }], omitted: 4 } })],
  ['b', fileOf('b.ts', { reads: 1, totalTokens: 100 })],
  ['c', fileOf('c.ts', { reads: 1, totalTokens: 0, tokensPartial: true })],
  ['d', fileOf('d.ts', { reads: 1 })],
  ['e', fileOf('e.ts', { reads: 1, totalTokens: 1200, tokensEstimated: true })],
])
const FILE_LABELS: Record<string, string> = { 's1:main': 'alpha (session Main)', 's2:main': 'beta (session Fix)' }

function wasteLedger(): WasteLedger {
  let n = 0
  let ledger = emptyWasteLedger()
  const call = (toolName: string, inputData: Record<string, unknown>, cost?: number) => {
    const id = `tc${++n}`
    ledger = recordToolStart(ledger, { sessionId: 's1', agentId: 's1:main', toolName, inputData, toolUseId: id, toolCallId: id, time: n })
    if (cost !== undefined) ledger = recordToolEnd(ledger, id, cost, 'reported')
  }
  for (let i = 0; i < 3; i++) call('Read', { file_path: `${FP}a.ts` }, 150)
  call('Read', { file_path: `${FP}b.ts` }); call('Read', { file_path: `${FP}b.ts` })
  call('Glob', { pattern: '**/*.ts' }); call('Glob', { pattern: '**/*.ts' })
  call('Bash', { command: 'ls' }); call('Bash', { command: 'ls' })
  call('Bash', { description: 'no command' }); call('Bash', { description: 'no command' })
  return ledger
}

for (const locale of LOCALES) {
  test(`the Files panel (files, tokens, conflicts, steps of a file, repeated reads, empty and incomplete states) speaks only ${locale}`, () => {
    setLocaleChoice(locale)
    const strings: string[] = []
    const agents = new Map<string, Agent>([['s1:main', convAgent('s1:main', 'alpha')]])
    const label = (k: string) => FILE_LABELS[k] ?? k
    for (const [files, lost, waste] of [
      [PANEL_FILES, 0, wasteLedger()], [PANEL_FILES, 6, wasteLedger()], [new Map<string, FileAttention>(), 0, emptyWasteLedger()], [new Map<string, FileAttention>(), 4, emptyWasteLedger()],
    ] as const) {
      const view = render(<FileAttentionPanel visible fileAttention={files} replayLost={lost} waste={waste} agents={agents} agentLabel={label} onOpenFile={noop} onClose={noop} />)
      const body = view.getByRole('region', { name: MESSAGES[locale]['files.region'] })
      assert.equal(langOf(body), locale, 'the panel declares its language')
      strings.push(...surfaceStrings(view.container))
      if (files.size > 0) assert.ok(view.container.querySelector('button [lang="en"][data-i18n-exempt]'), 'a file name declares lang="en"')
      assert.deepEqual(labelInNameViolations(view.container), [], `${locale}: the name of a control contains its visible text (WCAG 2.5.3)`)
      cleanup()
    }
    assert.ok(strings.length > 40, `${strings.length} strings`)
    assert.deepEqual(strangers(locale, strings, { allow: PANEL_ALLOW, data: PANEL_DATA }), [], `${locale}: strings outside the catalog`)
    assert.deepEqual(foreignWords(locale, strings), [], `${locale}: words of the other language`)
  })
}

// ---- Context panel ----

const CTX_ORIGIN = 'http://127.0.0.1:4321'
const CTX_URL = 'https://github.com/o/r'
const ctxWork = () => ({
  scope: 'session', session: 's1', repo: CTX_URL,
  prs: [
    { number: 11, title: 'PR title 11', url: `${CTX_URL}/pull/11`, branch: 'feat/b', checks: { state: 'failing', total: 4, failing: 1, pending: 1 } },
    { number: 10, title: 'PR title 10', url: `${CTX_URL}/pull/10`, branch: 'feat/a', draft: true, checks: { state: 'none', total: 0, failing: 0, pending: 0 } },
    { number: 12, title: 'PR title 12', url: `${CTX_URL}/pull/12`, branch: 'feat/c', checks: { state: 'unknown', total: 2, failing: 0, pending: 0 } },
  ],
  issues: [{ number: 40, title: 'Orphan issue', url: `${CTX_URL}/issues/40` }],
  prsTruncated: true, issuesTruncated: true,
})
const CAPS: SessionCapabilities = {
  status: 'ok', partial: true, truncated: true,
  instructions: [{ type: 'Project', name: 'CLAUDE.md' }, { type: 'AutoMem', name: 'MEMORY.md' }],
  skillsInvoked: [{ name: 'kit:lint', calls: 2 }],
  skillsListed: ['loop', 'kit:lint'],
  mcpServers: [{ name: 'github', announced: true, calls: 3, tools: [{ name: 'issue_read', calls: 3 }] }, { name: 'Notion', announced: false, calls: 0, tools: [] }],
}
const ctxData = (over: Partial<ProjectContextData> = {}): ProjectContextData => ({
  sessionId: 's1', loadedAt: 1,
  files: [
    { kind: 'claude-md', name: 'CLAUDE.md', found: true, text: 'Project rules for everyone', bytes: 99_000, truncated: true },
    { kind: 'memory', name: 'MEMORY.md', found: false, text: '', bytes: 0, truncated: false },
    { kind: 'memory', name: 'a.md', found: false, unreadable: 'symlink', text: '', bytes: 0, truncated: false },
    { kind: 'memory', name: 'b.md', found: false, unreadable: 'not-a-file', text: '', bytes: 0, truncated: false },
    { kind: 'memory', name: 'c.md', found: false, unreadable: 'unreadable', text: '', bytes: 0, truncated: false },
  ],
  issues: [12, 64],
  capabilities: CAPS,
  ...over,
} as ProjectContextData)
const sessionOf = (over: Partial<ResumableSession> = {}): ResumableSession => ({ id: 's1', runtime: 'claude', cwd: '/repo', ...over }) as ResumableSession

for (const d of ['a.md', 'b.md', 'c.md', 'feat/c', 'PR title 11', 'PR title 10', 'PR title 12', 'Orphan issue']) FIXTURE_DATA.add(d)

for (const locale of LOCALES) {
  test(`the Context panel (files, issues, capabilities, resume, pull requests and issues, every state) speaks only ${locale}`, async () => {
    setLocaleChoice(locale)
    const strings: string[] = []
    const realFetchLocal = g.fetch
    g.fetch = async () => ({ ok: true, json: async () => ctxWork() })
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true })
    try {
      // loaded, with the resume block, the terminal button (VS Code) and the work of the session
      const loaded = render(<ProjectContextPanel visible sessionId={`ctx-${locale}`} session={sessionOf({ id: `ctx-${locale}` })} onOpenTerminal={noop} sessionBranch="feat/b" relayOrigin={CTX_ORIGIN}
        fetchContext={async () => ctxData()} onClose={noop} />)
      await flush()
      await flush()
      assert.equal(langOf(loaded.getByRole('button', { name: MESSAGES[locale]['ctx.refresh.aria'] })), locale, 'the panel declares its language')
      strings.push(...surfaceStrings(loaded.container))
      assert.ok(loaded.container.querySelector('pre[lang="en"][data-i18n-exempt]'), 'the text of CLAUDE.md declares lang="en"')
      assert.ok(loaded.container.querySelector('code[lang="en"][data-i18n-exempt]'), 'the resume command declares lang="en"')
      assert.ok(loaded.container.querySelector('table a [lang="en"][data-i18n-exempt]'), 'the title of a pull request declares lang="en"')
      assert.deepEqual(labelInNameViolations(loaded.container), [], `${locale}: the name of a control contains its visible text (WCAG 2.5.3)`)
      assert.ok(loaded.container.querySelector('h3 [lang="en"][data-i18n-exempt]'), 'the heading of the issues declares lang="en"')
      assert.ok(loaded.container.querySelector('th [lang="en"][data-i18n-exempt]'), 'the column Pull request declares lang="en"')
      fireEvent.click(loaded.getByRole('button', { name: MESSAGES[locale]['resume.copy.aria'] }))
      await flush()
      strings.push(...surfaceStrings(loaded.container))
      fireEvent.click(loaded.getByRole('button', { name: MESSAGES[locale]['resume.terminal.aria'] }))
      strings.push(...surfaceStrings(loaded.container))
      cleanup()
      // the other states: no capabilities, invalid, unreadable, no repository, unknown project, every reason of no resume command
      for (const [caps, work] of [[undefined, { ...ctxWork(), repo: null }], ['invalid', ctxWork()], [{ status: 'unreadable' }, ctxWork()]] as const) {
        g.fetch = async () => ({ ok: true, json: async () => work })
        const v = render(<ProjectContextPanel visible sessionId={`ctx2-${locale}-${String(caps)}`} sessionBranch={undefined} relayOrigin={CTX_ORIGIN}
          fetchContext={async () => ctxData({ capabilities: caps as ProjectContextData['capabilities'], issues: [] })} onClose={noop} />)
        await flush()
        await flush()
        strings.push(...surfaceStrings(v.container))
        cleanup()
      }
      for (const over of [{ id: '-bad' }, { runtime: 'codex' }, { imported: true }, { cwd: 'relative' }] as const) {
        const v = render(<ProjectContextPanel visible sessionId="s1" session={sessionOf(over as Partial<ResumableSession>)} fetchContext={async () => ctxData()} onClose={noop} />)
        await flush()
        strings.push(...surfaceStrings(v.container))
        cleanup()
      }
      const states: Array<[string, React.ReactElement]> = [
        ['loading', <ProjectContextPanel key="1" visible sessionId="s1" fetchContext={() => new Promise(() => {})} onClose={noop} />],
        ['error', <ProjectContextPanel key="2" visible sessionId="s1" fetchContext={async () => { throw new Error('boom') }} onClose={noop} />],
        ['unavailable', <ProjectContextPanel key="3" visible sessionId="s1" fetchContext={async () => 'unavailable'} onClose={noop} />],
        ['no session', <ProjectContextPanel key="4" visible sessionId={null} fetchContext={async () => 'unavailable'} onClose={noop} />],
        ['demo', <ProjectContextPanel key="5" visible sessionId="s1" unavailableReason="demo" fetchContext={async () => 'unavailable'} onClose={noop} />],
        ['vscode', <ProjectContextPanel key="6" visible sessionId="s1" unavailableReason="vscode" fetchContext={async () => 'unavailable'} onClose={noop} />],
      ]
      for (const [, el] of states) {
        const v = render(el)
        await flush()
        strings.push(...surfaceStrings(v.container))
        cleanup()
      }
    } finally {
      g.fetch = realFetchLocal
    }
    assert.ok(strings.length > 80, `${strings.length} strings`)
    assert.deepEqual(strangers(locale, strings, { allow: PANEL_ALLOW, data: PANEL_DATA }), [], `${locale}: strings outside the catalog`)
    assert.deepEqual(foreignWords(locale, strings), [], `${locale}: words of the other language`)
  })
}

// ---- Timeline panel (#373) ----

const TL_FIXTURE_NAMES = ['tl-lead', 'tl-explore', 'tl-audit']
for (const d of TL_FIXTURE_NAMES) FIXTURE_DATA.add(d)
const tlBlock = (id: string, type: TimelineBlock['type'], startTime: number, label: string, color: string, endTime?: number): TimelineBlock =>
  ({ id, type, startTime, label, color, ...(endTime === undefined ? {} : { endTime }) })
/** Every state of a block, every fixed label, a failed and a cancelled call, an expired one and a block still running. */
const TL_ENTRIES = new Map<string, TimelineEntry>([
  ['tl-lead', { id: 'tl-lead', agentId: 'tl-lead', agentName: 'tl-lead', startTime: 0, blocks: [
    tlBlock('a', 'idle', 0, 'Starting', SCENE.idle, 1), tlBlock('b', 'thinking', 1, 'Thinking...', SCENE.thinking, 3),
    tlBlock('c', 'tool_call', 3, 'Read: src/foo.ts', SCENE.tool, 5), tlBlock('d', 'tool_call', 5, 'Bash: FAILED', SCENE.error, 6),
    tlBlock('e', 'idle', 6, 'Permission', SCENE.waiting_permission, 8), tlBlock('f', 'tool_call', 8, 'Grep: CANCELLED', SCENE.idle, 9),
    tlBlock('g', 'tool_call', 9, 'Read: b.ts (expired, end not observed)', SCENE.tool, 10), tlBlock('h', 'thinking', 10, 'Thinking...', SCENE.thinking),
  ] }],
  ['tl-explore', { id: 'tl-explore', agentId: 'tl-explore', agentName: 'tl-explore', startTime: 2, endTime: 9, blocks: [
    tlBlock('i', 'idle', 2, 'Resumed', SCENE.idle, 4), tlBlock('j', 'complete', 9, 'Done', SCENE.complete, 9),
  ] }],
  ['tl-audit', { id: 'tl-audit', agentId: 'tl-audit', agentName: 'tl-audit', startTime: 4, blocks: [] }],
])
const tlMsg = (id: string, type: string, timestamp: number, content: string, from: string, to: string, isError = false) =>
  ({ id, type, timestamp, content, from, to, isError }) as unknown as ConversationMessage
const tlLinks = (extra = 0) => new Map<string, AgentLink>([
  ['l1', { id: 'l1', from: 'tl-lead', to: 'tl-explore', kind: 'spawn', sessionId: 's', dropped: 0, messages: [
    tlMsg('m1', 'dispatch', 2, 'please explore the code', 'tl-lead', 'tl-explore'), tlMsg('m2', 'return', 8, 'found three files', 'tl-explore', 'tl-lead'),
    tlMsg('m3', 'return', 9, 'it failed badly', 'tl-explore', 'tl-lead', true), tlMsg('m4', 'message', 5, 'a peer note', 'tl-audit', 'tl-explore'),
    ...Array.from({ length: extra }, (_, i) => tlMsg(`x${i}`, 'message', 5.5 + i / 100, `extra ${i}`, 'tl-audit', 'tl-lead')),
  ] } as unknown as AgentLink],
])

for (const locale of LOCALES) {
  test(`the Timeline panel (every state, table view, messages, pair filter, empty and incomplete states) speaks only ${locale}`, () => {
    setLocaleChoice(locale)
    const T = (k: MessageKey, p?: Record<string, string | number>) => translate(locale, k, p)
    const strings: string[] = []
    const scenarios: Array<{ entries: Map<string, TimelineEntry>; links?: Map<string, AgentLink>; pair?: [string, string]; tableView?: boolean; sequence?: boolean }> = [
      { entries: TL_ENTRIES, links: tlLinks() },
      { entries: TL_ENTRIES, links: tlLinks(), tableView: true },
      { entries: TL_ENTRIES, links: tlLinks(), sequence: true },
      { entries: TL_ENTRIES, links: tlLinks(), pair: ['tl-lead', 'tl-explore'] },
      { entries: TL_ENTRIES, links: tlLinks(), pair: ['tl-lead', 'tl-audit'] },
      // more messages than buttons: the "earlier messages" line, once with one hidden and once with several
      { entries: TL_ENTRIES, links: tlLinks(37) },
      { entries: TL_ENTRIES, links: tlLinks(42) },
      // no link channel: no Sequence button; no entry at all: the empty state, also in the table view
      { entries: TL_ENTRIES },
      { entries: new Map() },
      { entries: new Map(), tableView: true },
      { entries: new Map([['tl-audit', TL_ENTRIES.get('tl-audit')!]]), tableView: true },
    ]
    for (const sc of scenarios) {
      clearPair()
      if (sc.pair) act(() => setPair(sc.pair![0], sc.pair![1]))
      const view = render(<TimelinePanel visible timelineEntries={sc.entries} currentTime={12} onClose={noop} links={sc.links} />)
      const region = view.getByRole('region', { name: T('tl.region') })
      assert.equal(langOf(region), locale, 'the panel declares its language')
      if (sc.sequence) fireEvent.click(view.getByRole('button', { name: T('tl.sequence') }))
      if (sc.tableView) fireEvent.click(view.getByRole('button', { name: T('tl.table') }))
      strings.push(...surfaceStrings(view.container))
      assert.deepEqual(labelInNameViolations(view.container), [], `${locale}: the name of a control contains its visible text (WCAG 2.5.3)`)
      cleanup()
    }
    clearPair()
    // the words that must have been rendered, in the catalog's language
    for (const key of ['tl.region', 'tl.sequence', 'tl.table', 'tl.scroll', 'tl.col.agent', 'tl.col.state', 'tl.col.start', 'tl.col.end', 'tl.ongoing', 'tl.empty',
      'tl.msgs.caption', 'tl.msgs.col.time', 'tl.msgs.col.kind', 'tl.msgs.col.from', 'tl.msgs.col.to', 'tl.msgs.col.content',
      'tl.kind.dispatch', 'tl.kind.return', 'tl.kind.returnError', 'tl.kind.message', 'tl.state.idle', 'tl.state.thinking', 'tl.state.tool_call',
      'tl.state.waiting_permission', 'tl.state.error', 'tl.state.complete'] as MessageKey[]) {
      assert.ok(strings.includes(T(key)), `${key} was rendered`)
    }
    assert.ok(strings.includes(T('tl.aria.none')), 'the accessible name of an empty timeline')
    assert.ok(strings.includes(T('tl.aria.range.other', { n: 3, from: '0:00', to: '0:12' })), 'the accessible name of the canvas')
    assert.ok(strings.includes(T('tl.earlier.one', { n: 1 })) && strings.includes(T('tl.earlier.other', { n: 6 })), 'the earlier-messages line, singular and plural')
    assert.ok(strings.includes(T('tl.sequence.title')), 'the title of the Sequence button')
    for (const w of ['tl.block.thinking', 'tl.block.starting', 'tl.block.done', 'tl.block.permission', 'tl.block.resumed']) {
      assert.ok(strings.some(s => s.includes(T(w as MessageKey))), `${w} was rendered`)
    }
    assert.ok(strings.some(s => s.includes(T('tl.block.failed'))) && strings.some(s => s.includes(T('tl.block.cancelled'))) && strings.some(s => s.includes(T('tl.block.expired'))))
    assert.ok(strings.length > 80, `${strings.length} strings`)
    assert.deepEqual(strangers(locale, strings, { allow: PANEL_ALLOW, data: PANEL_DATA }), [], `${locale}: strings outside the catalog`)
    assert.deepEqual(foreignWords(locale, strings), [], `${locale}: words of the other language`)
  })

  test(`the Timeline panel marks what came from the data lang="en" and nothing else, in ${locale}`, () => {
    setLocaleChoice(locale)
    clearPair()
    const view = render(<TimelinePanel visible timelineEntries={TL_ENTRIES} currentTime={12} onClose={noop} links={tlLinks()} />)
    fireEvent.click(view.getByRole('button', { name: translate(locale, 'tl.table') }))
    const exempt = Array.from(view.container.querySelectorAll('[data-i18n-exempt]'))
    assert.ok(exempt.length >= 4, `${exempt.length} pieces of data`)
    for (const e of exempt) assert.equal(e.getAttribute('lang'), 'en', `${e.textContent} declares lang="en"`)
    const texts = exempt.map(e => e.textContent)
    for (const data of ['Read: src/foo.ts', 'please explore the code', 'found three files']) assert.ok(texts.includes(data), `${data} is marked as data`)
    // a translated word is never inside such a piece
    for (const word of [translate(locale, 'tl.block.thinking'), translate(locale, 'tl.block.starting'), translate(locale, 'tl.block.failed')]) {
      assert.ok(!texts.some(t => t?.includes(word)), `${word} is not marked as English data`)
    }
    cleanup()
    // the message read under the swimlane on hover or focus: the words are ours, the content is data
    const live = render(<TimelinePanel visible timelineEntries={TL_ENTRIES} currentTime={12} onClose={noop} links={tlLinks()} />)
    const dispatch = live.getAllByRole('button').find(b => b.textContent?.includes(translate(locale, 'conv.comm.dispatch')))
    assert.ok(dispatch, 'a message button is named with the word of the language')
    fireEvent.focus(dispatch)
    const status = live.getAllByRole('status').find(s => s.textContent?.includes('please explore the code'))
    assert.ok(status, 'the content is read in a live region')
    assert.equal(status.querySelector('[data-i18n-exempt]')?.textContent, 'please explore the code')
    assert.ok(status.textContent?.startsWith(`tl-lead -> tl-explore - ${translate(locale, 'conv.comm.dispatch')}: `))
    assert.equal(langOf(status), locale)
    cleanup()
  })
}

test('the Timeline panel draws its canvas texts through the catalog: the empty state and the state words, in French', () => {
  setLocaleChoice('fr')
  const calls: string[] = []
  const proto = HTMLCanvasElement.prototype as unknown as { getContext: (id: string) => unknown }
  const original = proto.getContext
  const noopFn = () => {}
  const ctx = new Proxy({ measureText: (s: string) => ({ width: s.length * 6 }), fillText: (s: string) => { calls.push(s) } } as Record<string, unknown>, {
    get: (target, prop: string) => (prop in target ? target[prop] : noopFn), set: (target, prop: string, v) => { target[prop] = v; return true },
  })
  proto.getContext = () => ctx
  // jsdom has no layout: give the scroll area a width so that the blocks are wide enough to carry a word, and narrow ones a letter
  const widthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 400 })
  try {
    for (const entries of [new Map<string, TimelineEntry>(), TL_ENTRIES]) {
      render(<TimelinePanel visible timelineEntries={entries} currentTime={12} onClose={noop} />)
      cleanup()
    }
  } finally {
    proto.getContext = original
    if (widthDesc) Object.defineProperty(HTMLElement.prototype, 'clientWidth', widthDesc); else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
  }
  assert.ok(calls.includes(MESSAGES.fr['tl.empty']), 'the empty state is drawn in French')
  assert.ok(!calls.includes('No timeline data yet'))
  assert.ok(calls.includes(MESSAGES.fr['tl.block.thinking']), 'a French block label is drawn')
  assert.ok(calls.includes(MESSAGES.fr['tl.glyph.tool_call']), 'a French state letter is drawn in a block too narrow for its label (O for outil, C in English)')
  assert.ok(!calls.includes('C'), 'the English letter C is not drawn in French')
  assert.ok(!calls.includes('Thinking...') && !calls.includes('Starting'), 'no English fixed label is drawn')
})

test('the native notification bodies (browser and VS Code) are in the interface language, with no exemption (#373)', () => {
  const rules = { permission: true, error: true, complete: true, cost: true, costThresholdUsd: 5 }
  const base = emptySnapshot()
  const sessionsOf = (status: 'active' | 'completed') => new Map([['s', { label: 'api', status }]])
  const bodiesOf = (locale: 'fr' | 'en') => [
    evaluateTriggers(base, { ...base, waitingIds: new Set(['a', 'b']), errorIds: new Set(['c']) }, rules, locale),
    evaluateTriggers({ ...base, sessions: sessionsOf('active') }, { ...base, sessions: sessionsOf('completed') }, rules, locale),
    evaluateTriggers({ ...base, cost: { value: 1, status: 'available', estimated: false } }, { ...base, cost: { value: 6, status: 'partial', estimated: true } }, rules, locale),
  ].flat().map(i => i.body)
  const fr = bodiesOf('fr')
  assert.equal(fr.length, 3, 'one body per trigger')
  const english = /\b(waiting|error|finished|reached|threshold|estimate|estimated|at least|incomplete)\b/i
  for (const body of fr) assert.doesNotMatch(body, english, body)
  assert.deepEqual(bodiesOf('en').length, 3)
})
