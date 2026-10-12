/**
 * Capabilities of a session (#242): instructions, skills, plugins and MCP servers, read from what the main
 * transcript recorded (never from what is installed on the machine). Bounded read, names only, no content.
 */
import { test, describe, after } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { collectSessionCapabilities, readSessionCapabilities } from '../extension/src/session-capabilities'
import { SESSION_CAPABILITIES_MAX_ITEMS, SESSION_CAPABILITIES_MAX_NAME } from '../extension/src/constants'

const line = (o: unknown) => JSON.stringify(o)
const attachment = (a: unknown, extra: Record<string, unknown> = {}) => line({ type: 'attachment', attachment: a, cwd: '/home/me/secret-project', ...extra })
const toolUse = (name: string, input: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t-${Math.random()}`, name, input }] }, ...extra })

describe('collectSessionCapabilities', () => {
  test('lists the instruction files by type and base name, never by path', () => {
    const caps = collectSessionCapabilities([
      attachment({ type: 'instructions', files: [
        { type: 'Project', path: '/home/me/secret-project/CLAUDE.md', content: 'TOKEN=abc' },
        { type: 'AutoMem', path: '/home/me/.claude/projects/x/memory/MEMORY.md', content: 'private' },
      ] }),
      attachment({ type: 'nested_memory', path: '/home/me/secret-project/web/CLAUDE.md', content: { content: 'nested secret' } }),
      // same file seen twice: listed once
      attachment({ type: 'instructions', files: [{ type: 'Project', path: '/home/me/secret-project/CLAUDE.md' }] }),
    ])
    assert.deepEqual(caps.instructions, [
      { type: 'Project', name: 'CLAUDE.md' },
      { type: 'AutoMem', name: 'MEMORY.md' },
      { type: 'nested', name: 'CLAUDE.md' },
    ])
    const json = JSON.stringify(caps)
    for (const leak of ['/home/me', 'TOKEN', 'private', 'nested secret']) assert.ok(!json.includes(leak), `leaks ${leak}`)
  })

  test('counts Skill invocations by name without keeping their arguments', () => {
    const caps = collectSessionCapabilities([
      toolUse('Skill', { skill: 'code-review', args: 'password=hunter2' }),
      toolUse('Skill', { skill: 'code-review' }),
      toolUse('Skill', { skill: 'anthropic-skills:pdf' }),
      toolUse('Skill', { notASkill: true }),
    ])
    assert.deepEqual(caps.skillsInvoked, [{ name: 'code-review', calls: 2 }, { name: 'anthropic-skills:pdf', calls: 1 }])
    assert.ok(!JSON.stringify(caps).includes('hunter2'))
  })

  test('keeps the union of the skill listings (names only, not their descriptions)', () => {
    const caps = collectSessionCapabilities([
      attachment({ type: 'skill_listing', content: '- loop: secret description', names: ['loop', 'anthropic-skills:pdf'] }),
      attachment({ type: 'skill_listing', content: '', names: ['loop', 'simplify'] }),
    ])
    assert.deepEqual(caps.skillsListed, ['loop', 'anthropic-skills:pdf', 'simplify'])
    assert.ok(!JSON.stringify(caps).includes('secret description'))
  })

  test('groups MCP tool calls by server and marks the servers the session announced', () => {
    const caps = collectSessionCapabilities([
      attachment({ type: 'mcp_instructions_delta', addedNames: ['github', 'Notion'], addedBlocks: ['## github\nsecret instructions'] }),
      toolUse('mcp__github__issue_read', { owner: 'o', repo: 'r' }),
      toolUse('mcp__github__issue_read', { owner: 'o', repo: 'r' }),
      toolUse('mcp__github__create_pull_request', {}),
      toolUse('mcp__claude_ai_Gmail__send_message', { body: 'mail body' }),
      toolUse('Read', { file_path: '/etc/passwd' }),
    ])
    assert.deepEqual(caps.mcpServers, [
      { name: 'github', announced: true, calls: 3, tools: [{ name: 'issue_read', calls: 2 }, { name: 'create_pull_request', calls: 1 }] },
      { name: 'Notion', announced: true, calls: 0, tools: [] },
      { name: 'claude_ai_Gmail', announced: false, calls: 1, tools: [{ name: 'send_message', calls: 1 }] },
    ])
    const json = JSON.stringify(caps)
    for (const leak of ['secret instructions', 'mail body', '/etc/passwd']) assert.ok(!json.includes(leak), `leaks ${leak}`)
  })

  test('ignores sub-agent (sidechain) lines, malformed JSON and unknown shapes', () => {
    const caps = collectSessionCapabilities([
      toolUse('Skill', { skill: 'from-subagent' }, { isSidechain: true }),
      '{not json',
      '',
      line({ type: 'attachment', attachment: 'nope' }),
      attachment({ type: 'skill_listing', names: 'not-an-array' }),
      attachment({ type: 'instructions', files: [{ type: 3, path: 42 }] }),
      line({ type: 'assistant', message: { content: 'text only' } }),
    ])
    assert.deepEqual(caps, { instructions: [], skillsInvoked: [], skillsListed: [], mcpServers: [], truncated: false })
  })

  test('strips control characters and bounds name length', () => {
    const long = 'a'.repeat(SESSION_CAPABILITIES_MAX_NAME + 50)
    const caps = collectSessionCapabilities([
      toolUse('Skill', { skill: `evil\u001b[31m\nname` }),
      toolUse('Skill', { skill: long }),
    ])
    assert.equal(caps.skillsInvoked[0].name, 'evil[31mname')
    assert.equal(caps.skillsInvoked[1].name.length, SESSION_CAPABILITIES_MAX_NAME)
  })

  test('caps every list and says so', () => {
    const lines = Array.from({ length: SESSION_CAPABILITIES_MAX_ITEMS + 5 }, (_, i) => toolUse('Skill', { skill: `s${i}` }))
    const caps = collectSessionCapabilities(lines)
    assert.equal(caps.skillsInvoked.length, SESSION_CAPABILITIES_MAX_ITEMS)
    assert.equal(caps.truncated, true)
  })
})

describe('readSessionCapabilities', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-caps-')))
  const projects = path.join(root, 'projects', 'p')
  fs.mkdirSync(projects, { recursive: true })
  after(() => fs.rmSync(root, { recursive: true, force: true }))

  test('reads a transcript inside the root', () => {
    const f = path.join(projects, 'a.jsonl')
    fs.writeFileSync(f, [toolUse('Skill', { skill: 'loop' }), ''].join('\n'))
    const caps = readSessionCapabilities(f, path.join(root, 'projects'))
    assert.equal(caps.status, 'ok')
    assert.equal(caps.partial, false)
    assert.deepEqual(caps.skillsInvoked, [{ name: 'loop', calls: 1 }])
  })

  test('reads only the head of a large transcript and reports it as partial', () => {
    const f = path.join(projects, 'big.jsonl')
    const first = toolUse('Skill', { skill: 'early' })
    const late = toolUse('Skill', { skill: 'late' })
    fs.writeFileSync(f, `${first}\n${'x'.repeat(2000)}\n${late}\n`)
    const caps = readSessionCapabilities(f, path.join(root, 'projects'), first.length + 100)
    assert.equal(caps.status, 'ok')
    assert.equal(caps.partial, true)
    assert.deepEqual(caps.skillsInvoked.map(s => s.name), ['early'])
  })

  test('a missing, symlinked or out-of-root transcript is unreadable, never an empty list', () => {
    const outside = path.join(root, 'outside.jsonl')
    fs.writeFileSync(outside, toolUse('Skill', { skill: 'x' }) + '\n')
    const link = path.join(projects, 'link.jsonl')
    fs.symlinkSync(outside, link)
    for (const f of [path.join(projects, 'missing.jsonl'), link, outside, projects]) {
      const caps = readSessionCapabilities(f, path.join(root, 'projects'))
      assert.equal(caps.status, 'unreadable', f)
      assert.deepEqual(caps.skillsInvoked, [], f)
    }
  })
})
