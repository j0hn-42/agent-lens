import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  PANEL_NAMES, HIERARCHY_TERMS, HIERARCHY_TEXT, CONVERSATION_LABELS, emptyState, emptyMatch, openPanelLabel,
} from '../web/lib/ui-glossary'
import { SHORTCUTS } from '../web/lib/shortcuts'
import {
  EMPTY_MESSAGES, EMPTY_SEARCH, COLLAPSED_TEXT_MAX, TOOL_MESSAGE_TYPES, buildFeedMessages, latestFeedMessage,
  filterBySearch, tabForSelection,
} from '../web/lib/feed-utils'
import type { ConversationMessage } from '../web/hooks/simulation/types'

const msg = (id: string, type: ConversationMessage['type'], timestamp: number, content: string, extra: Partial<ConversationMessage> = {}): ConversationMessage =>
  ({ id, type, timestamp, content, ...extra })

test('the glossary fixes the panel names and the agent hierarchy', () => {
  assert.deepEqual(PANEL_NAMES, { conversation: 'Conversation', files: 'Files', timeline: 'Timeline', cost: 'Cost', context: 'Context', stats: 'Stats' })
  assert.equal(HIERARCHY_TERMS.main, 'Main')
  assert.equal(HIERARCHY_TERMS.lead, 'Lead')
  assert.equal(HIERARCHY_TEXT, 'Session > Agent (Main / Lead) > Subagent / Teammate')
})

test('one empty-state wording: "No <things> yet", shared by the glossary and the message lists', () => {
  assert.equal(emptyState('files'), 'No files yet')
  assert.equal(emptyMatch('messages'), 'No matching messages')
  assert.equal(CONVERSATION_LABELS.empty, 'No messages yet')
  assert.equal(EMPTY_MESSAGES, CONVERSATION_LABELS.empty)
  assert.equal(EMPTY_SEARCH, CONVERSATION_LABELS.emptySearch)
})

test('the Conversation button is named with its shortcut and the pill/close controls use the same name', () => {
  assert.equal(openPanelLabel('conversation', 'C'), 'Conversation (C)')
  assert.equal(CONVERSATION_LABELS.buttonLabel, 'Conversation (C)')
  assert.equal(CONVERSATION_LABELS.buttonText, 'Conversation')
  assert.equal(CONVERSATION_LABELS.open, 'Open Conversation')
  assert.equal(CONVERSATION_LABELS.close, 'Close Conversation')
})

test('the shortcuts table names the panels with the glossary words; key C toggles the Conversation panel', () => {
  const byKey = new Map(SHORTCUTS.map(s => [s.key, s]))
  assert.equal(byKey.get('c')!.description, 'Toggle Conversation panel')
  assert.equal(byKey.get('f')!.description, 'Toggle Files panel')
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
  assert.deepEqual(glossary.USAGE_LABELS, { unavailable: 'not reported', atLeast: 'at least', estimated: 'estimated' })
  assert.equal(lifecycle.END_NOT_OBSERVED, glossary.END_NOT_OBSERVED)
  assert.equal(lifecycle.EXPIRED_WARNING, glossary.EXPIRED_WARNING)
  assert.equal(usage.USAGE_LABELS, glossary.USAGE_LABELS)
})

test('no accented character in UI code outside comments (the UI is English only, #123)', () => {
  const allowed = new Set<string>([]) // files that may carry accented text
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
