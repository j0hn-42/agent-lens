import { test } from 'node:test'
import assert from 'node:assert/strict'
import { togglePanelFlags, openConversationFlags, shouldAutoOpenConversation, type PanelFlags } from '../web/lib/exclusive-panels'

const none: PanelFlags = { files: false, conversation: false, context: false, cost: false }

test('files, conversation and context are mutually exclusive', () => {
  assert.deepEqual(togglePanelFlags({ ...none, conversation: true }, 'files'), { ...none, files: true })
  assert.deepEqual(togglePanelFlags({ ...none, files: true }, 'context'), { ...none, context: true })
  assert.deepEqual(togglePanelFlags({ ...none, context: true }, 'conversation'), { ...none, conversation: true })
})

test('toggling an open panel closes it', () => {
  assert.deepEqual(togglePanelFlags({ ...none, files: true }, 'files'), none)
})

test('cost is independent: it neither closes nor is closed by the others (#370)', () => {
  assert.deepEqual(togglePanelFlags({ ...none, conversation: true }, 'cost'), { ...none, conversation: true, cost: true })
  assert.deepEqual(togglePanelFlags({ ...none, conversation: true, cost: true }, 'files'), { ...none, files: true, cost: true })
  assert.deepEqual(togglePanelFlags({ ...none, cost: true }, 'cost'), none)
})

test('opening Conversation keeps cost', () => {
  assert.deepEqual(openConversationFlags({ ...none, files: true, cost: true }), { ...none, conversation: true, cost: true })
})

test('selecting an agent opens Conversation only when no exclusive panel is open (#370)', () => {
  assert.equal(shouldAutoOpenConversation(none, 1280), true)
  assert.equal(shouldAutoOpenConversation({ ...none, cost: true }, 1280), true)
  assert.equal(shouldAutoOpenConversation({ ...none, files: true }, 1280), false)
  assert.equal(shouldAutoOpenConversation({ ...none, context: true }, 1280), false)
})

test('selecting an agent never opens Conversation on a narrow viewport (#116)', () => {
  assert.equal(shouldAutoOpenConversation(none, 899), false)
})
