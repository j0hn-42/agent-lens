/**
 * GET /issue-links (#63) through the REAL servers: the standalone app (app/src/server.ts) and the dev
 * relay (scripts/dev-relay.ts). Both are started as child processes, with a fake `gh` first on the PATH
 * and a throw-away HOME, so the route wiring, the 'api' guard (strict headers) and the default probe
 * (git origin, then gh) are exercised end to end. The web degrades silently when this route fails, so
 * a miswired route would otherwise leave no trace.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const ROOT = path.resolve(__dirname, '..')
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx')
const REPO = 'https://github.com/o/r'

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'af-real-servers-')))
const home = path.join(base, 'home')
const workspace = path.join(base, 'workspace')
const binDir = path.join(base, 'bin')
const ghLog = path.join(base, 'gh.log')

const FAKE_GH = `#!/bin/sh
echo "$*" >> "${ghLog}"
sleep 0.3
case "$1" in
  pr) echo '[{"number":5,"title":"A PR","url":"${REPO}/pull/5","state":"OPEN","isDraft":true}]' ;;
  issue) echo '[{"number":7,"title":"An issue","url":"${REPO}/issues/7","state":"OPEN"}]' ;;
  *) exit 1 ;;
esac
`

interface Running { child: ChildProcess; port: number }
const running: ChildProcess[] = []

/** The extension code requires 'vscode': the same alias the other relay tests install, loaded first. */
function entryFor(script: string): string {
  const file = path.join(base, `entry-${path.basename(script, '.ts')}.ts`)
  fs.writeFileSync(file, `import ${JSON.stringify(path.join(ROOT, 'extension/test/helpers/alias-vscode'))}\nimport ${JSON.stringify(path.join(ROOT, script))}\n`)
  return file
}

/** `ready` captures the port from the line the server prints once it listens (the relay's hook server prints one too). */
function start(script: string, args: string[], ready: RegExp): Promise<Running> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [entryFor(script), ...args], {
      cwd: workspace,
      env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, AGENT_LENS_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    running.push(child)
    let out = ''
    const timer = setTimeout(() => reject(new Error(`${script} did not start:\n${out}`)), 20_000)
    const onData = (c: Buffer) => {
      out += c.toString()
      const m = ready.exec(out)
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]) }) }
    }
    child.stdout!.on('data', onData)
    child.stderr!.on('data', onData)
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`${script} exited early (${code}):\n${out}`)) })
  })
}

async function get(port: number, urlPath: string, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, { method })
  return { status: res.status, headers: res.headers, body: await res.text() }
}

function suite(name: string, startIt: () => Promise<Running>) {
  describe(name, () => {
    let srv: Running
    before(async () => { srv = await startIt() })

    it('GET /issue-links?role= answers the links read through gh, as strict JSON', async () => {
      const r = await get(srv.port, '/issue-links?role=qa-engineer')
      assert.equal(r.status, 200, r.body)
      assert.match(String(r.headers.get("content-type")), /application\/json/, `${r.status} ${r.body}`)
      assert.equal(r.headers.get('cache-control'), 'no-store')
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
      assert.match(String(r.headers.get('content-security-policy')), /default-src 'none'/, "classified 'api', not 'static'")
      const body = JSON.parse(r.body)
      assert.equal(body.role, 'qa-engineer')
      assert.deepEqual(body.links.map((l: { kind: string; number: number; draft?: boolean }) => `${l.kind}#${l.number}${l.draft ? ':draft' : ''}`), ['pr#5:draft', 'issue#7'])
      const calls = fs.readFileSync(ghLog, 'utf8')
      assert.match(calls, /--repo o\/r --label agent:qa-engineer/, 'queried the origin repository and the role label')
    })

    it('rejects an invalid role (400) and a write method (405) instead of answering links', async () => {
      assert.equal((await get(srv.port, '/issue-links')).status, 400)
      assert.equal((await get(srv.port, '/issue-links?role=--repo')).status, 400)
      assert.equal((await get(srv.port, '/issue-links?role=qa', 'POST')).status, 405)
    })

    it('two concurrent requests for a role share one gh lookup (pr + issue), not two', async () => {
      const role = `coalesce-${srv.port}` // the gh log is shared by both servers
      const [a, b] = await Promise.all([get(srv.port, `/issue-links?role=${role}`), get(srv.port, `/issue-links?role=${role}`)])
      assert.equal(a.status, 200)
      assert.equal(b.body, a.body)
      const runs = fs.readFileSync(ghLog, 'utf8').split('\n').filter(l => l.includes(`agent:${role}`))
      assert.equal(runs.length, 2, runs.join(' | '))
    })

    it('a lookalike path is not the route', async () => {
      const r = await get(srv.port, '/issue-linksx?role=qa')
      assert.ok(!r.body.includes('"links"'), r.body)
    })
  })
}

describe('real servers: GET /issue-links', () => {
  before(() => {
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(workspace, { recursive: true })
    fs.mkdirSync(binDir, { recursive: true })
    fs.writeFileSync(path.join(binDir, 'gh'), FAKE_GH, { mode: 0o755 })
    execFileSync('git', ['init', '-q'], { cwd: workspace })
    execFileSync('git', ['remote', 'add', 'origin', `${REPO}.git`], { cwd: workspace })
  })

  after(() => {
    for (const c of running) { c.kill('SIGKILL'); c.stdout?.destroy(); c.stderr?.destroy() }
    fs.rmSync(base, { recursive: true, force: true })
  })

  suite('standalone app server (app/src/server.ts)', () => start('app/src/app.ts', ['--port', '0', '--no-open'], /Server running at http:\/\/127\.0\.0\.1:(\d+)/))
  suite('dev relay (scripts/dev-relay.ts)', () => start('scripts/dev-relay.ts', [workspace], /SSE relay on http:\/\/127\.0\.0\.1:(\d+)\/events/))
})
