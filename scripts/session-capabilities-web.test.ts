/**
 * Web side of the capabilities view (#242): the relay payload is untrusted and validated field by field;
 * skills are grouped by plugin (the `plugin:skill` namespace), nothing is guessed.
 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { parseProjectContext } from '../web/lib/project-context'
import { groupSkillsByPlugin, parseSessionCapabilities, type SessionCapabilities } from '../web/lib/session-capabilities'

const caps = (over: Partial<SessionCapabilities> = {}): SessionCapabilities => ({
  status: 'ok', partial: false, truncated: false,
  instructions: [{ type: 'Project', name: 'CLAUDE.md' }],
  skillsInvoked: [{ name: 'tools:lint', calls: 2 }],
  skillsListed: ['loop', 'tools:lint', 'tools:fmt'],
  mcpServers: [{ name: 'github', announced: true, calls: 1, tools: [{ name: 'issue_read', calls: 1 }] }],
  ...over,
})

const payload = (extra: Record<string, unknown> = {}) => ({ sessionId: 's', loadedAt: 1, files: [], issues: [], ...extra })

test('an older relay without the field leaves capabilities undefined (not provided, not empty)', () => {
  const parsed = parseProjectContext(payload())
  assert.ok(parsed)
  assert.equal(parsed.capabilities, undefined)
})

test('a valid capabilities object is kept as is', () => {
  const parsed = parseProjectContext(payload({ capabilities: caps() }))
  assert.deepEqual(parsed?.capabilities, caps())
})

test('a malformed capabilities field is flagged invalid without hiding the files', () => {
  for (const bad of [
    null, 'x', { ...caps(), status: 'great' },
    { ...caps(), skillsInvoked: [{ name: 'a', calls: -1 }] },
    { ...caps(), skillsInvoked: [{ name: 'a', calls: 1.5 }] },
    { ...caps(), skillsListed: [3] },
    { ...caps(), mcpServers: [{ name: 'g', announced: 'yes', calls: 0, tools: [] }] },
    { ...caps(), instructions: [{ type: 'Project' }] },
    { ...caps(), skillsListed: Array.from({ length: 1000 }, (_, i) => `s${i}`) },
  ]) {
    const parsed = parseProjectContext(payload({ capabilities: bad }))
    assert.ok(parsed, JSON.stringify(bad))
    assert.equal(parsed.capabilities, 'invalid', JSON.stringify(bad))
  }
})

test('parseSessionCapabilities bounds name length', () => {
  assert.equal(parseSessionCapabilities(caps({ skillsListed: ['x'.repeat(500)] })), null)
})

test('skills are grouped by plugin; invoked first, then listed only; no-plugin group last', () => {
  const groups = groupSkillsByPlugin(caps({
    skillsInvoked: [{ name: 'tools:lint', calls: 2 }, { name: 'adhoc', calls: 1 }, { name: 'tools:deploy', calls: 5 }],
    skillsListed: ['loop', 'tools:lint', 'tools:fmt'],
  }))
  assert.deepEqual(groups, [
    { plugin: 'tools', skills: [
      { name: 'deploy', fullName: 'tools:deploy', calls: 5, listed: false },
      { name: 'lint', fullName: 'tools:lint', calls: 2, listed: true },
      { name: 'fmt', fullName: 'tools:fmt', calls: 0, listed: true },
    ] },
    { plugin: null, skills: [
      { name: 'adhoc', fullName: 'adhoc', calls: 1, listed: false },
      { name: 'loop', fullName: 'loop', calls: 0, listed: true },
    ] },
  ])
})

test('a name without a plugin part before or after the colon is not split', () => {
  const groups = groupSkillsByPlugin(caps({ skillsInvoked: [], skillsListed: [':odd', 'odd:'] }))
  assert.deepEqual(groups.map(g => g.plugin), [null])
})
