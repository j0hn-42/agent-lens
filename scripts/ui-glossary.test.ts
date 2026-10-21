import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  PANEL_NAMES, PANEL_SUMMARIES, COST_LABELS, HIERARCHY_TERMS, emptyState, emptyMatch, hiddenPanelsText,
} from '../web/lib/ui-glossary'
import { SHORTCUTS } from '../web/lib/shortcuts'
import { MESSAGES } from '../web/lib/messages'
import {
  EMPTY_MESSAGES, EMPTY_SEARCH, COLLAPSED_TEXT_MAX, TOOL_MESSAGE_TYPES, buildFeedMessages, latestFeedMessage,
  filterBySearch, tabForSelection,
} from '../web/lib/feed-utils'
import type { ConversationMessage } from '../web/hooks/simulation/types'

/** The source files of the message catalog: the assembly point and its domain files (#612), in a fixed order */
const CATALOG_FILES = [join('web/lib', 'messages.ts'), ...readdirSync(join('web/lib', 'messages')).filter(f => f.endsWith('.ts')).sort().map(f => join('web/lib', 'messages', f))]

const msg = (id: string, type: ConversationMessage['type'], timestamp: number, content: string, extra: Partial<ConversationMessage> = {}): ConversationMessage =>
  ({ id, type, timestamp, content, ...extra })

test('the glossary fixes the panel names and the agent hierarchy', () => {
  assert.deepEqual(PANEL_NAMES, { conversation: 'Conversation', files: 'Files & repeats', timeline: 'Timeline', cost: 'Cost', context: 'Context', stats: 'Stats', system: 'System' })
  assert.equal(HIERARCHY_TERMS.main, 'Main')
  assert.equal(HIERARCHY_TERMS.lead, 'Lead')
})

test('one empty-state wording: "No <things> yet", shared by the glossary and the message lists', () => {
  assert.equal(emptyState('files'), 'No files yet')
  assert.equal(emptyMatch('messages'), 'No matching messages')
  assert.equal(EMPTY_MESSAGES, 'No messages yet')
  assert.equal(EMPTY_SEARCH, 'No matching messages')
})

test('the Conversation button is named with its shortcut and the pill/close controls use the same name', () => {
  // The top bar names come from messages.ts since #523 (an icon under 1280 px); in English they are the glossary names
  assert.equal(MESSAGES.en['topbar.panel.conversation.name'], `${PANEL_NAMES.conversation} (C)`)
  // Cost too since #613 (it was "$Cost", read "dollar Cost"; its shortcut $ is in the tooltip)
  for (const p of ['files', 'timeline', 'stats', 'cost'] as const) assert.equal(MESSAGES.en[`topbar.panel.${p}.name`], PANEL_NAMES[p])
  assert.equal(MESSAGES.en['topbar.panel.context.name'], `${PANEL_NAMES.context} (P)`)
  assert.equal(MESSAGES.en['topbar.panel.system.name'], `${PANEL_NAMES.system} (Y)`)
  // One source for the English tooltips (#545 review): built from the glossary, never a copy that can drift
  assert.equal(MESSAGES.en['topbar.panel.cost.tooltip'], `Cost overlay ($). ${COST_LABELS.method}`)
  assert.equal(MESSAGES.en['topbar.panel.context.tooltip'], `${PANEL_NAMES.context}: ${PANEL_SUMMARIES.context} (P)`)
  // The catalog is messages.ts and its domain files (#612): none of them copies a glossary text by hand
  const catalog = CATALOG_FILES.map(f => readFileSync(f, 'utf8')).join('\n')
  assert.ok(CATALOG_FILES.length > 2, 'the domain files of the catalog are read')
  assert.equal(catalog.includes(COST_LABELS.method), false, 'the catalog does not copy COST_LABELS.method by hand')
  assert.equal(catalog.includes(PANEL_SUMMARIES.context), false, 'the catalog does not copy PANEL_SUMMARIES.context by hand')
})

test('the shortcuts table names the panels with the glossary words; key C toggles the Conversation panel', () => {
  const byKey = new Map(SHORTCUTS.map(s => [s.key, s]))
  assert.equal(byKey.get('c')!.description, 'Toggle Conversation panel')
  assert.equal(byKey.get('f')!.description, 'Toggle Files & repeats panel')
  assert.equal(byKey.get('t')!.description, 'Toggle Timeline panel')
  assert.equal(byKey.get('$')!.description, 'Toggle Cost overlay')
  for (const s of SHORTCUTS) assert.ok(!/transcript|chat|message feed/i.test(s.description), `old vocabulary in: ${s.description}`)
  assert.match(byKey.get('Escape')!.description, /most recently opened panel, then clear the selection/)
})

test('one truncation rule: 120 characters collapsed', () => {
  assert.equal(COLLAPSED_TEXT_MAX, 120)
})

test('buildFeedMessages lists tool activity only when asked to', () => {
  const convs = new Map([['a', [msg('1', 'assistant', 1, 'hi'), msg('2', 'tool_call', 2, 'Read(x)', { toolName: 'Read' }), msg('3', 'tool_result', 3, '< ok', { toolName: 'Read' })]]])
  assert.deepEqual(buildFeedMessages(convs).map(m => m.id), ['1'])
  assert.deepEqual(buildFeedMessages(convs, undefined, TOOL_MESSAGE_TYPES).map(m => m.id), ['1', '2', '3'])
})

test('latestFeedMessage follows text and communications, not tool calls, and prefers the newest', () => {
  const convs = new Map([
    ['a', [msg('1', 'assistant', 1, 'old'), msg('2', 'tool_call', 9, 'Read(x)')]],
    ['b', [msg('3', 'assistant', 5, 'newer')]],
  ])
  assert.equal(latestFeedMessage(convs)!.id, '3')
  assert.equal(latestFeedMessage(convs)!.agentId, 'b')
  const links = new Map([['l', { from: 'a', messages: [msg('4', 'dispatch', 7, 'do it', { from: 'a', to: 'b' })] }]])
  assert.equal(latestFeedMessage(convs, links)!.id, '4')
  assert.equal(latestFeedMessage(new Map()), null)
})

test('filterBySearch matches content and tool name, case-insensitively; blank keeps all', () => {
  const list = [
    { content: 'Fix the Bug', toolName: undefined },
    { content: 'Read(file.ts)', toolName: 'Read' },
    { content: 'other', toolName: 'Grep' },
  ]
  assert.equal(filterBySearch(list, 'bug').length, 1)
  assert.equal(filterBySearch(list, 'READ').length, 1)
  assert.equal(filterBySearch(list, 'grep').length, 1)
  assert.equal(filterBySearch(list, '   ').length, 3)
  assert.equal(filterBySearch(list, 'zzz').length, 0)
})

test('tabForSelection presets the tab to the selected agent', () => {
  assert.equal(tabForSelection('s:worker'), 's:worker')
  assert.equal(tabForSelection(null), 'all')
  assert.equal(tabForSelection(undefined), 'all')
})

test('Tempo labels are centralised in the glossary, in English (#123)', async () => {
  const glossary = await import('../web/lib/ui-glossary')
  const lifecycle = await import('../web/lib/tool-lifecycle')
  const usage = await import('../web/lib/usage')
  assert.deepEqual(glossary.USAGE_LABELS, { unavailable: 'not reported', atLeast: 'at least', estimated: 'estimated', incomplete: '(incomplete)' })
  assert.equal(lifecycle.END_NOT_OBSERVED, glossary.END_NOT_OBSERVED)
  assert.equal(lifecycle.EXPIRED_WARNING, glossary.EXPIRED_WARNING)
  assert.equal(usage.USAGE_LABELS, glossary.USAGE_LABELS)
})

test('no accented character in UI code outside comments (the UI is English only, #123)', () => {
  // The message catalog (#247) is the one place that carries translated text; the rest of the UI code stays accent free.
  // Since #612 it is messages.ts plus its domain files in web/lib/messages/.
  const allowed = new Set<string>(CATALOG_FILES)
  const hits: string[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.next') walk(p); continue }
      if (!/\.(ts|tsx)$/.test(e.name) || allowed.has(p)) continue
      readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        const t = line.trim()
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
        const code = line.replace(/\s\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')
        if (/[\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF]/.test(code)) hits.push(`${p}:${i + 1}: ${t}`)
      })
    }
  }
  for (const r of ['web/lib', 'web/hooks', 'web/components', 'web/app']) walk(r)
  assert.deepEqual(hits, [], 'accented (non-English) text in UI code')
})

test('hidden panels sentence (#410): names the open panels a sheet hides, nothing when none', () => {
  assert.equal(hiddenPanelsText([]), '')
  assert.equal(hiddenPanelsText(['conversation']), '1 panel hidden: Conversation. Close the panel shown to see it.')
  assert.equal(hiddenPanelsText(['detail', 'files', 'link']), '3 panels hidden: Agent card, Files & repeats, Link. Close the panel shown to see Link.')
  assert.equal(hiddenPanelsText(['files', 'timeline']), '2 panels hidden: Files & repeats, Timeline. Close the panel shown to see Timeline.')
  // Context takes the Files slot of the dock: it is named Context while it is the one open
  assert.equal(hiddenPanelsText(['files'], { context: true }), '1 panel hidden: Context. Close the panel shown to see it.')
})

test('one name per thing (#372): Context, Timeline and Sessions never take a second meaning', async () => {
  const g = await import('../web/lib/ui-glossary')
  // "Context" is the project panel; the model's token window is always the "Context window"
  assert.equal(g.CONTEXT_WINDOW_NAME, 'Context window')
  assert.notEqual(g.CONTEXT_WINDOW_NAME, PANEL_NAMES.context)
  assert.equal(g.PANEL_SUMMARIES.context, 'project CLAUDE.md, memory, issues')
  // "Timeline" is the panel; the control-bar slider is the playback position
  assert.equal(g.PLAYBACK_LABELS.position, 'Playback position')
  assert.ok(!g.PLAYBACK_LABELS.position.includes(PANEL_NAMES.timeline))
  // The list opened by L has one name in the top bar, the Shortcuts dialog and the palette
  assert.equal(g.SESSIONS_LIST_NAME, 'Sessions and agents')
  const byKey = new Map(SHORTCUTS.map(s => [s.key, s]))
  assert.equal(byKey.get('l')!.description, `Toggle ${g.SESSIONS_LIST_NAME} list`)
  assert.equal(byKey.get('p')!.description, `Toggle ${PANEL_NAMES.context} panel (${g.PANEL_SUMMARIES.context})`)
})

test('hiding a session says what it does and that it comes back (#372)', async () => {
  const g = await import('../web/lib/ui-glossary')
  assert.equal(g.SESSION_LIST_LABELS.hide, 'Hide session (reappears on new activity or after a reconnect)')
  // The accessible name and the tooltip say the same thing, return after a reconnect included
  assert.equal(g.SESSION_LIST_LABELS.hideNamed('Refactor'), 'Hide session Refactor (reappears on new activity or after a reconnect)')
  assert.equal(g.SESSION_LIST_LABELS.hidden('Refactor'), 'Session hidden: Refactor')
  assert.equal(g.SESSION_LIST_LABELS.hiddenUnnamed, 'Session hidden')
  assert.equal(g.SESSION_LIST_LABELS.activeOnly, 'Active only')
  // 'Active only' is not the 10-minute window of the 'All' view: the tooltip says the rule it applies
  // A session-ended also comes from the relay when it stops watching (size cap, read error, scope change):
  // the tooltip must not call every hidden session one whose end was observed
  assert.match(g.SESSION_LIST_LABELS.activeOnlyHelp, /end was observed/)
  assert.match(g.SESSION_LIST_LABELS.activeOnlyHelp, /no longer watched/)
  assert.match(g.SESSION_LIST_LABELS.activeOnlyHelp, /never heard from/)
  assert.match(g.SESSION_LIST_LABELS.activeOnlyHelp, /no time limit/i)
})

test('the retired double meanings are gone from the UI code (#372)', () => {
  const retired = ['Timeline position', 'Timeline scrubber', 'Context usage', 'Close session', 'Session closed', 'Toggle Sessions list', 'Hide sessions that are finished']
  const hits: string[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.next') walk(p); continue }
      if (!/\.(ts|tsx)$/.test(e.name)) continue
      readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        const t = line.trim()
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
        for (const word of retired) if (line.includes(word)) hits.push(`${p}:${i + 1}: ${word}`)
      })
    }
  }
  for (const r of ['web/lib', 'web/hooks', 'web/components', 'web/app']) walk(r)
  assert.deepEqual(hits, [])
})

test('the top bar disclosure under 768 px (#378, #476): its visible text starts its accessible name (2.5.3)', async () => {
  const g = await import('../web/lib/ui-glossary')
  assert.equal(g.TOP_BAR_LABELS.more, 'More')
  assert.ok(g.TOP_BAR_LABELS.moreName.startsWith(g.TOP_BAR_LABELS.more))
  assert.equal(g.TOP_BAR_LABELS.moreName, 'More: panels, totals and filters')
  assert.doesNotMatch(g.TOP_BAR_LABELS.moreHelp, /agent counts/, 'no agent counts in the bar any more (#523: Sessions panel header)')
  assert.doesNotMatch(g.TOP_BAR_LABELS.moreHelp, /tokens|cost/, 'no token total or cost in the bar any more (#523)')
  assert.match(g.TOP_BAR_LABELS.moreHelp, /1024 px/, 'the bar folds under 1024 px (#523), the mobile view stays under 768 px')
})

test('folded with a filter on, the More button says so on screen and in its name (#378)', async () => {
  const g = await import('../web/lib/ui-glossary')
  assert.equal(g.TOP_BAR_LABELS.moreWithFilters(1), 'More · 1 filter')
  assert.equal(g.TOP_BAR_LABELS.moreWithFilters(2), 'More · 2 filters')
  const one = g.TOP_BAR_LABELS.moreNameWithFilters([g.TOP_BAR_LABELS.filterHideInactiveWithCount(3)])
  assert.equal(one, 'More · 1 filter on: panels, totals and filters (Hide inactive · finished sessions hidden: 3)')
  // 2.5.3: the accessible name starts with the visible text
  assert.ok(one.startsWith(g.TOP_BAR_LABELS.moreWithFilters(1)))
  const two = g.TOP_BAR_LABELS.moreNameWithFilters([g.TOP_BAR_LABELS.filterHideInactive, 'Another filter'])
  assert.ok(two.startsWith(g.TOP_BAR_LABELS.moreWithFilters(2)))
  assert.match(two, /Hide inactive, Another filter/)
})

test('no ambiguous filter name: the top bar filter and the Sessions panel filter never share a name (#372)', async () => {
  const g = await import('../web/lib/ui-glossary')
  // Two different rules (agents, plus a 10-minute window in All / a list filter with no time limit): two names that
  // neither equal nor contain each other, in the glossary and in each language of the interface
  const pairs: Array<[string, string, string]> = [
    ['glossary', g.TOP_BAR_LABELS.filterHideInactive, g.SESSION_LIST_LABELS.activeOnly],
    ['en', MESSAGES.en['show.hideInactive'], MESSAGES.en['sessions.activeOnly']],
    ['fr', MESSAGES.fr['show.hideInactive'], MESSAGES.fr['sessions.activeOnly']],
  ]
  for (const [where, bar, panel] of pairs) {
    const a = bar.toLowerCase(), b = panel.toLowerCase()
    assert.notEqual(a, b, `${where}: same name`)
    assert.ok(!a.includes(b) && !b.includes(a), `${where}: "${bar}" and "${panel}" contain each other`)
  }
  // No other message of either language takes the exact name of one of these two filters
  for (const l of ['en', 'fr'] as const) {
    const owners = new Map<string, string>([[MESSAGES[l]['show.hideInactive'], 'show.hideInactive'], [MESSAGES[l]['sessions.activeOnly'], 'sessions.activeOnly']])
    for (const [key, value] of Object.entries(MESSAGES[l])) {
      const owner = owners.get(value)
      if (owner !== undefined) assert.equal(key, owner, `${l}: ${key} reuses the name of ${owner}`)
    }
  }
})
