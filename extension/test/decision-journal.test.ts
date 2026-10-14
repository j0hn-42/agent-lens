import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { DecisionJournal, type DecisionRecord } from '../src/decision-journal'
import { PermissionGate, sha256Json, type PermissionRequestView } from '../src/permission-gate'

const posix = process.platform !== 'win32'
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'al-journal-'))
const rec = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  ts: '2026-10-12T10:00:00.000Z', sessionId: 's1', toolUseId: 'toolu_1', tool: 'Bash', decision: 'approve',
  channel: 'vscode', inputSha256: 'a'.repeat(64), outcome: 'sent', ...over,
})
const lines = (file: string) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)

describe('DecisionJournal', () => {
  it('appends one JSON line per decision and never rewrites earlier lines', () => {
    const file = path.join(tmp(), 'decisions.jsonl')
    const j = new DecisionJournal(file, 1 << 20)
    assert.equal(j.append(rec()), true)
    const first = fs.readFileSync(file, 'utf8')
    assert.equal(j.append(rec({ decision: 'deny', outcome: 'expired' })), true)
    const all = fs.readFileSync(file, 'utf8')
    assert.ok(all.startsWith(first), 'append only')
    const got = lines(file)
    assert.equal(got.length, 2)
    assert.equal(got[0].tool, 'Bash')
    assert.equal(got[1].outcome, 'expired')
  })

  it('writes a SHA-256 of each line so a later edit of the file can be noticed', () => {
    const file = path.join(tmp(), 'decisions.jsonl')
    new DecisionJournal(file, 1 << 20).append(rec())
    const got = lines(file)[0]
    assert.match(String(got.inputSha256), /^[0-9a-f]{64}$/)
    assert.match(String(got.entrySha256), /^[0-9a-f]{64}$/)
    const { entrySha256, ...rest } = got
    assert.equal(entrySha256, createHash('sha256').update(JSON.stringify(rest)).digest('hex'))
  })

  it('creates the file readable by its owner only, and tightens a looser mode', { skip: !posix }, () => {
    const dir = tmp()
    const file = path.join(dir, 'decisions.jsonl')
    new DecisionJournal(file, 1 << 20).append(rec())
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    fs.chmodSync(file, 0o644)
    new DecisionJournal(file, 1 << 20).append(rec())
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  })

  it('is capped: past the size it moves the file to .1 (replacing the older one) and starts again', () => {
    const file = path.join(tmp(), 'decisions.jsonl')
    const j = new DecisionJournal(file, 600)
    for (let i = 0; i < 12; i++) assert.equal(j.append(rec({ sessionId: `s${i}` })), true)
    assert.ok(fs.existsSync(`${file}.1`))
    assert.ok(fs.statSync(file).size <= 600 + 400, 'the live file stays near the cap')
    assert.ok(!fs.existsSync(`${file}.2`), 'one older generation only')
    const total = lines(file).length + lines(`${file}.1`).length
    assert.ok(total >= 4 && total <= 12)
    assert.equal(lines(file).at(-1)?.sessionId, 's11', 'the newest decision is in the live file')
  })

  it('refuses a symbolic link and leaves its target alone', { skip: !posix }, () => {
    const dir = tmp()
    const target = path.join(dir, 'victim.txt')
    fs.writeFileSync(target, 'precious\n')
    const file = path.join(dir, 'decisions.jsonl')
    fs.symlinkSync(target, file)
    assert.equal(new DecisionJournal(file, 1 << 20).append(rec()), false)
    assert.equal(fs.readFileSync(target, 'utf8'), 'precious\n')
  })

  it('reports a failure instead of throwing when the folder cannot be created', () => {
    const dir = tmp()
    const blocker = path.join(dir, 'file')
    fs.writeFileSync(blocker, 'x')
    assert.equal(new DecisionJournal(path.join(blocker, 'sub', 'decisions.jsonl'), 1 << 20).append(rec()), false)
  })
})

describe('a redirect in the journal (#387)', () => {
  it('records the SHA-256 of the input and the length of the text, never the text nor the input', async () => {
    const file = path.join(tmp(), 'decisions.jsonl')
    const journal = new DecisionJournal(file, 1 << 20)
    const gate = new PermissionGate({ enabled: () => true, canDecide: () => true, journal, ttlMs: 5000 })
    const shown: PermissionRequestView[] = []
    gate.onRequest(v => shown.push(v))
    const input = { command: 'deploy --token sk-live-input-secret' }
    const r = gate.request({ sessionId: 's1', toolName: 'Bash', toolInput: input, toolUseId: 'toolu_1' })
    const text = 'do not deploy; ask me first (secret-redirect-text)'
    assert.deepEqual(gate.decide({ sessionId: 's1', toolUseId: 'toolu_1', nonce: shown[0].nonce, action: 'redirect', message: text }), { ok: true })
    assert.deepEqual(await r.decision, { behavior: 'deny', message: text })
    const raw = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(raw, /secret-redirect-text|ask me first|sk-live-input-secret|deploy/)
    const [line] = lines(file)
    assert.equal(line.decision, 'redirect')
    assert.equal(line.outcome, 'sent')
    assert.equal(line.inputSha256, sha256Json(input))
    assert.equal(line.messageChars, text.length)
    assert.equal(line.message, undefined)
  })
})
