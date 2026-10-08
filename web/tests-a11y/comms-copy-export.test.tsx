// Copy and export of communications (#128): pure builders, then the Link panel and the Conversation panel
// (native buttons, polite status line, honest notes for every cut).
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import axe from 'axe-core'

import {
  conversationToMarkdown, messageToMarkdown, exportNotes, exportFileName, copyText,
} from '@/lib/comms-export'
import { LINK_MESSAGE_MAX_CHARS } from '@/components/agent-visualizer/canvas/link-panel-model'
import { LinkPanel } from '@/components/agent-visualizer/link-panel'
import { clearPair } from '@/lib/pair-filter-store'
import type { Agent } from '@/lib/agent-types'
import type { AgentLink, ConversationMessage } from '@/hooks/simulation/types'
import { ConversationHarness, createPanelRegistry } from './conversation-harness'

beforeEach(() => clearPair())
afterEach(() => { cleanup(); document.body.replaceChildren(); clearPair() })

const agent = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ id, agentKey: id, sessionId: 's', localId: id, displayName: name, name, parentKey: null, state: 'idle', isMain: false, ...extra } as unknown as Agent)
const agents = new Map<string, Agent>([
  ['o', agent('o', 'orchestrator', { isMain: true })],
  ['u', agent('u', 'audit-ux')],
])
const msg = (id: string, type: ConversationMessage['type'], timestamp: number, content: string, extra: Partial<ConversationMessage> = {}): ConversationMessage =>
  ({ id, type, timestamp, content, ...extra })

// ── Clipboard and download stubs ──
let copied: string[] = []
let clipboardFails = false
const nav = navigator as unknown as { clipboard?: unknown }
let downloads: { name: string; text: string }[] = []
const realCreate = URL.createObjectURL
const RealBlobCtor = globalThis.Blob
const realClick = window.HTMLAnchorElement.prototype.click
beforeEach(() => {
  copied = []; downloads = []; clipboardFails = false
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (t: string) => { if (clipboardFails) throw new Error('denied'); copied.push(t) } },
  })
  ;(URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = () => {}
  const texts = new WeakMap<object, string>()
  const RealBlob = globalThis.Blob
  ;(globalThis as unknown as { Blob: unknown }).Blob = class extends RealBlob {
    constructor(parts: BlobPart[], o?: BlobPropertyBag) { super(parts, o); texts.set(this, parts.join('')) }
  }
  ;(URL as unknown as { createObjectURL: unknown }).createObjectURL = (b: Blob) => { lastBlobText = texts.get(b) ?? ''; return 'blob:x' }
  window.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, text: lastBlobText })
  }
})
let lastBlobText = ''
afterEach(() => {
  ;(URL as unknown as { createObjectURL: unknown }).createObjectURL = realCreate
  window.HTMLAnchorElement.prototype.click = realClick
  ;(globalThis as unknown as { Blob: unknown }).Blob = RealBlobCtor
  delete (nav as { clipboard?: unknown }).clipboard
})

const flush = () => act(async () => { await Promise.resolve() })

// ── Pure builders ──
test('a message is rendered with its label, route, time and a fence that survives backticks', () => {
  const md = messageToMarkdown({ label: 'DISPATCH', sender: 'main', receiver: 'Explorer', time: '0:05', content: 'run ```js\nx\n```' })
  assert.match(md, /^### DISPATCH main -> Explorer \(0:05\)/)
  assert.ok(md.includes('````text\nrun ```js\nx\n```\n````'))
})

test('a truncated message says so in the export, never silently', () => {
  const md = messageToMarkdown({ label: 'RETURN', time: '1:00', content: 'abc', truncatedChars: 12 })
  assert.match(md, /Truncated: 12 characters were cut/)
  assert.doesNotMatch(messageToMarkdown({ label: 'RETURN', time: '1:00', content: 'abc' }), /Truncated/)
})

test('the conversation export states what it does not contain', () => {
  const notes = exportNotes({ droppedText: '3 older messages were dropped', toolsHidden: true, searchQuery: ' foo ' })
  assert.equal(notes.length, 3)
  const md = conversationToMarkdown({ title: 'T', entries: [{ label: 'MESSAGE', time: '0:00', content: 'hi' }], notes })
  assert.match(md, /^# T\n\n1 message\n/)
  assert.match(md, /> Incomplete: 3 older messages were dropped\./)
  assert.match(md, /> Incomplete: tool calls and results were hidden/)
  assert.match(md, /search "foo"/)
  assert.deepEqual(exportNotes({}), [])
})

test('file names are safe slugs', () => {
  assert.equal(exportFileName('Conversation: orchestrator and audit-ux'), 'conversation-orchestrator-and-audit-ux.md')
  assert.equal(exportFileName('???'), 'conversation.md')
})

test('copyText resolves false instead of throwing when the clipboard refuses and no fallback works', async () => {
  clipboardFails = true
  const exec = (document as unknown as { execCommand?: unknown }).execCommand
  ;(document as unknown as { execCommand: unknown }).execCommand = () => false
  assert.equal(await copyText('x'), false)
  ;(document as unknown as { execCommand: unknown }).execCommand = exec
})

// ── Link panel ──
const long = 'x'.repeat(LINK_MESSAGE_MAX_CHARS + 50)
const link = {
  id: 'l', from: 'o', to: 'u', kind: 'spawn', sessionId: 's', dropped: 2,
  messages: [msg('d1', 'dispatch', 5, 'do the audit', { from: 'o', to: 'u' }), msg('r1', 'return', 9, long, { from: 'u', to: 'o' })],
} as unknown as AgentLink

test('link panel: every message has a keyboard-reachable Copy button that copies the full content and announces it', async () => {
  const r = render(<LinkPanel link={link} agents={agents} onClose={() => {}} />)
  const btn = r.getByRole('button', { name: 'Copy dispatch, orchestrator to audit-ux' })
  assert.equal(btn.tagName, 'BUTTON')
  assert.notEqual(btn.getAttribute('tabindex'), '-1')
  fireEvent.click(btn)
  await flush()
  assert.deepEqual(copied, ['do the audit'])
  assert.match(r.getByRole('status').textContent ?? '', /DISPATCH copied/)
})

test('link panel: copying a capped report reports the cut', async () => {
  const r = render(<LinkPanel link={link} agents={agents} onClose={() => {}} />)
  fireEvent.click(r.getByRole('button', { name: /^Copy return/ }))
  await flush()
  assert.match(r.getByRole('status').textContent ?? '', /RETURN copied \(truncated: 51 characters were cut\)/)
})

test('link panel: a refused clipboard is announced as a failure, not as a success', async () => {
  clipboardFails = true
  const exec = (document as unknown as { execCommand?: unknown }).execCommand
  ;(document as unknown as { execCommand: unknown }).execCommand = () => false
  const r = render(<LinkPanel link={link} agents={agents} onClose={() => {}} />)
  fireEvent.click(r.getByRole('button', { name: /^Copy dispatch/ }))
  await flush()
  assert.match(r.getByRole('status').textContent ?? '', /Copy failed/)
  ;(document as unknown as { execCommand: unknown }).execCommand = exec
})

test('link panel: Export conversation downloads Markdown with the dropped and truncated notes', async () => {
  const r = render(<LinkPanel link={link} agents={agents} onClose={() => {}} />)
  fireEvent.click(r.getByRole('button', { name: 'Export conversation' }))
  assert.equal(downloads.length, 1)
  assert.match(downloads[0].name, /\.md$/)
  const text = downloads[0].text
  assert.match(text, /### DISPATCH orchestrator -> audit-ux \(0:05\)/)
  assert.match(text, /Incomplete: 2 older messages were dropped\./)
  assert.match(text, /Truncated: 51 characters were cut/)
  assert.match(r.getByRole('status').textContent ?? '', /exported as Markdown/)
})

test('link panel: axe finds no violation with the new buttons', async () => {
  const r = render(<LinkPanel link={link} agents={agents} onClose={() => {}} />)
  const res = await axe.run(r.container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  })
  assert.deepEqual(res.violations.map(v => v.id), [])
})

// ── Conversation panel ──
const conversations = new Map<string, ConversationMessage[]>([
  ['o', [msg('a1', 'assistant', 1, 'plan'), msg('t1', 'tool_call', 2, 'Read(file.ts)', { toolName: 'Read' })]],
  ['u', [msg('d1', 'dispatch', 5, 'full prompt text', { from: 'o', to: 'u' }), msg('r1', 'return', 8, 'full report', { from: 'u', to: 'o' })]],
])

function panel() {
  return render(
    <ConversationHarness
      registry={createPanelRegistry()} conversations={conversations} agents={agents} selectedAgentId={null}
      onAgentClick={() => {}} initialOpen droppedMessages={new Map([['o', 4]])}
    />,
  )
}

test('conversation panel: Copy only on DISPATCH and RETURN rows, copying the whole content', async () => {
  const r = panel()
  assert.equal(r.getAllByRole('button', { name: /^Copy / }).length, 2)
  fireEvent.click(r.getByRole('button', { name: /^Copy dispatch/ }))
  await flush()
  assert.deepEqual(copied, ['full prompt text'])
  assert.match(r.getAllByRole('status').map(s => s.textContent).join(' '), /DISPATCH copied/)
})

test('conversation panel: export lists the visible messages and flags hidden tools and dropped messages', () => {
  const r = panel()
  fireEvent.click(r.getByRole('button', { name: 'Tool calls' })) // hide tool rows
  fireEvent.click(r.getByRole('button', { name: 'Export conversation' }))
  assert.equal(downloads.length, 1)
  const text = downloads[0].text
  assert.match(text, /^# Conversation: all agents/)
  assert.match(text, /full prompt text/)
  assert.doesNotMatch(text, /Read\(file\.ts\)/)
  assert.match(text, /Incomplete: tool calls and results were hidden/)
  assert.match(text, /Incomplete: .*dropped/i)
})
