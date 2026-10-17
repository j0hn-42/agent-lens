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

// L'original voyage dans l'argument de la commande : JSON de la statusLine d'origine en base64url (ou null)
let arg: string | undefined
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')

function setOriginal(command: string | null) {
  arg = encode(command === null ? null : { type: 'command', command })
}

function setInstance(port: number, pid = process.pid, name = 'a.json', ws = workspace) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ workspace: ws, pid, port }))
}

function runWrapper(stdin: string, env: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise(resolve => {
    const t0 = Date.now()
    const args = arg === undefined ? [scriptPath] : [scriptPath, arg]
    const child = spawn(process.execPath, args, { env: { ...process.env, HOME: home, USERPROFILE: home, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', code => resolve({ stdout, stderr, code, ms: Date.now() - t0 }))
    child.stdin.end(stdin)
  })
}

interface Received { method?: string; url?: string; contentType?: string; body: string }

function startRelay(mode: 'ok' | 'hang' | 'notfound'): Promise<{ port: number; received: Received[]; close: () => void }> {
  const received: Received[] = []
  const sockets = new Set<net.Socket>()
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, contentType: req.headers['content-type'], body })
      if (mode === 'ok') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}') }
      if (mode === 'notfound') { res.writeHead(404); res.end('Not Found') }
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
  arg = undefined
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

  it('conserve les clés en plus de la statusLine d\'origine sans les interpréter', async () => {
    arg = encode({ type: 'command', command: 'echo hi', padding: 2, refreshInterval: 5 })
    const r = await runWrapper(STDIN)
    assert.deepEqual([r.stdout, r.code], ['hi\n', 0])
  })

  for (const [label, value] of [
    ['argument manquant', undefined],
    ['base64 corrompu', '!!!pas-du-base64***'],
    ['JSON corrompu', Buffer.from('{ nope').toString('base64url')],
    ['forme inattendue', Buffer.from('[1]').toString('base64url')],
  ] as const) {
    it(`${label} : une ligne claire sur stderr, aucune commande lancée, code 0`, async () => {
      const marker = path.join(root, `marker-${label.length}.txt`)
      fs.rmSync(marker, { force: true })
      arg = value
      const r = await runWrapper(STDIN)
      assert.equal(r.stdout, '')
      assert.equal(r.code, 0)
      assert.equal(r.stderr.trim().split('\n').length, 1)
      assert.match(r.stderr, /Agent Lens: the original statusLine could not be read; edit the "statusLine" entry of your Claude settings\.json by hand/)
      assert.equal(fs.existsSync(marker), false)
    })
  }

  it('garde de récursion : AGENT_LENS_STATUSLINE déjà posée, aucun fils lancé, une ligne sur stderr', async () => {
    const marker = path.join(root, 'rec-marker.txt')
    fs.rmSync(marker, { force: true })
    setOriginal(`touch '${marker}'; echo hi`)
    const r = await runWrapper(STDIN, { AGENT_LENS_STATUSLINE: '1' })
    assert.equal(r.stdout, '')
    assert.equal(r.stderr.trim().split('\n').length, 1)
    assert.equal(fs.existsSync(marker), false)
  })

  it('pose AGENT_LENS_STATUSLINE=1 dans l\'environnement du fils', async () => {
    setOriginal('printf %s "$AGENT_LENS_STATUSLINE"')
    const r = await runWrapper(STDIN, { AGENT_LENS_STATUSLINE: '' })
    assert.equal(r.stdout, '1')
  })

  const bash = ['/bin/bash', '/usr/bin/bash'].find(b => fs.existsSync(b))
  it('exécute la commande avec le shell de l\'utilisateur ($SHELL) : construction propre à bash', { skip: !bash || process.platform === 'win32' ? 'bash absent ou Windows' : false }, async () => {
    setOriginal('if [[ "abc" == a* ]]; then printf bash-ok; fi')
    const r = await runWrapper(STDIN, { SHELL: bash })
    assert.equal(r.stdout, 'bash-ok')
    assert.equal(r.code, 0)
  })

  // Un `fish -c` casse des commandes valides ($(cat), ${var}, [[ ]]) : seuls bash et zsh sont suivis, le reste repasse par bash puis sh
  for (const name of ['fish', 'tcsh', 'nu']) {
    it(`$SHELL=${name} existant : ignoré, repli sur bash (ou sh) ; la construction bash s'exécute`, { skip: !bash || process.platform === 'win32' ? 'bash absent ou Windows' : false }, async () => {
      const fake = path.join(fs.mkdtempSync(path.join(root, 'shell-')), name)
      fs.writeFileSync(fake, '#!/bin/sh\nprintf "%s" "$name-utilise"; exit 99\n', { mode: 0o755 })
      setOriginal('v=ok; if [[ "abc" == a* ]]; then printf "${v}-bash"; fi')
      const r = await runWrapper(STDIN, { SHELL: fake })
      assert.equal(r.stdout, 'ok-bash')
      assert.equal(r.code, 0)
    })
  }

  it('$SHELL=zsh existant : conservé', { skip: process.platform === 'win32' ? 'Windows' : false }, async () => {
    const fake = path.join(fs.mkdtempSync(path.join(root, 'shell-')), 'zsh')
    fs.writeFileSync(fake, '#!/bin/sh\nprintf zsh-utilise\n', { mode: 0o755 })
    setOriginal('true')
    const r = await runWrapper(STDIN, { SHELL: fake })
    assert.equal(r.stdout, 'zsh-utilise')
  })

  it('$SHELL absent ou invalide : repli sur /bin/sh', { skip: process.platform === 'win32' ? 'Windows' : false }, async () => {
    setOriginal('printf sh-ok')
    for (const SHELL of ['', '/nexiste/pas']) assert.equal((await runWrapper(STDIN, { SHELL })).stdout, 'sh-ok')
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

  // Marges larges (machine chargée) : on prouve l'indépendance (le serveur muet ne répond jamais et le processus sort
  // quand même), pas des millisecondes.
  it('relais arrêté (connexion refusée) : sortie et code identiques, sans attente notable', async () => {
    const base = await baseline()
    setInstance(await freePort())
    setOriginal(COMMAND)
    const r = await runWrapper(STDIN)
    assert.deepEqual([r.stdout, r.stderr, r.code], [base.stdout, base.stderr, base.code])
    assert.ok(r.ms - base.ms < 2000, `retard ${r.ms - base.ms} ms`)
  })

  it('relais qui ne répond pas : sortie et code identiques, le processus sort sans réponse du serveur', async () => {
    const base = await baseline()
    const relay = await startRelay('hang')
    try {
      setInstance(relay.port)
      setOriginal(COMMAND)
      const r = await runWrapper(STDIN)
      assert.deepEqual([r.stdout, r.stderr, r.code], [base.stdout, base.stderr, base.code])
      assert.equal(relay.received.length, 1, 'la requête est bien partie, et restée sans réponse')
      assert.ok(r.ms - base.ms < 3000, `retard ${r.ms - base.ms} ms`)
    } finally { relay.close() }
  })

  it('relais muet et commande d\'origine lente : la sortie arrive, avec le code de la commande', async () => {
    const relay = await startRelay('hang')
    try {
      setInstance(relay.port)
      setOriginal(`sleep 0.6; printf fin`)
      const r = await runWrapper(STDIN)
      assert.deepEqual([r.stdout, r.code], ['fin', 0])
      assert.ok(r.ms < 5000, `durée ${r.ms} ms`)
    } finally { relay.close() }
  })
})

describe('statusline-wrapper : toutes les instances, fenêtres partielles, signaux', () => {
  it('envoie à toutes les instances vivantes (le quota est celui du compte), sans tenir compte des espaces de travail', async () => {
    const one = await startRelay('ok')
    const two = await startRelay('ok')
    try {
      setInstance(one.port, process.pid, 'a.json', workspace)
      setInstance(two.port, process.pid, 'b.json', path.join(root, 'autre-espace'))
      setOriginal(null)
      await runWrapper(STDIN)
      assert.equal(one.received.length, 1)
      assert.equal(two.received.length, 1)
      assert.deepEqual(JSON.parse(one.received[0].body), JSON.parse(two.received[0].body))
    } finally { one.close(); two.close() }
  })

  it('une instance qui répond 404 (extension sans route) n\'empêche pas l\'autre de recevoir', async () => {
    const refusing = await startRelay('notfound')
    const good = await startRelay('ok')
    try {
      setInstance(refusing.port, process.pid, 'a.json')
      setInstance(good.port, process.pid, 'b.json')
      setOriginal('echo hi')
      const r = await runWrapper(STDIN)
      assert.deepEqual([r.stdout, r.code], ['hi\n', 0])
      assert.equal(good.received.length, 1)
      assert.equal(fs.existsSync(path.join(dir, 'a.json')), true, 'un 404 ne prouve pas que l\'instance est morte')
    } finally { refusing.close(); good.close() }
  })

  it('fenêtre invalide omise, l\'autre part quand même (mêmes bornes que le relais)', async () => {
    const relay = await startRelay('ok')
    try {
      setInstance(relay.port)
      setOriginal(null)
      await runWrapper(JSON.stringify({
        cwd: workspace,
        rate_limits: {
          five_hour: { used_percentage: 38, resets_at: 1790000000 },
          seven_day: { used_percentage: 5, resets_at: null },
          spend_limit: { used_percentage: 1, resets_at: 1790000000 },
        },
      }))
      assert.deepEqual(JSON.parse(relay.received[0].body), { rate_limits: { five_hour: { used_percentage: 38, resets_at: 1790000000 } } })
    } finally { relay.close() }
  })

  for (const [label, win] of [
    ['pourcentage > 100', { used_percentage: 100.5, resets_at: 1790000000 }],
    ['pourcentage négatif', { used_percentage: -1, resets_at: 1790000000 }],
    ['pourcentage non fini', { used_percentage: 'NaN', resets_at: 1790000000 }],
    ['resets_at non entier', { used_percentage: 5, resets_at: 1790000000.5 }],
    ['resets_at négatif', { used_percentage: 5, resets_at: -1 }],
    ['resets_at hors borne', { used_percentage: 5, resets_at: 8.64e12 + 1 }],
    ['resets_at manquant', { used_percentage: 5 }],
    ['pourcentage manquant', { resets_at: 1790000000 }],
  ] as const) {
    it(`${label} : aucune fenêtre valide, rien n'est envoyé`, async () => {
      const relay = await startRelay('ok')
      try {
        setInstance(relay.port)
        setOriginal('echo hi')
        const r = await runWrapper(JSON.stringify({ cwd: workspace, rate_limits: { five_hour: win } }))
        assert.equal(r.stdout, 'hi\n')
        assert.equal(relay.received.length, 0)
      } finally { relay.close() }
    })
  }

  it('bornes incluses : 0 et 100, resets_at 0 et 8.64e12 sont valides', async () => {
    const relay = await startRelay('ok')
    try {
      setInstance(relay.port)
      setOriginal(null)
      await runWrapper(JSON.stringify({ cwd: workspace, rate_limits: { five_hour: { used_percentage: 0, resets_at: 0 }, seven_day: { used_percentage: 100, resets_at: 8.64e12 } } }))
      assert.deepEqual(JSON.parse(relay.received[0].body).rate_limits, { five_hour: { used_percentage: 0, resets_at: 0 }, seven_day: { used_percentage: 100, resets_at: 8.64e12 } })
    } finally { relay.close() }
  })

  it('SIGTERM : transmis au fils ; s\'il l\'ignore, sortie de secours rapide', { skip: process.platform === 'win32' ? 'Windows' : false }, async () => {
    setOriginal('trap "" TERM; sleep 4')
    const child = spawn(process.execPath, [scriptPath, arg as string], { env: { ...process.env, HOME: home, USERPROFILE: home } })
    const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code))) // 'exit': l'orphelin sleep garde les tubes ouverts
    child.stdin.end(STDIN)
    await new Promise(r => setTimeout(r, 500))
    const t0 = Date.now()
    child.kill('SIGTERM')
    const code = await exited
    assert.ok(Date.now() - t0 < 3000, `sorti après ${Date.now() - t0} ms, le fils dormait 4 s`)
    assert.equal(code, 128 + 15)
  })
})
