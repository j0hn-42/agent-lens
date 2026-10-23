#!/usr/bin/env node
// Signs, verifies and labels one native tray binary for a release (#512). Node standard library only, no dependency,
// so it runs on the macOS and Windows runners without `pnpm install`.
//
//   node app-tray/release/sign-tray.mjs --platform <darwin|windows|linux> --bin <built binary> --out <dir> --name <base>
//
// Writes <out>/<base>[-unsigned][.exe] and <out>/<that file>.sha256 (the `sha256sum -c` format). The secrets of the
// platform come from the environment (an empty value counts as absent, which is what Actions passes for an unset
// secret):
//   - none of them: the copy is named `-unsigned`, nothing runs, exit 0;
//   - some but not all: exit 1, naming the missing ones (never a value), nothing written;
//   - all of them: sign, then verify; any failure exits 1 and removes the copy, so no file can be published as signed.
// Linux has no signing: its binary is always `-unsigned`. The output of the tools is printed only on failure, with
// every secret value replaced by ***.
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PREFIX = 'agent-lens-tray-sign:'
const SECRETS = {
  darwin: ['MACOS_CERTIFICATE_P12_BASE64', 'MACOS_CERTIFICATE_PASSWORD', 'MACOS_SIGNING_IDENTITY',
    'MACOS_NOTARY_APPLE_ID', 'MACOS_NOTARY_TEAM_ID', 'MACOS_NOTARY_PASSWORD'],
  windows: ['WINDOWS_CERTIFICATE_PFX_BASE64', 'WINDOWS_CERTIFICATE_PASSWORD'],
  linux: [],
}
/** RFC 3161 timestamp server for signtool: the signature stays valid after the certificate expires. */
const TIMESTAMP_URL = 'http://timestamp.digicert.com'

class Failure extends Error {}

function usage(msg) {
  process.stderr.write(`${PREFIX} ${msg}\nusage: sign-tray.mjs --platform <darwin|windows|linux> --bin <file> --out <dir> --name <base>\n`)
  process.exit(2)
}

function parseArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (!['--platform', '--bin', '--out', '--name'].includes(key) || value === undefined) usage(`bad argument ${JSON.stringify(key)}`)
    opts[key.slice(2)] = value
  }
  if (!Object.hasOwn(SECRETS, opts.platform ?? '')) usage('--platform must be darwin, windows or linux')
  if (!opts.bin || !opts.out) usage('--bin and --out are required')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(opts.name ?? '')) usage('--name must be a plain file name')
  return opts
}

const secretValues = []
function redact(text) {
  let out = text
  for (const v of secretValues) if (v) out = out.split(v).join('***')
  return out
}

function fail(msg, child) {
  process.stderr.write(`${PREFIX} ${msg}\n`)
  if (child) {
    const detail = `${child.stdout ?? ''}${child.stderr ?? ''}`.trim()
    if (detail) process.stderr.write(redact(detail) + '\n')
  }
  throw new Failure(msg)
}

/** Runs a tool with an argument array (no shell). A non-zero exit or a missing tool fails with `what`. */
function run(cmd, args, what) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.error) fail(`${what}: cannot run ${path.basename(cmd)} (${r.error.code ?? 'error'})`)
  if (r.status !== 0) fail(`${what}: ${path.basename(cmd)} exited ${r.status ?? r.signal}`, r)
  return r
}

/** Decodes a base64 secret into a 0600 file, or fails without running anything. */
function writeDecoded(name, value, file) {
  const clean = value.replace(/\s+/g, '')
  const bytes = /^[A-Za-z0-9+/]+={0,2}$/.test(clean) ? Buffer.from(clean, 'base64') : Buffer.alloc(0)
  if (bytes.length === 0) fail(`${name} is not valid base64`)
  secretValues.push(bytes.toString('latin1'))
  fs.writeFileSync(file, bytes, { mode: 0o600 })
}

function signDarwin(env, target, tmp) {
  const p12 = path.join(tmp, 'certificate.p12')
  writeDecoded('MACOS_CERTIFICATE_P12_BASE64', env.MACOS_CERTIFICATE_P12_BASE64, p12)
  const keychain = path.join(tmp, 'agent-lens-signing.keychain-db')
  const kcPass = crypto.randomBytes(24).toString('hex')
  secretValues.push(kcPass)
  let created = false
  try {
    run('security', ['create-keychain', '-p', kcPass, keychain], 'create the temporary keychain')
    created = true
    run('security', ['set-keychain-settings', '-lut', '21600', keychain], 'set the keychain timeout')
    run('security', ['unlock-keychain', '-p', kcPass, keychain], 'unlock the keychain')
    run('security', ['import', p12, '-k', keychain, '-P', env.MACOS_CERTIFICATE_PASSWORD, '-f', 'pkcs12', '-T', '/usr/bin/codesign'],
      'import the certificate')
    fs.rmSync(p12, { force: true })
    run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', kcPass, keychain],
      'allow codesign to use the key')
    run('security', ['list-keychains', '-d', 'user', '-s', keychain], 'add the keychain to the search list')

    run('codesign', ['--force', '--sign', env.MACOS_SIGNING_IDENTITY, '--options', 'runtime', '--timestamp',
      '--keychain', keychain, target], 'codesign')
    run('codesign', ['--verify', '--strict', '--verbose=2', target], 'codesign --verify')
    const shown = run('codesign', ['--display', '--verbose=2', target], 'codesign --display')
    const info = `${shown.stdout}\n${shown.stderr}`
    if (!/^CodeDirectory .*\bflags=0x[0-9a-f]+\([^)]*\bruntime\b[^)]*\)/m.test(info)) {
      fail('the signature does not carry the hardened runtime, which notarization requires')
    }
    const team = info.match(/^TeamIdentifier=(.*)$/m)?.[1]
    if (team !== env.MACOS_NOTARY_TEAM_ID) fail('the signing team is not MACOS_NOTARY_TEAM_ID')

    // A bare Mach-O binary cannot be submitted or stapled as is: it goes in a zip; the ticket stays on Apple's side
    const zip = path.join(tmp, 'notarize.zip')
    run('ditto', ['-c', '-k', '--keepParent', target, zip], 'zip for notarization')
    const sub = run('xcrun', ['notarytool', 'submit', zip, '--apple-id', env.MACOS_NOTARY_APPLE_ID,
      '--team-id', env.MACOS_NOTARY_TEAM_ID, '--password', env.MACOS_NOTARY_PASSWORD, '--wait', '--output-format', 'json'],
    'notarytool submit')
    let status
    try { status = JSON.parse(sub.stdout).status } catch { fail('notarytool did not answer JSON', sub) }
    if (status !== 'Accepted') fail(`notarization status is ${JSON.stringify(String(status))}, not "Accepted"`, sub)
    return `signed and verified (codesign --verify --strict, hardened runtime, team ${env.MACOS_NOTARY_TEAM_ID}; notarization Accepted, not stapled)`
  } finally {
    if (created) spawnSync('security', ['delete-keychain', keychain], { stdio: 'ignore' })
  }
}

/** signtool from SIGNTOOL, or the newest x64 one of the Windows 10/11 SDK. */
function findSigntool(env) {
  if (env.SIGNTOOL) {
    if (!fs.existsSync(env.SIGNTOOL)) fail('SIGNTOOL does not exist')
    return env.SIGNTOOL
  }
  const kits = path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin')
  const versions = fs.existsSync(kits) ? fs.readdirSync(kits).filter(v => /^10\.[\d.]+$/.test(v)) : []
  versions.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
  for (const v of versions) {
    const candidate = path.join(kits, v, 'x64', 'signtool.exe')
    if (fs.existsSync(candidate)) return candidate
  }
  fail('signtool.exe not found in the Windows SDK')
}

function signWindows(env, target, tmp) {
  const signtool = findSigntool(env)
  const pfx = path.join(tmp, 'certificate.pfx')
  writeDecoded('WINDOWS_CERTIFICATE_PFX_BASE64', env.WINDOWS_CERTIFICATE_PFX_BASE64, pfx)
  run(signtool, ['sign', '/fd', 'sha256', '/td', 'sha256', '/tr', TIMESTAMP_URL, '/f', pfx, '/p',
    env.WINDOWS_CERTIFICATE_PASSWORD, target], 'signtool sign')
  fs.rmSync(pfx, { force: true })
  run(signtool, ['verify', '/pa', '/v', target], 'signtool verify')
  return 'signed and verified (signtool verify /pa, RFC 3161 timestamp)'
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const env = process.env
  const names = SECRETS[opts.platform]
  for (const n of names) if (env[n]) secretValues.push(env[n])
  const present = names.filter(n => env[n])
  const missing = names.filter(n => !env[n])
  if (present.length > 0 && missing.length > 0) {
    process.stderr.write(`${PREFIX} some ${opts.platform} signing secrets are set but not these: ${missing.join(', ')}. ` +
      'Set all of them to sign, or none to publish an unsigned binary.\n')
    return 1
  }
  const signing = names.length > 0 && missing.length === 0
  const ext = opts.platform === 'windows' ? '.exe' : ''
  const file = `${opts.name}${signing ? '' : '-unsigned'}${ext}`
  fs.mkdirSync(opts.out, { recursive: true })
  const target = path.join(opts.out, file)
  const sum = `${target}.sha256`
  const tmp = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'tray-sign-'))
  try {
    fs.copyFileSync(opts.bin, target)
    let status = opts.platform === 'linux' ? 'unsigned (Linux binaries are not signed)'
      : `unsigned (no ${opts.platform} signing secrets)`
    if (signing) status = opts.platform === 'darwin' ? signDarwin(env, target, tmp) : signWindows(env, target, tmp)
    const hex = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')
    fs.writeFileSync(sum, `${hex}  ${file}\n`)
    process.stdout.write(`${PREFIX} ${file}: ${status}\n${PREFIX} ${file}: sha256 ${hex}\n`)
    return 0
  } catch (err) {
    fs.rmSync(target, { force: true })
    fs.rmSync(sum, { force: true })
    if (!(err instanceof Failure)) process.stderr.write(`${PREFIX} ${file}: unexpected error (${err?.code ?? 'error'})\n`)
    process.stderr.write(`${PREFIX} ${file}: not published\n`)
    return 1
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

process.exit(main())
