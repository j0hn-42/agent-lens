import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { encodeProjectDirName, projectDirMatcher, PROJECT_DIR_NAME_MAX } from '../extension/src/project-dir'

describe('encodeProjectDirName (#249)', () => {
  it('turns every non-alphanumeric character into a dash, underscores and dots included', () => {
    assert.equal(encodeProjectDirName('/Users/simon/my_project'), '-Users-simon-my-project')
    assert.equal(encodeProjectDirName('/home/a/.config/app.v2'), '-home-a--config-app-v2')
  })
  it('handles Windows drive letters, backslashes and UNC paths', () => {
    assert.equal(encodeProjectDirName('C:\\Users\\me\\my_proj'), 'C--Users-me-my-proj')
    assert.equal(encodeProjectDirName('\\\\server\\share\\p'), '--server-share-p')
  })
  it('turns each non-ASCII character into one dash', () => {
    assert.equal(encodeProjectDirName('/home/zoé/projet'), '-home-zo--projet')
  })
})

describe('projectDirMatcher (#249)', () => {
  const posix = { caseInsensitive: false }
  it('matches the project dir and its sub-projects, not a sibling sharing the prefix', () => {
    const m = projectDirMatcher('/Users/simon/my_project', posix)
    assert.equal(m('-Users-simon-my-project'), true)
    assert.equal(m('-Users-simon-my-project-sub'), true)
    assert.equal(m('-Users-simon-my-projects'), false)
    assert.equal(m('-Users-simon-other'), false)
  })
  it('is case-insensitive only when asked (Windows drive letters differ in case)', () => {
    assert.equal(projectDirMatcher('c:\\Users\\me\\p', { caseInsensitive: true })('C--Users-me-p'), true)
    assert.equal(projectDirMatcher('c:\\Users\\me\\p', posix)('C--Users-me-p'), false)
  })
  it('a long path is stored cut at the limit and followed by a hash: match on that prefix', () => {
    const ws = '/' + 'a_long_segment/'.repeat(20) + 'proj'
    const enc = encodeProjectDirName(ws)
    assert.ok(enc.length > PROJECT_DIR_NAME_MAX)
    const stored = enc.slice(0, PROJECT_DIR_NAME_MAX) + '-1k2j3h'
    const m = projectDirMatcher(ws, posix)
    assert.equal(m(stored), true)
    assert.equal(m('-' + 'b'.repeat(PROJECT_DIR_NAME_MAX) + '-1k2j3h'), false)
  })
})
