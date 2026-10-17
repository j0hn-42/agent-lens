#!/usr/bin/env node
// Test double of the native menu binary (#335): speaks the JSON line protocol on stdin/stdout.
// It says "ready", logs every line it receives to FAKE_TRAY_LOG, then, on the first menu message, writes
// the raw lines of FAKE_TRAY_SEND (a JSON array of strings, valid or not, one per step, in order).
// FAKE_TRAY_DIE=after-menu exits with code 3 on the first menu. FAKE_TRAY_NO_READY=1 skips "ready".
import fs from 'node:fs'
import readline from 'node:readline'

const log = process.env.FAKE_TRAY_LOG
const toSend = JSON.parse(process.env.FAKE_TRAY_SEND ?? '[]')
let menus = 0

if (!process.env.FAKE_TRAY_NO_READY) process.stdout.write('{"v":1,"type":"ready"}\n')

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
