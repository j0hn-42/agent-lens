import { test } from 'node:test'
import assert from 'node:assert/strict'
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
  assert.deepEqual(PANEL_NAMES, { conversation: 'Conversation', files: 'Files', timeline: 'Timeline', cost: 'Cost' })
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
