/**
 * boundedTags (#420): the runtime and cwd a watcher puts on its 'started' lifecycle are untrusted text.
 * Each runtime's tags reach session-started single-line, without control or bidi characters, capped at
 * SESSION_TAG_MAX, and a value that is not a string is dropped.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SESSION_TAG_MAX } from '../extension/src/constants'
import { hasControlChars } from '../extension/src/control-chars'
import { boundedTags } from './relay'

const RUNTIMES = ['claude', 'codex', 'copilot', 'pi', 'gemini', 'opencode']
const HOSTILE = '/w/\u001b[2J\u0007\u009b31m‮evil⁦\r\nnext\u0000' + 'a'.repeat(5000)

describe('boundedTags', () => {
  for (const runtime of RUNTIMES) {
    it(`${runtime}: a hostile cwd is cleaned and capped, a non-string is dropped`, () => {
      const out = boundedTags({
        runtime, cwd: HOSTILE,
        workspace: 42 as unknown as string, teamName: { x: 1 } as unknown as string, memberName: null as unknown as string,
        branch: ['main'] as unknown as string, projectName: '\u0000\u0007 ',
      })
      assert.equal(out.runtime, runtime)
      assert.ok(typeof out.cwd === 'string' && out.cwd.length > 0)
      assert.ok(out.cwd!.length <= SESSION_TAG_MAX, `cwd capped: ${out.cwd!.length}`)
      assert.equal(hasControlChars(out.cwd!), false, JSON.stringify(out.cwd))
      assert.ok(out.cwd!.startsWith('/w/'))
      for (const key of ['workspace', 'teamName', 'memberName', 'branch', 'projectName']) {
        assert.equal(key in out, false, `${key} dropped`)
      }
    })

    it(`${runtime}: a hostile runtime value is cleaned and capped too`, () => {
      const out = boundedTags({ runtime: `${runtime}\n\u001b]0;x\u0007`.repeat(100) })
      assert.ok(typeof out.runtime === 'string')
      assert.ok(out.runtime!.length <= SESSION_TAG_MAX)
      assert.equal(hasControlChars(out.runtime!), false)
    })
  }
})
