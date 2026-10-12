// Per-action summaries (#317): every figure comes from the call's own input, nothing is inferred.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { editStats, shellCommands, writeStats, readRange, ghResultLink, searchResultCount, resultPill, RESULT_CAPTURE_LIMIT } from '../web/lib/action-summary'

test('writeStats: line count of the content, null when absent', () => {
  assert.deepEqual(writeStats({ file_path: '/a', content: 'a\nb\nc' }), { lines: 3 })
  assert.deepEqual(writeStats({ content: '' }), { lines: 0 })
  assert.equal(writeStats({ file_path: '/a' }), null)
  assert.equal(writeStats({ content: 4 }), null)
})

test('readRange: only what offset / limit state', () => {
  assert.deepEqual(readRange({ offset: 10, limit: 50 }), { from: 10, to: 59 })
  assert.deepEqual(readRange({ limit: 20 }), { from: 1, to: 20 })
  assert.deepEqual(readRange({ offset: 100 }), { from: 100, to: null })
  assert.equal(readRange({}), null)
  assert.equal(readRange({ offset: 0, limit: 0 }), null)
  assert.equal(readRange({ offset: '5' }), null)
})

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

// Pills read from the result: only what the tool's own output proves.

const PR_OUT = 'Creating pull request for feat/x into develop in o/r\n\nhttps://github.com/o/r/pull/42\n'

test('ghResultLink: PR or issue number and URL printed by a gh call', () => {
  assert.deepEqual(ghResultLink('gh pr create --repo o/r --title t', PR_OUT), { kind: 'pr', number: 42, url: 'https://github.com/o/r/pull/42' })
  assert.deepEqual(
    ghResultLink('git push -u origin x && gh issue create --title t', 'https://github.com/j0hn-42/agent-lens/issues/317'),
    { kind: 'issue', number: 317, url: 'https://github.com/j0hn-42/agent-lens/issues/317' },
  )
})

test('ghResultLink: nothing without a gh call', () => {
  assert.equal(ghResultLink('echo https://github.com/o/r/pull/42', 'https://github.com/o/r/pull/42'), null)
  assert.equal(ghResultLink('echo "gh pr create"', 'https://github.com/o/r/pull/42'), null)
  assert.equal(ghResultLink('git push', 'https://github.com/o/r/pull/42'), null)
})

test('ghResultLink: nothing without an exact github.com issue / PR URL', () => {
  const cmd = 'gh pr create --title t'
  assert.equal(ghResultLink(cmd, 'Creating pull request...'), null)
  assert.equal(ghResultLink(cmd, ''), null)
  assert.equal(ghResultLink(cmd, 'https://gitlab.com/o/r/pull/42'), null)
  assert.equal(ghResultLink(cmd, 'https://github.com.evil.io/o/r/pull/42'), null)
  assert.equal(ghResultLink(cmd, 'http://github.com/o/r/pull/42'), null)
  assert.equal(ghResultLink(cmd, 'https://github.com/o/r/pull/1/files'), null)
  assert.equal(ghResultLink(cmd, 'https://github.com/o/r/issues/7#issuecomment-123'), null)
  assert.equal(ghResultLink(cmd, 'see https://github.com/o/r/pull/42 for details'), null)
})

test('ghResultLink: a failed call proves nothing', () => {
  assert.equal(ghResultLink('gh pr create', '[FAILED] https://github.com/o/r/pull/42'), null)
  assert.equal(ghResultLink('gh pr create', '[FAILED] error\nhttps://github.com/o/r/pull/42\n'), null)
})

test('ghResultLink: two different URLs are ambiguous, the same one repeated is not', () => {
  assert.equal(ghResultLink('gh pr list', 'https://github.com/o/r/pull/1\nhttps://github.com/o/r/pull/2\n'), null)
  assert.equal(ghResultLink('gh pr view 1', 'https://github.com/o/r/pull/1\nhttps://github.com/o/r/pull/1\n')?.number, 1)
})

test('ghResultLink: a URL that may have been cut by the capture limit is not trusted', () => {
  const url = 'https://github.com/o/r/pull/4'
  const head = 'x'.repeat(RESULT_CAPTURE_LIMIT - url.length - 1) + '\n'
  const cut = head + url
  assert.equal(cut.length, RESULT_CAPTURE_LIMIT)
  assert.equal(ghResultLink('gh pr create', cut), null)
  // The same line closed by a newline is whole
  assert.equal(ghResultLink('gh pr create', head.slice(1) + url + '\n')?.number, 4)
})

test('RESULT_CAPTURE_LIMIT mirrors RESULT_MAX of the extension', () => {
  const src = readFileSync(join(__dirname, '..', 'extension/src/constants.ts'), 'utf8')
  assert.equal(Number(/export const RESULT_MAX = (\d+)/.exec(src)?.[1]), RESULT_CAPTURE_LIMIT)
})

test('searchResultCount: the count Grep / Glob report, never a line count', () => {
  assert.equal(searchResultCount('Grep', 'Found 47 files\n/a.ts\n/b.ts'), 47)
  assert.equal(searchResultCount('Glob', 'Found 1 file\n/a.ts'), 1)
  assert.equal(searchResultCount('grep', 'Found 3 files\n/a'), 3)
  assert.equal(searchResultCount('Grep', '/a.ts\n/b.ts\n/c.ts'), null)
  assert.equal(searchResultCount('Grep', 'No files found'), null)
  assert.equal(searchResultCount('Grep', 'Found 12 lines'), null)
  assert.equal(searchResultCount('Grep', 'Found 47 filesystem entries'), null)
  assert.equal(searchResultCount('Grep', '[FAILED] Found 2 files'), null)
  assert.equal(searchResultCount('Bash', 'Found 2 files'), null)
  assert.equal(searchResultCount('Read', 'Found 2 files'), null)
})

test('resultPill: shell calls give the gh link, Grep / Glob the count, others nothing', () => {
  assert.deepEqual(resultPill('Bash', { command: 'gh pr create' }, PR_OUT), { kind: 'link', link: { kind: 'pr', number: 42, url: 'https://github.com/o/r/pull/42' } })
  assert.deepEqual(resultPill('Glob', { pattern: '**/*.ts' }, 'Found 2 files\n/a\n/b'), { kind: 'count', files: 2 })
  assert.equal(resultPill('Bash', {}, PR_OUT), null)
  assert.equal(resultPill('Bash', undefined, PR_OUT), null)
  assert.equal(resultPill('Read', { file_path: '/a' }, PR_OUT), null)
})
