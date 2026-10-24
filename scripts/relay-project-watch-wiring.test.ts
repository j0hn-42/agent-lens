/**
 * Wiring of the project folder watcher in the relay (#650, #613): what fs.watch reports on a `.jsonl` of the project
 * dir triggers a discovery scan only for a transcript the relay knows nothing about. Lines written to a transcript it
 * follows, or to one it left out for its size, never scan; a new `.jsonl` scans at once. Counted through
 * `debugState().scanRuns`. Own file: the relay is a per-process singleton.
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

const TRACKED = '11111111-1111-4111-8111-111111111111'
const BIG = '22222222-2222-4222-8222-222222222222'
const NEWCOMER = '33333333-3333-4333-8333-333333333333'
const CAP = 100_000
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type Relay = Awaited<ReturnType<typeof import('./relay').createRelay>>
let relay: Relay
let projectDir = ''
let cwd = ''
const line = (text: string) => JSON.stringify({ type: 'user', cwd, timestamp: new Date().toISOString(), message: { role: 'user', content: text } }) + '\n'

async function waitFor(pred: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (pred()) return true; await sleep(20) }
  return pred()
}

/** N lines, spread over several debounce windows so that a scan per window would show */
async function writeLines(file: string, n: number) {
  for (let i = 0; i < n; i++) {
    fs.appendFileSync(file, line(`l${i}`))
    if (i % 5 === 4) await sleep(WATCH_SCAN_DEBOUNCE_MS / 2)
  }
  await sleep(WATCH_SCAN_DEBOUNCE_MS * 3)
}

describe('project folder watcher wiring (#650, #613)', () => {
  before(async () => {
    const ws = path.join(fakeHome, 'workspace')
    fs.mkdirSync(ws, { recursive: true })
    cwd = fs.realpathSync(ws)
    projectDir = path.join(fakeHome, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, `${TRACKED}.jsonl`), line('first'))
    // Over the size cap from the start: the scan leaves it out (skippedSessions.sizeLimit)
    fs.writeFileSync(path.join(projectDir, `${BIG}.jsonl`), line('x'.repeat(CAP + 1000)))
    const { createRelay } = await import('./relay')
    relay = await createRelay({ workspace: ws, runtime: 'claude', maxSessionFileBytes: CAP })
    assert.ok(await waitFor(() => relay.debugState().watchedSessions === 1), 'precondition: the small transcript is followed')
    await sleep(WATCH_SCAN_DEBOUNCE_MS * 2)
  })

  after(() => {
    relay.dispose()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('lines written to a followed transcript do not scan', async () => {
    const runs = relay.debugState().scanRuns
    await writeLines(path.join(projectDir, `${TRACKED}.jsonl`), 30)
    assert.equal(relay.debugState().scanRuns, runs, 'no scan for 30 lines of a transcript the relay follows')
  })

  it('lines written to a transcript left out for its size do not scan either', async () => {
    const runs = relay.debugState().scanRuns
    await writeLines(path.join(projectDir, `${BIG}.jsonl`), 30)
    assert.equal(relay.debugState().scanRuns, runs, 'no scan for a long session over maxSessionFileBytes')
  })

  it('an unknown .jsonl scans at once', async () => {
    const runs = relay.debugState().scanRuns
    fs.writeFileSync(path.join(projectDir, `${NEWCOMER}.jsonl`), line('hello'))
    assert.ok(await waitFor(() => relay.debugState().scanRuns === runs + 1, WATCH_SCAN_DEBOUNCE_MS), 'one scan, before the debounce window ends')
  })
})
