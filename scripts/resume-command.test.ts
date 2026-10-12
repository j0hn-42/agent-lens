// #240 (PR 1): the "copy resume command" is built in the browser, offered only when it can be proven to work.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isValidSessionId as extIsValidSessionId } from '../extension/src/relay-guards'
import { RELAY_SESSION_PARAM_MAX_LENGTH } from '../extension/src/constants'
import { isValidSessionId, quotePosixShell, resumeCommand, RESUME_SESSION_ID_MAX_LENGTH } from '../web/lib/resume-command'

const ID = '0f6c3a1e-58b2-4c1d-9a0e-2b7d4e5f6a7b'
const claude = (over: Record<string, unknown> = {}) => ({ id: ID, runtime: 'claude' as const, cwd: '/home/me/project', ...over })

test('the web session id check mirrors the relay one', () => {
  assert.equal(RESUME_SESSION_ID_MAX_LENGTH, RELAY_SESSION_PARAM_MAX_LENGTH)
  const samples: unknown[] = [ID, 'a', 'a.b:c-d_e', '', ' ', 'a b', "a'b", 'a;b', 'a$b', 'a\nb', '../x', 'x'.repeat(128), 'x'.repeat(129), 42, null, undefined, 'é']
  for (const s of samples) assert.equal(isValidSessionId(s), extIsValidSessionId(s), `mismatch for ${JSON.stringify(s)}`)
})

test('a Claude session with a valid id and a known cwd gets the command', () => {
  assert.deepEqual(resumeCommand(claude()), { ok: true, command: `cd '/home/me/project' && claude --resume ${ID}` })
})

test('the cwd is single-quoted: apostrophes, spaces and shell characters stay literal', () => {
  assert.equal(quotePosixShell("/home/me/l'app"), `'/home/me/l'\\''app'`)
  assert.equal(quotePosixShell('/a b/c'), `'/a b/c'`)
  assert.equal(quotePosixShell('/x/$(rm -rf ~)/`id`/;|&<>*?!"\\'), `'/x/$(rm -rf ~)/\`id\`/;|&<>*?!"\\'`)
  assert.equal(quotePosixShell("''"), `''\\'''\\'''`)
})

test('a real POSIX shell reads the quoted cwd back unchanged', { skip: process.platform === 'win32' }, () => {
  const tricky = ["/tmp/l'app", '/tmp/a b', '/tmp/$(echo pwned)', '/tmp/`id`', '/tmp/;echo x', '/tmp/"q"', '/tmp/\\n', "/tmp/'", '/tmp/*', '/tmp/~', '/tmp/é ü']
  for (const p of tricky) {
    const out = execFileSync('/bin/sh', ['-c', `printf '%s' ${quotePosixShell(p)}`], { encoding: 'utf8' })
    assert.equal(out, p)
  }
})

test('the command really changes to a directory whose name has an apostrophe and spaces', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resume l'app $x "))
  try {
    const r = resumeCommand(claude({ cwd: dir }))
    assert.ok(r.ok)
    // Replace the claude call by pwd: the part before && is exactly what the user pastes
    const cd = r.command.replace(/ && claude --resume .*$/, ' && pwd -P')
    assert.equal(execFileSync('/bin/sh', ['-c', cd], { encoding: 'utf8' }).trim(), fs.realpathSync(dir))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('no command for an invalid session id', () => {
  for (const id of ['', 'a b', "a'b", 'a;rm', 'x'.repeat(129), '-rf', '--help']) {
    assert.deepEqual(resumeCommand(claude({ id })), { ok: false, reason: 'invalid-id' }, id)
  }
})

test('no command for another runtime or an unknown one', () => {
  assert.deepEqual(resumeCommand(claude({ runtime: 'codex' })), { ok: false, reason: 'runtime' })
  assert.deepEqual(resumeCommand(claude({ runtime: 'copilot' })), { ok: false, reason: 'runtime' })
  assert.deepEqual(resumeCommand(claude({ runtime: undefined })), { ok: false, reason: 'runtime' })
})

test('no command for an imported session (its cwd is on another machine)', () => {
  assert.deepEqual(resumeCommand(claude({ imported: true })), { ok: false, reason: 'imported' })
})

test('no command when the cwd is unknown, relative, multi-line or carries control characters', () => {
  for (const cwd of [undefined, '', 'project', './x', '~/x', 'C:\\Users\\me', '/a\nb', '/a\rb', '/a\u0000b', '/a\u202eb', '/a\tb', '/' + 'x'.repeat(4096)]) {
    assert.deepEqual(resumeCommand(claude({ cwd })), { ok: false, reason: 'cwd' }, JSON.stringify(cwd))
  }
})
