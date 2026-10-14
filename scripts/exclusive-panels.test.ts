import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldAutoOpenConversation } from '../web/lib/exclusive-panels'

const none = { files: false, context: false }

test('selecting an agent opens Conversation only when Files and Context are closed (#370)', () => {
  assert.equal(shouldAutoOpenConversation(none, 1280, 900), true)
  assert.equal(shouldAutoOpenConversation({ ...none, files: true }, 1280, 900), false)
  assert.equal(shouldAutoOpenConversation({ ...none, context: true }, 1280, 900), false)
})

test('selecting an agent never opens Conversation on a narrow viewport (#116)', () => {
  assert.equal(shouldAutoOpenConversation(none, 899, 900), false)
  assert.equal(shouldAutoOpenConversation(none, 900, 900), true)
})
