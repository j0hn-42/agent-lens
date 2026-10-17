#!/usr/bin/env node
// Test double of the native menu binary (#335): speaks the JSON line protocol on stdin/stdout.
// It says "ready", logs every line it receives to FAKE_TRAY_LOG, then, on the first menu message, writes
// the raw lines of FAKE_TRAY_SEND (a JSON array of strings, valid or not, one per step, in order).
// FAKE_TRAY_DIE=after-menu exits with code 3 on the first menu. FAKE_TRAY_NO_READY=1 skips "ready".
// FAKE_TRAY_FLOOD_READY=<n> writes n more "ready" lines, one per millisecond; FAKE_TRAY_NO_READ=1 never reads its stdin.
import fs from 'node:fs'
import readline from 'node:readline'

const log = process.env.FAKE_TRAY_LOG
const toSend = JSON.parse(process.env.FAKE_TRAY_SEND ?? '[]')
let menus = 0

if (!process.env.FAKE_TRAY_NO_READY) process.stdout.write('{"v":1,"type":"ready"}\n')

const flood = Number(process.env.FAKE_TRAY_FLOOD_READY ?? 0)
// One line per millisecond, so the driver reads them as many separate chunks
let sent = 0
const floodNext = () => { if (sent++ < flood) { process.stdout.write('{"v":1,"type":"ready"}\n'); setTimeout(floodNext, 1) } }
floodNext()
if (process.env.FAKE_TRAY_NO_READ) {
  // A binary stuck in its loop: alive, never reading what the driver writes
  setInterval(() => {}, 1000)
} else {
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', line => {
    if (log) fs.appendFileSync(log, `${line}\n`)
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.type === 'quit') process.exit(0)
    if (msg.type === 'menu' && ++menus === 1) {
      if (process.env.FAKE_TRAY_DIE === 'after-menu') process.exit(3)
      let i = 0
      const next = () => { if (i < toSend.length) { process.stdout.write(`${toSend[i++]}\n`); setTimeout(next, 30) } }
      next()
    }
  })
  rl.on('close', () => process.exit(0))
}
