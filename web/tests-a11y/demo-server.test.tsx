// Garde-fous du serveur démo e2e (#132) : il ne doit ni partager le dossier de build du dev server de
// l'utilisateur (verrou .next/dev/lock), ni survivre à un test tué avant `after()`.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { demoServerEnv, E2E_DIST_DIR, spawnGuarded, stopProcessGroup, startWithRetries, StartExitedError } from './e2e/demo-server'

const WEB_DIR = path.resolve(__dirname, '..')

async function loadConfig(distDir: string | undefined) {
  const saved = process.env.NEXT_DIST_DIR
  if (distDir === undefined) delete process.env.NEXT_DIST_DIR
  else process.env.NEXT_DIST_DIR = distDir
  try {
    const url = pathToFileURL(path.join(WEB_DIR, 'next.config.mjs')).href + `?t=${Math.random()}`
    return (await import(url)).default as { distDir?: string }
  } finally {
    if (saved === undefined) delete process.env.NEXT_DIST_DIR
    else process.env.NEXT_DIST_DIR = saved
  }
}

test('next.config : distDir par défaut .next, surchargeable par NEXT_DIST_DIR', async () => {
  assert.equal((await loadConfig(undefined)).distDir, '.next')
  assert.equal((await loadConfig('.next-e2e')).distDir, '.next-e2e')
})

test('le serveur démo reçoit son propre dossier de build', () => {
  const env = demoServerEnv({ PATH: '/bin' })
  assert.equal(env.NEXT_DIST_DIR, E2E_DIST_DIR)
  assert.notEqual(E2E_DIST_DIR, '.next')
  assert.equal(env.NEXT_PUBLIC_DEMO, '1')
})

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (!isAlive(pid)) return true
    await new Promise(r => setTimeout(r, 100))
  }
  return false
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`un processus de test tué par ${signal} emporte le serveur détaché`, async () => {
    const script = `
      const { spawnGuarded } = require(${JSON.stringify(path.join(__dirname, 'e2e', 'demo-server.ts'))})
      const child = spawnGuarded(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
      process.stdout.write('PID=' + child.pid + '\\n')
      setInterval(() => {}, 1000)
    `
    const runner = spawn(process.execPath, ['--import', 'tsx', '-e', script], { cwd: WEB_DIR, stdio: ['ignore', 'pipe', 'inherit'] })
    const pid = await new Promise<number>((resolve, reject) => {
      runner.once('error', reject)
      runner.stdout!.once('data', d => resolve(Number(/PID=(\d+)/.exec(String(d))![1])))
    })
    assert.ok(isAlive(pid), 'le serveur détaché tourne')
    runner.kill(signal)
    await new Promise(r => runner.once('exit', r))
    const dead = await waitDead(pid)
    if (!dead) process.kill(-pid, 'SIGKILL')
    assert.ok(dead, 'le serveur détaché est arrêté avec le processus de test')
  })
}

function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true } catch { return false }
}

// #440 : stop() rendait la main dès que `pnpm` (chef du groupe) sortait, alors que next dev et next-server
// vivaient encore quelques secondes : le serveur du fichier suivant démarrait pendant cet arrêt.
test('stopProcessGroup attend que tout le groupe soit mort, pas seulement son chef', async () => {
  // Chef : sort tout de suite sur SIGTERM. Petit-fils : met 1,5 s à mourir après le même signal.
  const script = `sh -c 'trap "sleep 1.5; exit 0" TERM; while :; do sleep 0.1; done' & trap "exit 0" TERM; wait`
  const child = spawnGuarded('sh', ['-c', script], { stdio: 'ignore' })
  const pgid = child.pid!
  try {
    await new Promise(r => setTimeout(r, 400)) // laisse les traps s'installer
    assert.ok(groupAlive(pgid), 'le groupe tourne')
    const t0 = Date.now()
    await stopProcessGroup(child)
    assert.ok(!groupAlive(pgid), 'plus aucun membre du groupe après stopProcessGroup')
    assert.ok(Date.now() - t0 >= 1000, 'il a attendu le petit-fils, pas seulement le chef')
  } finally {
    try { process.kill(-pgid, 'SIGKILL') } catch { /* déjà mort */ }
  }
})

test('stopProcessGroup passe à SIGKILL quand le groupe ignore SIGTERM', async () => {
  const child = spawnGuarded('sh', ['-c', 'trap "" TERM; while :; do sleep 0.1; done'], { stdio: 'ignore' })
  const pgid = child.pid!
  try {
    await new Promise(r => setTimeout(r, 300))
    await stopProcessGroup(child, 500)
    assert.ok(!groupAlive(pgid))
  } finally {
    try { process.kill(-pgid, 'SIGKILL') } catch { /* déjà mort */ }
  }
})

test("startWithRetries relance sur un nouveau port quand le serveur sort avant de répondre, sans masquer l'échec final", async () => {
  const seen: number[] = []
  let n = 0
  const ok = await startWithRetries(async attempt => {
    seen.push(attempt)
    if (++n < 3) throw new StartExitedError('EADDRINUSE')
    return 'prêt'
  }, 3)
  assert.equal(ok, 'prêt')
  assert.deepEqual(seen, [1, 2, 3])

  await assert.rejects(startWithRetries(async () => { throw new StartExitedError('toujours') }, 3), /toujours/)
  let calls = 0
  await assert.rejects(startWithRetries(async () => { calls++; throw new Error('délai dépassé') }, 3), /délai dépassé/)
  assert.equal(calls, 1, "un délai dépassé (serveur vivant mais muet) n'est pas relancé")
})
