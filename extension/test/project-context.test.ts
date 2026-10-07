/**
 * Project context (#64): CLAUDE.md + auto-memory of a session's cwd, read on demand.
 * Invariants: reads are bounded (64 KB per file, head kept, truncation reported), symlinks are
 * refused, a missing file is reported as absent (never as empty), issue refs come only from text read.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readProjectContext, extractIssueRefs, encodeProjectDir } from '../src/project-context'
import { PROJECT_CONTEXT_MAX_FILE_BYTES } from '../src/constants'

describe('project context', () => {
  let home: string
  let cwd: string
  let memoryDir: string

  before(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-ctx-')))
    cwd = path.join(home, 'work', 'my_proj')
    fs.mkdirSync(cwd, { recursive: true })
    memoryDir = path.join(home, '.claude', 'projects', encodeProjectDir(cwd), 'memory')
  })
  after(() => fs.rmSync(home, { recursive: true, force: true }))

  it('encodes the project dir like Claude Code does', () => {
    assert.equal(encodeProjectDir('/Users/simon/my_project'), '-Users-simon-my-project')
  })

  it('reports absent files as absent, not as empty', () => {
    const r = readProjectContext(cwd, home)
    assert.deepEqual(r.files.map(f => [f.kind, f.found]), [['claude-md', false], ['memory', false]])
    assert.deepEqual(r.issues, [])
  })

  it('reports a symlinked CLAUDE.md as present but unreadable, not as absent', () => {
    const dir = fs.mkdtempSync(path.join(home, 'link-'))
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'rules')
    fs.symlinkSync('AGENTS.md', path.join(dir, 'CLAUDE.md'))
    const [claude] = readProjectContext(dir, home).files
    assert.equal(claude.found, false)
    assert.equal(claude.unreadable, 'symlink')
  })

  it('reports a directory named CLAUDE.md as unreadable (not-a-file), a truly missing one without reason', () => {
    const dir = fs.mkdtempSync(path.join(home, 'dir-'))
    fs.mkdirSync(path.join(dir, 'CLAUDE.md'))
    assert.equal(readProjectContext(dir, home).files[0].unreadable, 'not-a-file')
    const empty = fs.mkdtempSync(path.join(home, 'none-'))
    assert.equal(readProjectContext(empty, home).files[0].unreadable, undefined)
  })

  it('reads CLAUDE.md and the memory index and extracts issue refs', () => {
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'Voir #64 et #12.\nEncore #64')
    fs.mkdirSync(memoryDir, { recursive: true })
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '- note PR #45')
    const r = readProjectContext(cwd, home)
    const [claude, memory] = r.files
    assert.equal(claude.found, true)
    assert.equal(claude.text, 'Voir #64 et #12.\nEncore #64')
    assert.equal(claude.truncated, false)
    assert.equal(memory.text, '- note PR #45')
    assert.deepEqual(r.issues, [12, 45, 64])
  })

  it('keeps the first 64 KB of a larger file and says it was truncated', () => {
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'a'.repeat(PROJECT_CONTEXT_MAX_FILE_BYTES + 5000))
    const claude = readProjectContext(cwd, home).files[0]
    assert.equal(claude.truncated, true)
    assert.equal(claude.text.length, PROJECT_CONTEXT_MAX_FILE_BYTES)
    assert.equal(claude.bytes, PROJECT_CONTEXT_MAX_FILE_BYTES + 5000)
  })

  it('does not leave a broken multibyte char at the cut', () => {
    // 3-byte chars: 65536 is not a multiple of 3, so the cut splits one
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '€'.repeat(PROJECT_CONTEXT_MAX_FILE_BYTES))
    const claude = readProjectContext(cwd, home).files[0]
    assert.equal(claude.truncated, true)
    assert.ok(!claude.text.includes('�'))
  })

  it('refuses a symlinked CLAUDE.md', () => {
    const secret = path.join(home, 'secret.txt')
    fs.writeFileSync(secret, 'TOP SECRET')
    fs.rmSync(path.join(cwd, 'CLAUDE.md'))
    fs.symlinkSync(secret, path.join(cwd, 'CLAUDE.md'))
    const claude = readProjectContext(cwd, home).files[0]
    assert.equal(claude.found, false)
    assert.equal(claude.text, '')
  })

  it('returns no file for a relative or empty cwd', () => {
    for (const bad of ['', 'relative/dir']) {
      assert.deepEqual(readProjectContext(bad, home).files.filter(f => f.found), [])
    }
  })
})

describe('extractIssueRefs', () => {
  it('dedupes, sorts, ignores hex colors and words glued to #', () => {
    assert.deepEqual(extractIssueRefs('#9 #10 #9 color #fff, a#5, (#7)'), [7, 9, 10])
  })
  it('caps the number of refs', () => {
    const text = Array.from({ length: 500 }, (_, i) => `#${i + 1}`).join(' ')
    assert.ok(extractIssueRefs(text).length <= 50)
  })
})
