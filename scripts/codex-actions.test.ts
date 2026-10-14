// Codex tools (#317): `shell` / `exec_command` are Bash-like, `apply_patch` is an edit whose figures
// are counted from the patch text, and only when that text is complete.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { toolGlyph, patchStats, shellCommands, isShellTool, canonicalTool, todoProgress, todoItems, PATCH_CAPTURE_LIMIT } from '../web/lib/action-summary'

test('canonicalTool: other runtimes\' names map to the tool they correspond to', () => {
  const expected: Record<string, string> = {
    bash: 'Bash', powershell: 'Bash', shell: 'Bash', exec_command: 'Bash',
    view: 'Read', edit: 'Edit', str_replace_editor: 'Edit', create: 'Write',
    grep: 'Grep', glob: 'Glob', web_fetch: 'WebFetch', web_search_call: 'WebSearch', task: 'Task', update_plan: 'TodoWrite',
  }
  for (const [name, canon] of Object.entries(expected)) assert.equal(canonicalTool(name), canon, name)
  assert.equal(canonicalTool('Grep'), 'Grep')
  assert.equal(canonicalTool('apply_patch'), 'apply_patch')
  assert.equal(canonicalTool('mcp__srv__grep'), 'mcp__srv__grep')
})

test('glyphs follow the aliases: grep, glob, view, create, update_plan', () => {
  assert.equal(toolGlyph('grep', {}), 'search')
  assert.equal(toolGlyph('glob', {}), 'search')
  assert.equal(toolGlyph('view', {}), 'read')
  assert.equal(toolGlyph('create', {}), 'write')
  assert.equal(toolGlyph('update_plan', {}), 'todo')
  assert.equal(toolGlyph('bash', { command: 'pytest' }), 'test')
})

test('Codex update_plan: plan steps count like todos', () => {
  const plan = [{ step: 'a', status: 'completed' }, { step: 'b', status: 'in_progress' }, { step: 'c', status: 'pending' }]
  assert.deepEqual(todoItems({ plan }), [
    { content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' },
  ])
  assert.deepEqual(todoProgress({ plan }), { done: 1, active: 1, total: 3 })
  assert.equal(todoItems({ plan: 'x' }), null)
})

test('shell and exec_command are shell tools, others are not', () => {
  assert.equal(isShellTool('Bash'), true)
  assert.equal(isShellTool('shell'), true)
  assert.equal(isShellTool('exec_command'), true)
  assert.equal(isShellTool('apply_patch'), false)
  assert.equal(isShellTool('mcp__x__shell'), false)
})

test('glyphs: shell tools classify the command, apply_patch is an edit', () => {
  assert.equal(toolGlyph('shell', { command: 'git status' }), 'git')
  assert.equal(toolGlyph('exec_command', { command: 'pnpm test' }), 'test')
  assert.equal(toolGlyph('shell', { command: 'rg -l x docs/' }), 'shell')
  assert.equal(toolGlyph('shell', undefined), 'shell')
  assert.equal(toolGlyph('apply_patch', { patch: '' }), 'edit')
  assert.equal(toolGlyph('apply_patch', undefined), 'edit')
})

const PATCH = [
  '*** Begin Patch',
  '*** Update File: docs/a.md',
  '@@ intro',
  ' context',
  '-old line',
  '-another old',
  '+new line',
  '*** Add File: docs/b.md',
  '+first',
  '+second',
  '*** Delete File: docs/c.md',
  '*** End Patch',
].join('\n')

test('patchStats: files with their operation, lines added and removed', () => {
  assert.deepEqual(patchStats({ patch: PATCH }), {
    files: [
      { op: 'update', path: 'docs/a.md' },
      { op: 'add', path: 'docs/b.md' },
      { op: 'delete', path: 'docs/c.md' },
    ],
    added: 3,
    removed: 2,
  })
})

test('patchStats: a patch cut at the capture limit proves no count', () => {
  const cut = PATCH.padEnd(PATCH_CAPTURE_LIMIT, ' ')
  assert.equal(patchStats({ patch: cut }), null)
})

test('patchStats: nothing usable, nothing shown', () => {
  assert.equal(patchStats({}), null)
  assert.equal(patchStats({ patch: 4 }), null)
  assert.equal(patchStats({ patch: 'just some text' }), null)
})

test('shell tools reuse the git / gh parsing', () => {
  assert.deepEqual(shellCommands('git commit -m x'), [{ tool: 'git', sub: 'commit' }])
})
