// Signature des binaires de barre système (#512). Le script app-tray/release/sign-tray.mjs signe et vérifie quand
// tous les secrets d'une plateforme sont là, étiquette le binaire « -unsigned » quand aucun n'est là, et échoue quand
// il en manque une partie ou quand une vérification échoue. Les vrais outils (codesign, notarytool, signtool) et les
// vrais certificats ne sont pas disponibles ici : des doublures (app-tray/test/fake-signing-tool.mjs) jouent leur rôle.
// Ces tests prouvent le comportement du script, pas que la signature réelle aboutit.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const ROOT = path.resolve(__dirname, '..')
const SCRIPT = path.join(ROOT, 'app-tray/release/sign-tray.mjs')
const FAKE = path.join(ROOT, 'app-tray/test/fake-signing-tool.mjs')

const MAC = {
  MACOS_CERTIFICATE_P12_BASE64: Buffer.from('p12-secret-bytes-7f3a').toString('base64'),
  MACOS_CERTIFICATE_PASSWORD: 'mac-cert-pass-91c2',
  MACOS_SIGNING_IDENTITY: 'Developer ID Application: Test (TEAM123456)',
  MACOS_NOTARY_APPLE_ID: 'notary-id-5be8@example.invalid',
  MACOS_NOTARY_TEAM_ID: 'TEAM123456',
  MACOS_NOTARY_PASSWORD: 'notary-pass-0d4e',
}
const WIN = {
  WINDOWS_CERTIFICATE_PFX_BASE64: Buffer.from('pfx-secret-bytes-a61b').toString('base64'),
  WINDOWS_CERTIFICATE_PASSWORD: 'win-cert-pass-c83f',
}
/** Values that must never reach the script's output (the identity and team id are public, not secrets). */
const SECRETS = [MAC.MACOS_CERTIFICATE_P12_BASE64, MAC.MACOS_CERTIFICATE_PASSWORD, MAC.MACOS_NOTARY_APPLE_ID,
  MAC.MACOS_NOTARY_PASSWORD, WIN.WINDOWS_CERTIFICATE_PFX_BASE64, WIN.WINDOWS_CERTIFICATE_PASSWORD,
  'p12-secret-bytes-7f3a', 'pfx-secret-bytes-a61b']

type Run = { code: number | null; stdout: string; stderr: string; out: string; log: { tool: string; args: string[] }[]; tmp: string }

function run(platform: string, env: Record<string, string>, extra: string[] = []): Run {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tray-sign-'))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  for (const tool of ['codesign', 'security', 'xcrun', 'ditto', 'signtool']) fs.symlinkSync(FAKE, path.join(bin, tool))
  fs.chmodSync(FAKE, 0o755)
  const built = path.join(dir, 'built-binary')
  fs.writeFileSync(built, 'fake tray binary\n')
  const out = path.join(dir, 'out')
  const tmp = path.join(dir, 'tmp')
  fs.mkdirSync(tmp)
  const logFile = path.join(dir, 'log.jsonl')
  const r = spawnSync(process.execPath, [SCRIPT, '--platform', platform, '--bin', built, '--out', out,
    '--name', 'agent-lens-tray-1.2.3-test', ...extra], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`, RUNNER_TEMP: tmp, FAKE_SIGN_LOG: logFile,
      SIGNTOOL: path.join(bin, 'signtool'), FAKE_SIGN_TEAM: MAC.MACOS_NOTARY_TEAM_ID, ...env,
    },
  })
  const log = fs.existsSync(logFile)
    ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, out, log, tmp }
}

const files = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [])
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function assertNoSecret(r: Run) {
  for (const s of SECRETS) {
    assert.ok(!r.stdout.includes(s) && !r.stderr.includes(s), `a secret value was printed:\n${r.stdout}\n${r.stderr}`)
  }
}

function assertChecksum(r: Run, file: string) {
  const line = fs.readFileSync(path.join(r.out, `${file}.sha256`), 'utf8')
  assert.equal(line, `${sha(path.join(r.out, file))}  ${file}\n`, 'sha256sum -c format, basename only')
}

test('linux is always labelled unsigned, with its SHA256, and no signing tool runs (#512)', () => {
  const r = run('linux', { ...MAC, ...WIN })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(files(r.out), ['agent-lens-tray-1.2.3-test-unsigned', 'agent-lens-tray-1.2.3-test-unsigned.sha256'])
  assertChecksum(r, 'agent-lens-tray-1.2.3-test-unsigned')
  assert.deepEqual(r.log, [])
  assert.match(r.stdout, /agent-lens-tray-1\.2\.3-test-unsigned: unsigned/)
  assert.doesNotMatch(r.stdout, /\bsigned and verified\b/)
})

test('without any secret, macOS and Windows binaries are labelled unsigned and the step succeeds (#512)', () => {
  const mac = run('darwin', {})
  assert.equal(mac.code, 0, mac.stderr)
  assert.deepEqual(files(mac.out), ['agent-lens-tray-1.2.3-test-unsigned', 'agent-lens-tray-1.2.3-test-unsigned.sha256'])
  assert.deepEqual(mac.log, [])
  const win = run('windows', { MACOS_CERTIFICATE_PASSWORD: '', WINDOWS_CERTIFICATE_PASSWORD: '' })
  assert.equal(win.code, 0, win.stderr)
  assert.deepEqual(files(win.out), ['agent-lens-tray-1.2.3-test-unsigned.exe', 'agent-lens-tray-1.2.3-test-unsigned.exe.sha256'])
  assertChecksum(win, 'agent-lens-tray-1.2.3-test-unsigned.exe')
  assert.deepEqual(win.log, [], 'an empty secret (what Actions passes for an unset one) counts as absent')
})

test('a partial set of secrets fails, names what is missing, writes nothing and runs no tool (#512)', () => {
  const { MACOS_NOTARY_PASSWORD: _n, ...partialMac } = MAC
  const mac = run('darwin', partialMac)
  assert.equal(mac.code, 1)
  assert.match(mac.stderr, /MACOS_NOTARY_PASSWORD/)
  assert.deepEqual(files(mac.out), [])
  assert.deepEqual(mac.log, [])
  assertNoSecret(mac)
  const win = run('windows', { WINDOWS_CERTIFICATE_PFX_BASE64: WIN.WINDOWS_CERTIFICATE_PFX_BASE64 })
  assert.equal(win.code, 1)
  assert.match(win.stderr, /WINDOWS_CERTIFICATE_PASSWORD/)
  assert.deepEqual(files(win.out), [])
  assertNoSecret(win)
})

test('macOS with every secret: signs with the hardened runtime, verifies, notarizes, cleans up (#512)', () => {
  const r = run('darwin', MAC)
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(files(r.out), ['agent-lens-tray-1.2.3-test', 'agent-lens-tray-1.2.3-test.sha256'])
  assertChecksum(r, 'agent-lens-tray-1.2.3-test')
  assert.match(r.stdout, /agent-lens-tray-1\.2\.3-test: signed and verified/)
  assertNoSecret(r)
  const target = path.join(r.out, 'agent-lens-tray-1.2.3-test')
  const sign = r.log.find(l => l.tool === 'codesign' && l.args.includes('--sign'))
  assert.ok(sign, 'codesign --sign ran')
  for (const a of ['--options', 'runtime', '--timestamp', MAC.MACOS_SIGNING_IDENTITY]) assert.ok(sign.args.includes(a), a)
  assert.equal(sign.args[sign.args.length - 1], target, 'the published copy is the one signed')
  const order = r.log.map(l => `${l.tool} ${l.args.find(a => /^(--sign|--verify|--display|submit|import|delete-keychain)$/.test(a)) ?? l.args[0]}`)
  const at = (s: string) => { const i = order.indexOf(s); assert.ok(i >= 0, `${s} ran: ${order.join(', ')}`); return i }
  assert.ok(at('security import') < at('codesign --sign'))
  assert.ok(at('codesign --sign') < at('codesign --verify'))
  assert.ok(at('codesign --verify') < at('codesign --display'))
  assert.ok(at('codesign --display') < at('xcrun submit'))
  assert.equal(order[order.length - 1], 'security delete-keychain', 'the temporary keychain is deleted last')
  const verify = r.log.find(l => l.tool === 'codesign' && l.args.includes('--verify'))!
  assert.ok(verify.args.includes('--strict'))
  const submit = r.log.find(l => l.tool === 'xcrun')!
  assert.ok(submit.args.includes('--wait') && submit.args.includes('json'))
  const imported = r.log.find(l => l.tool === 'security' && l.args[0] === 'import')!
  assert.ok(!fs.existsSync(imported.args[1]), 'the decoded certificate file is removed')
  assert.deepEqual(files(r.tmp), [], 'nothing left in RUNNER_TEMP')
})

for (const [fail, why] of [
  ['codesign-sign', 'codesign --sign fails'],
  ['codesign-verify', 'codesign --verify fails'],
  ['codesign-no-runtime', 'the signature lacks the hardened runtime'],
  ['codesign-wrong-team', 'the signature is from another team'],
  ['notary-invalid', 'notarization is not Accepted'],
  ['notary-exit', 'notarytool exits non-zero'],
  ['security-import', 'the certificate cannot be imported'],
] as const) {
  test(`macOS fails loudly, publishes nothing and keeps secrets out of the log when ${why} (#512)`, () => {
    const r = run('darwin', { ...MAC, FAKE_SIGN_FAIL: fail })
    assert.equal(r.code, 1, r.stdout)
    assert.deepEqual(files(r.out), [], 'no file is left that could be published')
    assert.doesNotMatch(r.stdout, /signed and verified/)
    assertNoSecret(r)
    assert.equal(r.log[r.log.length - 1].args[0], 'delete-keychain', 'the keychain is deleted on failure too')
    assert.deepEqual(files(r.tmp), [])
  })
}

test('Windows with every secret: signtool signs with SHA-256 and an RFC 3161 timestamp, then verifies (#512)', () => {
  const r = run('windows', WIN)
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(files(r.out), ['agent-lens-tray-1.2.3-test.exe', 'agent-lens-tray-1.2.3-test.exe.sha256'])
  assertChecksum(r, 'agent-lens-tray-1.2.3-test.exe')
  assertNoSecret(r)
  assert.deepEqual(r.log.map(l => l.args[0]), ['sign', 'verify'])
  const [sign, verify] = r.log
  for (const a of ['/fd', 'sha256', '/td', '/tr', '/f', '/p']) assert.ok(sign.args.includes(a), a)
  assert.ok(!fs.existsSync(sign.args[sign.args.indexOf('/f') + 1]), 'the decoded .pfx is removed')
  assert.deepEqual(verify.args.slice(0, 2), ['verify', '/pa'])
  assert.deepEqual(files(r.tmp), [])
})

for (const fail of ['signtool-sign', 'signtool-verify']) {
  test(`Windows fails loudly and publishes nothing when ${fail} fails (#512)`, () => {
    const r = run('windows', { ...WIN, FAKE_SIGN_FAIL: fail })
    assert.equal(r.code, 1)
    assert.deepEqual(files(r.out), [])
    assertNoSecret(r)
    assert.deepEqual(files(r.tmp), [])
  })
}

test('Windows without signtool fails instead of labelling the binary signed (#512)', () => {
  const r = run('windows', { ...WIN, SIGNTOOL: path.join(os.tmpdir(), 'no-such-signtool-512') })
  assert.equal(r.code, 1)
  assert.deepEqual(files(r.out), [])
})

test('a certificate secret that is not base64 fails before any tool runs (#512)', () => {
  const r = run('windows', { ...WIN, WINDOWS_CERTIFICATE_PFX_BASE64: '%%%' })
  assert.equal(r.code, 1)
  assert.deepEqual(r.log, [])
})

test('a certificate secret wrapped over several lines, as base64 prints it on Linux, is accepted (#512)', () => {
  const wrapped = (WIN.WINDOWS_CERTIFICATE_PFX_BASE64.match(/.{1,8}/g) ?? []).join('\n') + '\n'
  const r = run('windows', { ...WIN, WINDOWS_CERTIFICATE_PFX_BASE64: wrapped })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(r.log.map(l => l.args[0]), ['sign', 'verify'])
  assertNoSecret(r)
})

test('bad arguments exit 2 (#512)', () => {
  assert.equal(run('beos', {}).code, 2)
  assert.equal(run('linux', {}, ['--name', '../escape']).code, 2, 'the name is a plain file name')
})
