import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { readSessionHeader } from '../src/team-watcher'
import { branchTag } from '../src/project-identity'

// The branch of a session is read from what the transcript recorded (gitBranch), never guessed (#125)

function withTranscript(lines: string[], check: (file: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdr-branch-'))
  try {
    const file = path.join(dir, 's.jsonl')
    fs.writeFileSync(file, lines.join('\n'))
    check(file)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

describe('readSessionHeader: recorded branch', () => {
  it('takes the branch of the first entry that carries one', () => {
    withTranscript(['{"type":"summary"}', '{"type":"user","cwd":"/w/x","gitBranch":"feat/a"}', '{"type":"user","gitBranch":"other"}'],
      f => assert.equal(readSessionHeader(f).branch, 'feat/a'))
  })

  it('a detached HEAD, an empty or odd value is no branch, and a later entry does not fill it in', () => {
    for (const bad of ['HEAD', '', 'a\u0001b', 'x'.repeat(300)]) {
      withTranscript([JSON.stringify({ type: 'user', cwd: '/w/x', gitBranch: bad }), '{"type":"user","gitBranch":"later"}'],
        f => assert.equal(readSessionHeader(f).branch, undefined, JSON.stringify(bad)))
    }
  })

  it('no gitBranch in the transcript: no branch', () => {
    withTranscript(['{"type":"user","cwd":"/w/x"}'], f => assert.equal(readSessionHeader(f).branch, undefined))
  })
})

describe('branchTag', () => {
  it('adds the field only for a known branch', () => {
    assert.deepEqual(branchTag('main'), { branch: 'main' })
    assert.deepEqual(branchTag(undefined), {})
    assert.deepEqual(branchTag(''), {})
  })
})
