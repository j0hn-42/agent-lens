/**
 * Script enveloppe de barre d'état (#467) : exécuté comme processus enfant, avec un faux HOME et un faux relais HTTP.
 * La barre d'état de l'utilisateur ne doit jamais changer : même stdin, même stdout/stderr, même code de retour.
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getStatuslineScriptContent } = require('./statusline-wrapper.js') as { getStatuslineScriptContent: () => string }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'al-sl-'))
const scriptPath = path.join(root, 'statusline.js')
const workspace = path.join(root, 'ws')

interface Run { stdout: string; stderr: string; code: number | null; ms: number }

let home: string
let dir: string

function setOriginal(command: string | null) {
  fs.writeFileSync(path.join(dir, 'statusline-original.json'), JSON.stringify({ command }))
}

function setInstance(port: number, pid = process.pid) {
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ workspace, pid, port }))
}

function runWrapper(stdin: string): Promise<Run> {
  return new Promise(resolve => {
    const t0 = Date.now()
    const child = spawn(process.execPath, [scriptPath], { env: { ...process.env, HOME: home, USERPROFILE: home } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', code => resolve({ stdout, stderr, code, ms: Date.now() - t0 }))
    child.stdin.end(stdin)
  })
}

interface Received { method?: string; url?: string; contentType?: string; body: string }

function startRelay(mode: 'ok' | 'hang'): Promise<{ port: number; received: Received[]; close: () => void }> {
  const received: Received[] = []
  const sockets = new Set<net.Socket>()
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, contentType: req.headers['content-type'], body })
      if (mode === 'ok') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}') }
    })
  })
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    port: (server.address() as net.AddressInfo).port,
    received,
    close: () => { for (const s of sockets) s.destroy(); server.close() },
  })))
}

async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as net.AddressInfo).port
  await new Promise<void>(r => s.close(() => r()))
  return port
}

const PAYLOAD = {
  session_id: 'sess-secret', cwd: workspace, model: { id: 'm' }, transcript_path: '/home/x/t.jsonl',
  rate_limits: {
    five_hour: { used_percentage: 38.5, resets_at: 1790000000, extra: 'x' },
    seven_day: { used_percentage: 12, resets_at: 1790500000 },
    other: { used_percentage: 1, resets_at: 1 },
  },
}
const STDIN = JSON.stringify(PAYLOAD)

before(() => {
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(scriptPath, getStatuslineScriptContent())
})
after(() => fs.rmSync(root, { recursive: true, force: true }))
beforeEach(() => {
  home = fs.mkdtempSync(path.join(root, 'home-'))
  dir = path.join(home, '.claude', 'agent-lens')
  fs.mkdirSync(dir, { recursive: true })
})

describe('statusline-wrapper : transmission de la commande d\'origine', () => {
  it('passe le même stdin, reproduit stdout et stderr', async () => {
    const out = path.join(root, 'stdin-copy.txt')
    setOriginal(`cat > '${out}'; printf 'barre|ok'; printf 'avert' >&2`)
    const r = await runWrapper(STDIN)
    assert.equal(r.stdout, 'barre|ok')
    assert.equal(r.stderr, 'avert')
    assert.equal(r.code, 0)
    assert.equal(fs.readFileSync(out, 'utf8'), STDIN)
  })

  it('transmet les octets du stdin tels quels (UTF-8, sans JSON valide)', async () => {
    const out = path.join(root, 'raw-copy.txt')
    setOriginal(`cat > '${out}'`)
    const raw = '{"x":"é€ \u{1F600}"\n  pas du json'
    await runWrapper(raw)
    assert.equal(fs.readFileSync(out, 'utf8'), raw)
  })

  it('reproduit un code de retour non nul et stderr', async () => {
    setOriginal(`echo oups >&2; exit 3`)
    const r = await runWrapper(STDIN)
    assert.equal(r.code, 3)
    assert.equal(r.stderr, 'oups\n')
    assert.equal(r.stdout, '')
  })

  it('un signal donne 128+n', { skip: process.platform === 'win32' }, async () => {
    setOriginal(`kill -TERM $$`)
    const r = await runWrapper(STDIN)
    assert.equal(r.code, 128 + 15)
  })

  it('sans commande d\'origine : n\'affiche rien, code 0', async () => {
    setOriginal(null)
    const r = await runWrapper(STDIN)
    assert.deepEqual([r.stdout, r.stderr, r.code], ['', '', 0])
  })

  it('sans fichier d\'origine : n\'affiche rien, code 0', async () => {
    const r = await runWrapper(STDIN)
    assert.deepEqual([r.stdout, r.stderr, r.code], ['', '', 0])
  })
})

describe('statusline-wrapper : envoi au relais', () => {
  it('n\'envoie que rate_limits (deux fenêtres, deux champs numériques)', async () => {
    const relay = await startRelay('ok')
    try {
      setInstance(relay.port)
      setOriginal('echo hi')
      const r = await runWrapper(STDIN)
      assert.equal(r.stdout, 'hi\n')
      assert.equal(relay.received.length, 1)
      const got = relay.received[0]
      assert.equal(got.method, 'POST')
      assert.equal(got.url, '/quota')
      assert.equal(got.contentType, 'application/json')
      assert.deepEqual(JSON.parse(got.body), {
        rate_limits: {
          five_hour: { used_percentage: 38.5, resets_at: 1790000000 },
          seven_day: { used_percentage: 12, resets_at: 1790500000 },
        },
      })
      assert.doesNotMatch(got.body, /sess-secret|transcript|model|extra/)
    } finally { relay.close() }
  })

  it('envoie aussi sans commande d\'origine', async () => {
    const relay = await startRelay('ok')
    try {
      setInstance(relay.port)
      setOriginal(null)
      const r = await runWrapper(STDIN)
      assert.equal(r.stdout, '')
      assert.equal(relay.received.length, 1)
    } finally { relay.close() }
  })

  it('une seule fenêtre présente : n\'envoie que celle-là', async () => {
    const relay = await startRelay('ok')
    try {
      setInstance(relay.port)
      setOriginal(null)
      await runWrapper(JSON.stringify({ cwd: workspace, rate_limits: { seven_day: { used_percentage: 5, resets_at: 1790500000 } } }))
      assert.deepEqual(JSON.parse(relay.received[0].body), { rate_limits: { seven_day: { used_percentage: 5, resets_at: 1790500000 } } })
    } finally { relay.close() }
  })

  for (const [label, stdin] of [
    ['sans rate_limits', JSON.stringify({ cwd: workspace, session_id: 's' })],
    ['rate_limits sans fenêtre', JSON.stringify({ cwd: workspace, rate_limits: {} })],
    ['JSON invalide', 'pas du json'],
  ] as const) {
    it(`${label} : rien n'est envoyé, la sortie est inchangée`, async () => {
      const relay = await startRelay('ok')
      try {
        setInstance(relay.port)
        setOriginal('echo hi')
        const r = await runWrapper(stdin)
        assert.equal(r.stdout, 'hi\n')
        assert.equal(relay.received.length, 0)
      } finally { relay.close() }
    })
  }

  it('cwd hors de tout espace de travail : envoie quand même à l\'instance vivante (le quota est celui du compte)', async () => {
    const relay = await startRelay('ok')
    try {
      setInstance(relay.port)
      setOriginal(null)
      await runWrapper(JSON.stringify({ ...PAYLOAD, cwd: path.join(root, 'ailleurs') }))
      assert.equal(relay.received.length, 1)
    } finally { relay.close() }
  })

  it('instance dont le PID est mort : fichier supprimé, rien envoyé', async () => {
    const relay = await startRelay('ok')
    try {
      setInstance(relay.port, 2 ** 22 + 12345)
      setOriginal('echo hi')
      const r = await runWrapper(STDIN)
      assert.equal(r.stdout, 'hi\n')
      assert.equal(relay.received.length, 0)
      assert.equal(fs.existsSync(path.join(dir, 'a.json')), false)
    } finally { relay.close() }
  })
})

describe('statusline-wrapper : relais absent ou muet', () => {
  const COMMAND = `printf 'barre'; exit 2`

  async function baseline(): Promise<Run> {
    fs.rmSync(path.join(dir, 'a.json'), { force: true })
    setOriginal(COMMAND)
    return runWrapper(STDIN)
  }

  it('aucune instance : sortie identique', async () => {
    const base = await baseline()
    assert.equal(base.stdout, 'barre')
    assert.equal(base.code, 2)
  })

  it('relais arrêté (connexion refusée) : sortie et code identiques, retard < 300 ms', async () => {
    const base = await baseline()
    setInstance(await freePort())
    setOriginal(COMMAND)
    const r = await runWrapper(STDIN)
    assert.deepEqual([r.stdout, r.stderr, r.code], [base.stdout, base.stderr, base.code])
    assert.ok(r.ms - base.ms < 300, `retard ${r.ms - base.ms} ms`)
  })

  it('relais qui ne répond pas : sortie et code identiques, durée bornée', async () => {
    const base = await baseline()
    const relay = await startRelay('hang')
    try {
      setInstance(relay.port)
      setOriginal(COMMAND)
      const r = await runWrapper(STDIN)
      assert.deepEqual([r.stdout, r.stderr, r.code], [base.stdout, base.stderr, base.code])
      // plafond dur de 300 ms + marge de démarrage de processus ; jamais l'attente d'une réponse
      assert.ok(r.ms - base.ms < 600, `retard ${r.ms - base.ms} ms`)
    } finally { relay.close() }
  })

  it('relais muet et commande d\'origine lente : la sortie arrive à la fin de la commande, pas après', async () => {
    const relay = await startRelay('hang')
    try {
      setInstance(relay.port)
      setOriginal(`sleep 0.6; printf fin`)
      const r = await runWrapper(STDIN)
      assert.equal(r.stdout, 'fin')
      assert.ok(r.ms < 600 + 500, `durée ${r.ms} ms`)
    } finally { relay.close() }
  })
})
