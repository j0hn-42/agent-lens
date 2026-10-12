// scripts/system-stats.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sampleSystem, nodeIo, type SystemIo } from './system-stats'

const KB = 1024
const meminfo = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k}:   ${v} kB`).join('\n')

function fakeIo(over: Partial<SystemIo> & { cpuIdle?: number[]; cpuBusy?: number[] } = {}): SystemIo {
  const idle = over.cpuIdle ?? [100, 100]
  const busy = over.cpuBusy ?? [100, 100]
  return {
    now: () => 1_000,
    cpus: () => idle.map((i, n) => ({ times: { user: busy[n], nice: 0, sys: 0, idle: i, irq: 0 } })),
    loadavg: () => [1, 2, 3],
    uptime: () => 42,
    totalmem: () => 8 * 1024 * KB,
    freemem: () => 1024 * KB,
    platform: 'linux',
    readText: (p) => p === '/proc/meminfo'
      ? meminfo({ MemTotal: 8192, MemAvailable: 6144, SwapTotal: 2048, SwapFree: 1024 })
      : p === '/proc/version' ? 'Linux version 5.15 generic' : null,
    statfs: () => ({ blocks: 1000, bsize: 4096, bavail: 250 }),
    cwd: '/work',
    ...over,
  }
}

test('premier échantillon : cpu null, pas de 0 inventé', () => {
  const { sample } = sampleSystem(null, fakeIo())
  assert.equal(sample.cpu.total, null)
  assert.deepEqual(sample.cpu.perCore, [null, null])
})

test('delta CPU : part occupée entre deux lectures', () => {
  const first = sampleSystem(null, fakeIo({ cpuIdle: [100, 100], cpuBusy: [100, 100] }))
  const { sample } = sampleSystem(first.counters, fakeIo({ cpuIdle: [150, 100], cpuBusy: [150, 200] }))
  assert.equal(sample.cpu.perCore[0], 0.5)
  assert.equal(sample.cpu.perCore[1], 1)
  assert.equal(sample.cpu.total, 0.75)
})

test('compteurs qui reculent ou delta nul : null', () => {
  const first = sampleSystem(null, fakeIo({ cpuIdle: [200, 100], cpuBusy: [200, 100] }))
  const { sample } = sampleSystem(first.counters, fakeIo({ cpuIdle: [100, 100], cpuBusy: [100, 100] }))
  assert.equal(sample.cpu.perCore[0], null)
  assert.equal(sample.cpu.perCore[1], null)
  assert.equal(sample.cpu.total, null)
})

test('Linux : la RAM utilise MemAvailable, pas os.freemem', () => {
  const { sample } = sampleSystem(null, fakeIo())
  assert.deepEqual(sample.mem, { total: 8192 * KB, used: (8192 - 6144) * KB })
})

test('Linux sans MemAvailable : mem null (os.freemem compte le cache comme utilisé)', () => {
  const io = fakeIo({ readText: (p) => (p === '/proc/meminfo' ? meminfo({ MemTotal: 8192 }) : null) })
  assert.equal(sampleSystem(null, io).sample.mem, null)
})

test('macOS : mem null (la mémoire libre exclut le cache, rien de prouvable)', () => {
  const io = fakeIo({ platform: 'darwin', readText: () => null })
  const { sample } = sampleSystem(null, io)
  assert.equal(sample.mem, null)
  assert.equal(sample.swap, null)
})

test('Windows : os.totalmem - os.freemem', () => {
  const io = fakeIo({ platform: 'win32', readText: () => null })
  const { sample } = sampleSystem(null, io)
  assert.deepEqual(sample.mem, { total: 8 * 1024 * KB, used: 7 * 1024 * KB })
  assert.equal(sample.swap, null)
})

test('swap : mesuré, et de taille 0 sans pourcentage inventé', () => {
  assert.deepEqual(sampleSystem(null, fakeIo()).sample.swap, { total: 2048 * KB, used: 1024 * KB })
  const none = fakeIo({ readText: (p) => (p === '/proc/meminfo' ? meminfo({ MemTotal: 8192, MemAvailable: 6144, SwapTotal: 0, SwapFree: 0 }) : null) })
  assert.deepEqual(sampleSystem(null, none).sample.swap, { total: 0, used: 0 })
})

test('disque : statfs, null en erreur', () => {
  assert.deepEqual(sampleSystem(null, fakeIo()).sample.disk, { total: 1000 * 4096, used: 750 * 4096 })
  assert.equal(sampleSystem(null, fakeIo({ statfs: () => null })).sample.disk, null)
})

test('charge : null sous Windows', () => {
  assert.deepEqual(sampleSystem(null, fakeIo()).sample.load, [1, 2, 3])
  assert.equal(sampleSystem(null, fakeIo({ platform: 'win32', readText: () => null })).sample.load, null)
})

test('platformNote : WSL2 signalé, sinon null', () => {
  const wsl = fakeIo({ readText: (p) => (p === '/proc/version' ? 'Linux version 5.15-microsoft-standard-WSL2' : p === '/proc/meminfo' ? meminfo({ MemTotal: 1, MemAvailable: 1, SwapTotal: 0, SwapFree: 0 }) : null) })
  assert.match(sampleSystem(null, wsl).sample.platformNote ?? '', /WSL2/)
  assert.equal(sampleSystem(null, fakeIo()).sample.platformNote, null)
})

test('une lecture qui lève ne casse pas les autres métriques', () => {
  const io = fakeIo({ statfs: () => { throw new Error('boom') }, readText: () => { throw new Error('boom') } })
  const { sample } = sampleSystem(null, io)
  assert.equal(sample.disk, null)
  assert.equal(sample.mem, null)
  assert.equal(sample.uptime, 42)
})

const tick = () => new Promise(r => setImmediate(r))
const stat = { blocks: 1000, bsize: 4096, bavail: 250 }

test('nodeIo : un statfs qui ne répond jamais ne bloque pas, une seule requête en vol', async () => {
  let calls = 0
  const io = nodeIo({ statfs: () => { calls++; return new Promise(() => {}) } })
  for (let i = 0; i < 4; i++) {
    assert.equal(sampleSystem(null, io).sample.disk, null)
    await tick()
  }
  assert.equal(calls, 1)
})

test('nodeIo : la valeur résolue apparaît à un échantillon ultérieur, un rejet la remet à null', async () => {
  let mode: 'ok' | 'fail' = 'ok'
  const io = nodeIo({ statfs: async () => { if (mode === 'fail') throw new Error('EIO'); return stat } })
  assert.equal(sampleSystem(null, io).sample.disk, null)
  await tick(); await tick()
  assert.deepEqual(sampleSystem(null, io).sample.disk, { total: 1000 * 4096, used: 750 * 4096 })
  await tick(); await tick() // the refresh started by the previous sample settles
  mode = 'fail'
  sampleSystem(null, io) // lance un rafraîchissement qui échoue
  await tick(); await tick()
  assert.equal(sampleSystem(null, io).sample.disk, null)
})

test('nodeIo : /proc/version lu une seule fois', () => {
  let reads = 0
  const io = nodeIo({ readText: (p) => { if (p === '/proc/version') reads++; return null } })
  for (let i = 0; i < 3; i++) sampleSystem(null, io)
  assert.equal(reads, 1)
})
