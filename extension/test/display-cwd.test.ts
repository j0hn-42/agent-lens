/**
 * displayCwd (#420): the one rule for a working directory read from an agent's own files (Codex, Pi,
 * OpenCode) before it is shown. Only an absolute, single-line path without control, invisible or bidi
 * characters, at most CWD_MAX long; anything else is left out.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { displayCwd, CWD_MAX } from '../src/display-cwd'

describe('displayCwd', () => {
  it('keeps a clean absolute path', () => {
    assert.equal(displayCwd('/home/me/code/alpha'), '/home/me/code/alpha')
  })

  it('leaves out control, bidi and invisible characters', () => {
    for (const bad of ['/w/\u0000x', '/w/\u001b[2J', '/w/\n', '/w/\u007f', '/w/\u009b31m', '/w/‮evil', '/w/⁦x', '/w/​x', '/w/﻿x']) {
      assert.equal(displayCwd(bad), undefined, JSON.stringify(bad))
    }
  })

  it('leaves out a relative, empty, too long or non-string value', () => {
    assert.equal(displayCwd('../etc'), undefined)
    assert.equal(displayCwd(''), undefined)
    assert.equal(displayCwd(null), undefined)
    assert.equal(displayCwd(42), undefined)
    assert.equal(displayCwd('/' + 'a'.repeat(CWD_MAX)), undefined)
    assert.equal(displayCwd('/' + 'a'.repeat(CWD_MAX - 1)), '/' + 'a'.repeat(CWD_MAX - 1))
  })

  it('is the only copy of the rule in the watchers', () => {
    for (const f of ['codex-session-watcher.ts', 'pi-session-watcher.ts', 'opencode-session-watcher.ts']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')
      assert.equal(/UNSAFE_PATH_CHARS|const CWD_MAX/.test(src), false, `${f} keeps its own copy`)
      assert.match(src, /from '\.\/display-cwd'/, `${f} uses displayCwd`)
    }
  })
})
