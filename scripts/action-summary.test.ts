// Per-action summaries (#317): every figure comes from the call's own input, nothing is inferred.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { editStats, shellCommands } from '../web/lib/action-summary'

test('Edit: counts the lines of old_string and new_string', () => {
  const s = editStats('Edit', { file_path: '/a.ts', old_string: 'a\nb\nc', new_string: 'x\ny' })
  assert.deepEqual(s, { added: 2, removed: 3, blocks: null })
})

test('Edit: an empty old_string removes nothing, an empty new_string adds nothing', () => {
  assert.deepEqual(editStats('Edit', { old_string: '', new_string: 'a\nb' }), { added: 2, removed: 0, blocks: null })
  assert.deepEqual(editStats('Edit', { old_string: 'a', new_string: '' }), { added: 0, removed: 1, blocks: null })
})

test('MultiEdit: sums every block and reports the block count', () => {
  const s = editStats('MultiEdit', {
    file_path: '/a.ts',
    edits: [
      { old_string: 'a', new_string: 'b\nc' },
      { old_string: 'd\ne', new_string: 'f' },
    ],
  })
  assert.deepEqual(s, { added: 3, removed: 3, blocks: 2 })
})

test('Edit with missing or non-string input shows nothing instead of a guess', () => {
  assert.equal(editStats('Edit', {}), null)
  assert.equal(editStats('Edit', { old_string: 3, new_string: 'a' }), null)
  assert.equal(editStats('MultiEdit', { edits: 'oops' }), null)
  assert.equal(editStats('MultiEdit', { edits: [{ old_string: 'a' }] }), null)
  assert.equal(editStats('Read', { old_string: 'a', new_string: 'b' }), null)
})

test('shellCommands: git subcommand read from the command itself', () => {
  assert.deepEqual(shellCommands('git commit -m "x"'), [{ tool: 'git', sub: 'commit' }])
  assert.deepEqual(shellCommands('git -C /repo push origin main'), [{ tool: 'git', sub: 'push' }])
  assert.deepEqual(shellCommands('git checkout -b feat/x'), [{ tool: 'git', sub: 'checkout -b' }])
})

test('shellCommands: gh area and subcommand', () => {
  assert.deepEqual(shellCommands('gh pr create --repo o/r --title t'), [{ tool: 'gh', sub: 'pr create' }])
  assert.deepEqual(shellCommands('gh issue view 317'), [{ tool: 'gh', sub: 'issue view' }])
  assert.deepEqual(shellCommands('gh run'), [{ tool: 'gh', sub: 'run' }])
})

test('shellCommands: compound commands list each distinct git/gh call, others are ignored', () => {
  assert.deepEqual(
    shellCommands('cd web && FOO=1 git add -A && git commit -m x; ls | grep y; git add b'),
    [{ tool: 'git', sub: 'add' }, { tool: 'git', sub: 'commit' }],
  )
})

test('shellCommands: quoted text and look-alike words are not commands', () => {
  assert.deepEqual(shellCommands('echo "git push && gh pr merge"'), [])
  assert.deepEqual(shellCommands('gitk --all'), [])
  assert.deepEqual(shellCommands('ls'), [])
  assert.deepEqual(shellCommands(''), [])
})

test('shellCommands: a bare git or gh has no subcommand to claim', () => {
  assert.deepEqual(shellCommands('git'), [])
  assert.deepEqual(shellCommands('git --version'), [])
})
