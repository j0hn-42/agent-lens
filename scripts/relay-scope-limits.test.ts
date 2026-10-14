/**
 * Discovery ceilings stay in force in every scope and are REPORTED, not silently applied (#291):
 * project folders (RELAY_MAX_PROJECT_DIRS), transcripts per folder (RELAY_MAX_FILES_PER_DIR) and transcript size.
 * GET /status carries them; leaving the scope that hit them clears them (the state is the scanned state).
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { encodeProjectDirName } from '../extension/src/project-dir'
import { ACTIVE_SESSION_AGE_S, RELAY_MAX_PROJECT_DIRS, RELAY_MAX_FILES_PER_DIR } from '../extension/src/constants'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-scope-limits-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n'
const SIZE_CAP = 1000

let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
let server: http.Server
let port = 0
let ua = 0

function getStatus(): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/status', agent: false, headers: { 'User-Agent': `limits-${++ua}` } }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve(JSON.parse(body)))
    }).on('error', reject)
  })
}

function postScope(scope: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/scope', method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'User-Agent': `limits-${++ua}` },
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
    req.on('error', reject)
    req.end(JSON.stringify({ scope }))
  })
}

describe('discovery ceilings are reported (#291)', () => {
  before(async () => {
    const projects = path.join(fakeHome, '.claude', 'projects')
    const ws = path.join(fakeHome, 'my-workspace')
    fs.mkdirSync(ws, { recursive: true })
    fs.mkdirSync(path.join(projects, encodeProjectDirName(fs.realpathSync(ws))), { recursive: true })
    const old = new Date(Date.now() - (ACTIVE_SESSION_AGE_S + 600) * 1000)

    // Too many project folders: RELAY_MAX_PROJECT_DIRS + 1 others (the workspace folder makes it more still)
    for (let i = 0; i <= RELAY_MAX_PROJECT_DIRS; i++) fs.mkdirSync(path.join(projects, `-other-${String(i).padStart(4, '0')}`), { recursive: true })

    // Too many transcripts in one folder: one more than the cap
    const crowded = path.join(projects, '-other-0000')
    for (let i = 0; i <= RELAY_MAX_FILES_PER_DIR; i++) {
      const f = path.join(crowded, `s-${String(i).padStart(4, '0')}.jsonl`)
      fs.writeFileSync(f, line)
      fs.utimesSync(f, old, old)
    }

    // A transcript past the size cap
    fs.writeFileSync(path.join(projects, '-other-0001', 'huge.jsonl'), line.repeat(Math.ceil(SIZE_CAP / line.length) + 1))

    const { createRelay } = await import('./relay')
    relay = await createRelay({ workspace: ws, runtime: 'claude', maxSessionFileBytes: SIZE_CAP })
    server = http.createServer((req, res) => {
      if (req.url?.startsWith('/status')) return relay.handleStatus(req, res)
      if (req.url?.startsWith('/scope')) return relay.handleScope(req, res)
      res.writeHead(404); res.end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
  })

  after(() => {
    relay.dispose()
    server.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('on this workspace nothing is capped: the other folders are not scanned, so none is reported', async () => {
    const s = await getStatus()
    assert.equal(s.allWorkspaces, false)
    assert.equal(s.discovery.projectDirsCapped, false)
    assert.deepEqual(s.skippedSessions, { watchLimit: 0, sizeLimit: 0, fileLimit: 0 })
  })

  it('on every workspace the three ceilings still apply and each overflow is shown', async () => {
    assert.equal(await postScope('all'), 200)
    const s = await getStatus()
    assert.equal(s.allWorkspaces, true)
    assert.equal(s.discovery.projectDirsCapped, true, 'more project folders than RELAY_MAX_PROJECT_DIRS')
    assert.equal(s.discovery.maxProjectDirs, RELAY_MAX_PROJECT_DIRS)
    assert.equal(s.discovery.maxFilesPerDir, RELAY_MAX_FILES_PER_DIR)
    assert.equal(s.skippedSessions.fileLimit, 1, 'one transcript past RELAY_MAX_FILES_PER_DIR in a folder')
    assert.equal(s.skippedSessions.sizeLimit, 1, 'one transcript past the size cap')
  })

  it('going back to this workspace drops what the wider scan reported', async () => {
    assert.equal(await postScope('workspace'), 200)
    const s = await getStatus()
    assert.equal(s.allWorkspaces, false)
    assert.equal(s.discovery.projectDirsCapped, false)
    assert.deepEqual(s.skippedSessions, { watchLimit: 0, sizeLimit: 0, fileLimit: 0 })
  })
})
