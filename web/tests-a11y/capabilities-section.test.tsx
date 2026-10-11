// Capabilities of a session in the Context panel (#242): instructions, skills by plugin, MCP servers.
// Every value comes from the transcript; what is unknown, partial or absent is said so; native disclosures, axe-clean.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import axe from 'axe-core'

import { ProjectContextPanel } from '@/components/agent-visualizer/project-context-panel'
import type { ProjectContextData } from '@/lib/project-context'
import type { SessionCapabilities } from '@/lib/session-capabilities'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const noop = () => {}
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

const caps = (over: Partial<SessionCapabilities> = {}): SessionCapabilities => ({
  status: 'ok', partial: false, truncated: false,
  instructions: [{ type: 'Project', name: 'CLAUDE.md' }, { type: 'AutoMem', name: 'MEMORY.md' }],
  skillsInvoked: [{ name: 'tools:lint', calls: 2 }],
  skillsListed: ['loop', 'tools:lint'],
  mcpServers: [
    { name: 'github', announced: true, calls: 3, tools: [{ name: 'issue_read', calls: 3 }] },
    { name: 'Notion', announced: true, calls: 0, tools: [] },
  ],
  ...over,
})

const ctx = (capabilities: ProjectContextData['capabilities']): ProjectContextData => ({
  sessionId: 's1', loadedAt: 1,
  files: [{ kind: 'claude-md', name: 'CLAUDE.md', found: true, text: 'rules', bytes: 5, truncated: false }],
  issues: [],
  ...(capabilities === undefined ? {} : { capabilities }),
})

async function show(capabilities: ProjectContextData['capabilities']) {
  const fetchContext = async () => ctx(capabilities)
  const r = render(<ProjectContextPanel visible sessionId="s1" fetchContext={fetchContext} onClose={noop} />)
  await flush()
  return r
}

async function violations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
  })
  return results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.html).join(' | ')}`)
}

const section = (container: HTMLElement) => {
  const el = container.querySelector('section[aria-labelledby="context-capabilities-title"]')
  assert.ok(el, 'capabilities section is rendered')
  return el as HTMLElement
}

test('shows instructions, skills grouped by plugin and MCP servers, with their source', async () => {
  const { container } = await show(caps())
  const s = section(container)
  const text = s.textContent ?? ''
  assert.match(text, /CAPABILITIES/)
  assert.match(text, /session transcript/i)
  assert.match(text, /sub-agents are not included/i)
  assert.match(text, /CLAUDE\.md/)
  assert.match(text, /Project/)
  assert.match(text, /tools/)
  assert.match(text, /lint[\s\S]*invoked 2 times/)
  assert.match(text, /loop[\s\S]*listed, no invocation seen/)
  assert.match(text, /No plugin/)
  assert.match(text, /github[\s\S]*announced[\s\S]*3 tool calls/)
  assert.match(text, /Notion[\s\S]*announced[\s\S]*no tool call seen/)
})

test('the groups are native disclosures, reachable and operable with the keyboard', async () => {
  const { container } = await show(caps())
  const summaries = [...section(container).querySelectorAll('details > summary')]
  assert.ok(summaries.length >= 3)
  for (const s of summaries) {
    assert.ok((s.textContent ?? '').trim().length > 0, 'summary has an accessible name')
    assert.ok(s.className.includes('focus-visible'), 'summary shows a focus ring')
  }
  const skills = summaries.find(s => /Skills/.test(s.textContent ?? ''))!
  const details = skills.parentElement as HTMLDetailsElement
  const was = details.open
  fireEvent.click(skills)
  assert.equal(details.open, !was)
})

test('a partial transcript turns counts into lower bounds', async () => {
  const { container } = await show(caps({ partial: true }))
  const text = section(container).textContent ?? ''
  assert.match(text, /Partial: only the first 32 MB/)
  assert.match(text, /invoked at least 2 times/)
  assert.match(text, /at least 3 tool calls/)
})

test('capped lists are reported', async () => {
  const { container } = await show(caps({ truncated: true }))
  assert.match(section(container).textContent ?? '', /some entries are not shown/i)
})

test('an unreadable transcript is a stated failure, not empty lists', async () => {
  const { container } = await show(caps({ status: 'unreadable', instructions: [], skillsInvoked: [], skillsListed: [], mcpServers: [] }))
  const text = section(container).textContent ?? ''
  assert.match(text, /transcript could not be read/i)
  assert.doesNotMatch(text, /No .* in the transcript/)
})

test('no trace is worded as such, never as "no skills"', async () => {
  const { container } = await show(caps({ instructions: [], skillsInvoked: [], skillsListed: [], mcpServers: [] }))
  const text = section(container).textContent ?? ''
  assert.match(text, /No instructions attachment in the transcript/)
  assert.match(text, /No skill listing or Skill call in the transcript/)
  assert.match(text, /No MCP server announced or called in the transcript/)
  assert.doesNotMatch(text, /no skills\b/i)
})

test('an older relay without the field and a malformed field are both explained', async () => {
  let r = await show(undefined)
  assert.match(section(r.container).textContent ?? '', /Not provided by this relay/)
  cleanup()
  r = await show('invalid')
  assert.match(section(r.container).textContent ?? '', /unexpected shape/)
})

test('axe: full, partial, unreadable and absent capabilities have no violations', async () => {
  for (const c of [caps(), caps({ partial: true, truncated: true }), caps({ status: 'unreadable', instructions: [], skillsInvoked: [], skillsListed: [], mcpServers: [] }), undefined]) {
    const { container, unmount } = await show(c)
    assert.deepEqual(await violations(container), [])
    unmount()
  }
})
