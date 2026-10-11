// One shared definition of the characters stripped from untrusted text (#220).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as ext from '../extension/src/control-chars'
import * as web from '../web/lib/control-chars'

const HAZARDS = ['\u0000', '\u0007', '\u000B', '\u001F', '\u007F', '\u0085', '\u009B', '\u009F', '​', '‏', ' ', ' ', '‪', '‮', '⁦', '⁩', '﻿']

for (const [label, m] of [['extension', ext], ['web', web]] as const) {
  test(`${label}: every hazard is removed from identifiers and from free text`, () => {
    for (const ch of HAZARDS) {
      const code = `U+${ch.charCodeAt(0).toString(16)}`
      assert.equal(`a${ch}b`.replace(m.CONTROL_ALL, ''), 'ab', `ALL ${code}`)
      assert.equal(`a${ch}b`.replace(m.CONTROL_TEXT, ''), 'ab', `TEXT ${code}`)
      assert.equal(m.hasControlChars(`a${ch}b`), true, code)
    }
  })
  test(`${label}: TAB, LF and CR survive in free text only; ordinary text is untouched`, () => {
    assert.equal('a\tb\nc\rd'.replace(m.CONTROL_TEXT, ''), 'a\tb\nc\rd')
    assert.equal('a\tb\nc\rd'.replace(m.CONTROL_ALL, ''), 'abcd')
    assert.equal(m.hasControlChars('plain é 日本 text'), false)
    assert.equal(m.hasControlChars('a\tb'), true)
  })
  test(`${label}: hasControlChars is stateless across calls`, () => {
    assert.equal(m.hasControlChars('‮'), true)
    assert.equal(m.hasControlChars('‮'), true)
  })
}

test('the web copy is a verbatim mirror of the extension copy', () => {
  const read = (f: string) => fs.readFileSync(path.join(__dirname, f), 'utf8')
  assert.equal(read('../web/lib/control-chars.ts'), read('../extension/src/control-chars.ts'))
})

test('no other source file defines its own control-character regex', () => {
  const files = [
    '../extension/src/event-normalize.ts', '../web/lib/event-normalize.ts', '../extension/src/team-links.ts',
    '../extension/src/observations.ts', '../extension/src/project-identity.ts', '../extension/src/session-index.ts',
    '../extension/src/team-watcher.ts', 'relay.ts', '../web/lib/bridge-types.ts',
  ]
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8')
    assert.ok(!/\\u0000|\\x00|\\u007f|\\x7f|\\u2028|\\u202e/i.test(src), `${f} still has its own control-character regex`)
  }
})
