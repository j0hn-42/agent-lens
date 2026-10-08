/**
 * defaultExec (#63) really runs a program: no shell, a timeout, a bounded output, no interactive prompt.
 * Every other issue-links test injects `exec`; these run a fake binary so the guarantees stated in the
 * module header are actually exercised.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { defaultExec, fetchIssueLinks } from '../src/issue-links'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-gh-exec-'))
const bin = (name: string, body: string): string => {
  const file = path.join(dir, name)
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}

before(() => { fs.mkdirSync(dir, { recursive: true }) })
after(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('defaultExec', () => {
  it('passes arguments verbatim: a ; or $( ) is never interpreted by a shell', async () => {
    const marker = path.join(dir, 'pwned')
    const echo = bin('echo-args', 'for a in "$@"; do echo "[$a]"; done')
    const out = await defaultExec(echo, ['a;touch ' + marker, '$(touch ' + marker + ')', '`id`', '&& id'])
    assert.equal(out, `[a;touch ${marker}]\n[$(touch ${marker})]\n[\`id\`]\n[&& id]\n`)
    assert.ok(!fs.existsSync(marker), 'nothing was executed')
  })

  it('disables the interactive prompts of gh and git', async () => {
    const env = bin('print-env', 'echo "$GH_PROMPT_DISABLED $GIT_TERMINAL_PROMPT"')
    assert.equal((await defaultExec(env, [])).trim(), '1 0')
  })

  it('runs in the given cwd', async () => {
    const pwd = bin('print-pwd', 'pwd -P')
    assert.equal((await defaultExec(pwd, [], { cwd: fs.realpathSync(dir) })).trim(), fs.realpathSync(dir))
  })

  it('rejects an output larger than the 1 MiB buffer', async () => {
    const big = bin('big-output', 'head -c 2097152 /dev/zero | tr "\\0" x')
    await assert.rejects(defaultExec(big, []), /maxBuffer/i)
  })

  it('rejects a non-zero exit and a missing binary', async () => {
    await assert.rejects(defaultExec(bin('fail', 'exit 3'), []))
    await assert.rejects(defaultExec(path.join(dir, 'no-such-gh'), []), /ENOENT/)
  })

  it('a gh that never answers is killed after the 8 s timeout, and no link is shown', async () => {
    const slow = bin('slow', 'exec sleep 30')
    const started = Date.now()
    const [direct, links] = await Promise.all([
      defaultExec(slow, []).then(() => 'resolved', (e: Error & { killed?: boolean }) => (e.killed ? 'killed' : `rejected: ${e.message}`)),
      fetchIssueLinks('qa', { repoUrl: 'https://github.com/o/r', exec: (_f, a, o) => defaultExec(slow, a, o) }),
    ])
    const elapsed = Date.now() - started
    assert.equal(direct, 'killed')
    assert.deepEqual(links, [], 'silent degradation: no link, no throw')
    assert.ok(elapsed >= 7_500 && elapsed < 15_000, `timeout around 8 s, got ${elapsed} ms`)
  })
})
