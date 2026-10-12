import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseOpenTerminalMessage, openSessionTerminal, type TerminalWindow } from '../src/open-terminal'

const ID = '0b9f1c52-aaaa-4bbb-8ccc-1234567890ab'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-term-'))

function fakeWindow() {
  const created: Array<{ name: string; cwd: string; shown: boolean; sent: string[] }> = []
  const window: TerminalWindow = {
    createTerminal(opts) {
      const t = { name: opts.name, cwd: opts.cwd, shown: false, sent: [] as string[] }
      created.push(t)
      return { show() { t.shown = true }, sendText(text: string) { t.sent.push(text) } }
    },
  }
  return { window, created }
}

describe('parseOpenTerminalMessage (webview input is untrusted)', () => {
  it('keeps only a valid session id and never a cwd sent by the webview', () => {
    assert.deepEqual(parseOpenTerminalMessage({ type: 'open-terminal', sessionId: ID, cwd: '/etc' }), { sessionId: ID })
  })
  it('refuses a missing, non-string, empty, oversized or odd session id', () => {
    for (const bad of [null, 3, 'x', {}, { sessionId: 4 }, { sessionId: '' }, { sessionId: 'a b' }, { sessionId: 'a'.repeat(200) }, { sessionId: '../x' }]) {
      assert.equal(parseOpenTerminalMessage(bad), null, JSON.stringify(bad))
    }
  })
})

describe('openSessionTerminal', () => {
  it('opens a terminal in the cwd of a session the extension knows, with no command', () => {
    const { window, created } = fakeWindow()
    const r = openSessionTerminal(ID, [{ id: ID, cwd: dir }], { window })
    assert.deepEqual(r, { ok: true, cwd: dir })
    assert.equal(created.length, 1)
    assert.equal(created[0].cwd, dir)
    assert.equal(created[0].shown, true)
    assert.deepEqual(created[0].sent, [], 'nothing is typed or run in the terminal')
  })
  it('refuses a session the extension does not know', () => {
    const { window, created } = fakeWindow()
    assert.deepEqual(openSessionTerminal(ID, [{ id: 'other', cwd: dir }], { window }), { ok: false, reason: 'unknown-session' })
    assert.equal(created.length, 0)
  })
  it('refuses an unknown, relative, multi-line or non-directory cwd', () => {
    const file = path.join(dir, 'f.txt')
    fs.writeFileSync(file, 'x')
    const cases: Array<[string | undefined, string]> = [
      [undefined, 'cwd'], ['relative/dir', 'cwd'], [`${dir}\nrm -rf /`, 'cwd'],
      [path.join(dir, 'missing'), 'not-a-directory'], [file, 'not-a-directory'],
    ]
    for (const [cwd, reason] of cases) {
      const { window, created } = fakeWindow()
      assert.deepEqual(openSessionTerminal(ID, [{ id: ID, cwd }], { window }), { ok: false, reason }, String(cwd))
      assert.equal(created.length, 0)
    }
  })
  it('names the terminal after the directory, without control characters, capped', () => {
    const { window, created } = fakeWindow()
    const odd = fs.mkdtempSync(path.join(dir, 'x'.repeat(80)))
    openSessionTerminal(ID, [{ id: ID, cwd: odd }], { window })
    assert.match(created[0].name, /^Agent Lens: x+/)
    assert.ok(created[0].name.length <= 60)
    assert.doesNotMatch(created[0].name, /[\u0000-\u001F]/)
  })
})
