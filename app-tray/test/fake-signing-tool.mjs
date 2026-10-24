#!/usr/bin/env node
// Test double of the signing tools (#512): codesign, security, xcrun (notarytool), ditto and signtool. It is reached
// through a symlink named after the tool, logs its argv as one JSON line to FAKE_SIGN_LOG, and echoes its argv to
// stdout and stderr (so a test can check that the caller never prints a secret it passed on a command line).
// FAKE_SIGN_FAIL picks the step that goes wrong: codesign-sign, codesign-verify, codesign-no-runtime,
// codesign-wrong-team, notary-invalid, notary-exit, signtool-sign, signtool-verify, security-import.
import fs from 'node:fs'
import path from 'node:path'

const tool = path.basename(process.argv[1]).replace(/\.exe$/, '')
const args = process.argv.slice(2)
const fail = process.env.FAKE_SIGN_FAIL ?? ''
if (process.env.FAKE_SIGN_LOG) fs.appendFileSync(process.env.FAKE_SIGN_LOG, JSON.stringify({ tool, args }) + '\n')
const echo = `${tool} ${args.join(' ')}\n`

function out(code, stdout = echo, stderr = echo) {
  process.stdout.write(stdout)
  process.stderr.write(stderr)
  process.exit(code)
}

if (tool === 'codesign') {
  if (args.includes('--sign')) out(fail === 'codesign-sign' ? 1 : 0)
  if (args.includes('--verify')) out(fail === 'codesign-verify' ? 3 : 0)
  if (args.includes('--display')) {
    const flags = fail === 'codesign-no-runtime' ? 'flags=0x0(none)' : 'flags=0x10000(runtime)'
    const team = fail === 'codesign-wrong-team' ? 'OTHERTEAM1' : (process.env.FAKE_SIGN_TEAM ?? '')
    out(0, echo, `${echo}Identifier=agent-lens-tray\nCodeDirectory v=20500 size=1 ${flags} hashes=1+2 location=embedded\nTeamIdentifier=${team}\n`)
  }
  out(2)
}
if (tool === 'security') out(fail === 'security-import' && args[0] === 'import' ? 1 : 0)
if (tool === 'ditto') {
  fs.writeFileSync(args[args.length - 1], 'zip')
  out(0)
}
if (tool === 'xcrun') {
  if (fail === 'notary-exit') out(1)
  const status = fail === 'notary-invalid' ? 'Invalid' : 'Accepted'
  out(0, JSON.stringify({ id: 'fake-submission', status, message: echo.trim() }) + '\n')
}
if (tool === 'signtool') {
  if (args[0] === 'sign') out(fail === 'signtool-sign' ? 1 : 0)
  if (args[0] === 'verify') out(fail === 'signtool-verify' ? 1 : 0)
  out(2)
}
out(127)
