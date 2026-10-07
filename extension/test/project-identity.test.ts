import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveProjectIdentity, clearProjectIdentityCache, PROJECT_ID_LENGTH } from '../src/project-identity'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' })

describe('project identity (git-common-dir)', () => {
  let tmp: string
  let main: string
  let worktree: string
  let other: string
  let plain: string

  before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lens-ident-')))
    main = path.join(tmp, 'my-repo')
    worktree = path.join(tmp, 'my-repo-wt')
    other = path.join(tmp, 'other-repo')
    plain = path.join(tmp, 'plain')
    for (const d of [main, other, plain]) fs.mkdirSync(d)
    for (const d of [main, other]) {
      git(d, 'init', '-q')
      git(d, 'commit', '-q', '--allow-empty', '-m', 'init')
    }
    git(main, 'worktree', 'add', '-q', worktree, '-b', 'wt')
    fs.mkdirSync(path.join(main, 'sub'))
  })
  after(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('gives the same identity to a repo, its subdirectory and its worktrees', () => {
    clearProjectIdentityCache()
    const a = resolveProjectIdentity(main)
    assert.ok(a)
    assert.equal(a.projectId.length, PROJECT_ID_LENGTH)
    assert.match(a.projectId, /^[0-9a-f]+$/)
    assert.deepEqual(resolveProjectIdentity(path.join(main, 'sub')), a)
    assert.deepEqual(resolveProjectIdentity(worktree), a)
  })

  it('names the project after the main checkout, not the worktree folder', () => {
    assert.equal(resolveProjectIdentity(worktree)?.projectName, 'my-repo')
  })

  it('tells two repositories apart', () => {
    assert.notEqual(resolveProjectIdentity(main)?.projectId, resolveProjectIdentity(other)?.projectId)
  })

  it('falls back to null outside a git repository, for a missing or empty cwd', () => {
    clearProjectIdentityCache()
    assert.equal(resolveProjectIdentity(plain), null)
    assert.equal(resolveProjectIdentity(path.join(tmp, 'gone')), null)
    assert.equal(resolveProjectIdentity(undefined), null)
    assert.equal(resolveProjectIdentity(''), null)
  })

  it('does not run git twice for the same cwd', () => {
    clearProjectIdentityCache()
    let calls = 0
    const run = () => { calls++; return `${main}/.git\n` }
    const a = resolveProjectIdentity(main, run)
    const b = resolveProjectIdentity(main, run)
    assert.deepEqual(a, b)
    assert.equal(calls, 1)
  })

  it('treats a git failure as "not in a repository" and does not throw', () => {
    clearProjectIdentityCache()
    assert.equal(resolveProjectIdentity(main, () => { throw new Error('boom') }), null)
    assert.equal(resolveProjectIdentity(main, () => '   \n'), null)
  })

  it('bounds its cache', () => {
    clearProjectIdentityCache()
    for (let i = 0; i < 1500; i++) resolveProjectIdentity(`/x/${i}`, () => `/x/${i}/.git\n`)
    let calls = 0
    resolveProjectIdentity('/x/1499', () => { calls++; return '/x/1499/.git\n' })
    assert.equal(calls, 0, 'recent entries survive')
    resolveProjectIdentity('/x/0', () => { calls++; return '/x/0/.git\n' })
    assert.equal(calls, 1, 'oldest entry was evicted')
  })
})
