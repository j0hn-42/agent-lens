/**
 * Wiring of the project dir watcher in the relay (#650, #613): writes on a transcript the relay tracks never scan
 * (`isTracked: id => sessions.has(id)`), a .jsonl it does not know scans at once, and the wake-up watcher of a cold
 * transcript (one that exceeds maxSessionFileBytes) goes through the same debounce instead of scanning on every
 * write. Own file: the relay is a per-process singleton.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { WATCH_SCAN_DEBOUNCE_MS } from '../extension/src/constants'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-pw-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

const TRACKED = '55555555-5555-4555-8555-555555555551'
const UNKNOWN = '55555555-5555-4555-8555-555555555552'
const BIG = '55555555-5555-4555-8555-555555555553'
const MAX_BYTES = 20_000
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (cond()) return true; await sleep(10) }
  return cond()
}

type Relay = Awaited<ReturnType<typeof import('./relay').createRelay>>
let relay: Relay
let realWs = ''
let projectDir = ''
const userLine = (text: string) => JSON.stringify({
  type: 'user', cwd: realWs, timestamp: new Date().toISOString(), message: { role: 'user', content: text },
}) + '\n'
const scans = () => relay.debugState().scanRuns

describe('relay: project dir watcher wiring (#650, #613)', () => {
  before(async () => {
    const ws = path.join(fakeHome, 'workspace')
    fs.mkdirSync(ws, { recursive: true })
    realWs = fs.realpathSync(ws)
    projectDir = path.join(fakeHome, '.claude', 'projects', realWs.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, `${TRACKED}.jsonl`), userLine('first'))
    // Over the cap from the start: never tracked, put to sleep ("cold") by the first scan
    fs.writeFileSync(path.join(projectDir, `${BIG}.jsonl`), userLine('x'.repeat(MAX_BYTES * 2)))
    const { createRelay } = await import('./relay')
    relay = await createRelay({ workspace: ws, runtime: 'claude', maxSessionFileBytes: MAX_BYTES })
  })

  after(() => {
    relay.dispose()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('lines written on a tracked transcript do not scan; an unknown .jsonl scans at once', async () => {
    assert.ok(await waitFor(() => relay.debugState().dedupSessions === 1), 'precondition: the transcript is tracked')
    // Past any scan the start left running
    await sleep(WATCH_SCAN_DEBOUNCE_MS * 2)
    const before = scans()
    for (let i = 0; i < 30; i++) { fs.appendFileSync(path.join(projectDir, `${TRACKED}.jsonl`), userLine(`m${i}`)); await sleep(5) }
    await sleep(WATCH_SCAN_DEBOUNCE_MS * 3)
    assert.equal(scans(), before, 'N lines on a tracked transcript: scanRuns does not move')
    fs.writeFileSync(path.join(projectDir, `${UNKNOWN}.jsonl`), userLine('hello'))
    assert.ok(await waitFor(() => scans() > before, 2000), 'an unknown .jsonl is scanned at once')
  })

  it('the wake-up watcher of a cold oversize transcript is debounced, not a scan per write', async () => {
    await sleep(WATCH_SCAN_DEBOUNCE_MS * 3)
    const before = scans()
    const WRITES = 20
    const t0 = Date.now()
    for (let i = 0; i < WRITES; i++) { fs.appendFileSync(path.join(projectDir, `${BIG}.jsonl`), userLine(`b${i}`)); await sleep(15) }
    // The bound follows the measured duration of the writes, not an assumed ~300 ms: under load they take longer and
    // the debounce legitimately lets more scans through (one leading, one per window, one trailing)
    const duration = Date.now() - t0
    await sleep(WATCH_SCAN_DEBOUNCE_MS * 3)
    const made = scans() - before
    assert.ok(made >= 1, 'the file is looked at again')
    const bound = 1 + Math.ceil(duration / WATCH_SCAN_DEBOUNCE_MS) + 1
    // A scan per write would be WRITES (20): the bound stays under it while the writes last less than ~4 s
    assert.ok(made <= bound, `${WRITES} writes over ${duration} ms cost ${made} scans (bound ${bound})`)
  })
})
