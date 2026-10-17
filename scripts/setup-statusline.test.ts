/**
 * Installation de la barre d'état enveloppe (#467), sur demande explicite (`--statusline`) : mêmes garanties que
 * configureHooks (settings.json illisible jamais touché, CLAUDE_CONFIG_DIR respecté), plus réversibilité exacte.
 * La statusLine d'origine voyage dans la commande elle-même (base64url) : aucun état hors de settings.json.
 * HOME est factice avant de charger setup.js.
 */
import { describe, it, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PassThrough } from 'node:stream'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'al-setup-sl-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CLAUDE_CONFIG_DIR

interface CliOptions { argv: string[]; stdin: NodeJS.ReadableStream; stdout: { write: (s: string) => unknown }; isTTY: boolean; settingsPath?: string }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const setup = require('./setup.js') as {
  ensureSetup: () => void
  isAlreadySetup: () => boolean
  getStatuslineScriptContent: () => string
  configureStatusLine: (o?: { settingsPath?: string; statuslineCommand?: string }) => void
  restoreStatusLine: (o?: { settingsPath?: string }) => void
  runStatuslineCli: (o: CliOptions) => Promise<number>
  SettingsUnreadableError: new (...a: never[]) => Error
}

const discoveryDir = path.join(fakeHome, '.claude', 'agent-lens')
const scriptPath = path.join(discoveryDir, 'statusline.js')
const BASE = '"node" "/h/.claude/agent-lens/statusline.js"'
const USER_LINE = { type: 'command', command: 'bash ~/.claude/my-bar.sh', padding: 2 }

const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf-8'))
const decodeArg = (command: string) => JSON.parse(Buffer.from(command.split(' ').pop() as string, 'base64url').toString('utf8'))

describe('setup.js configureStatusLine / restoreStatusLine', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR
    fs.rmSync(path.join(fakeHome, '.claude'), { recursive: true, force: true })
    dir = fs.mkdtempSync(path.join(fakeHome, 'case-'))
    file = path.join(dir, 'settings.json')
  })

  it('sans statusLine : pose l\'enveloppe avec l\'argument "null" et restaure en retirant la clé', () => {
    fs.writeFileSync(file, JSON.stringify({ model: 'opus' }, null, 2) + '\n')
    setup.configureStatusLine({ settingsPath: file, statuslineCommand: BASE })
    const line = read(file).statusLine
    assert.equal(line.type, 'command')
    assert.ok(line.command.startsWith(BASE + ' '))
    assert.match(line.command.slice(BASE.length + 1), /^[A-Za-z0-9_-]+$/)
    assert.equal(decodeArg(line.command), null)

    setup.restoreStatusLine({ settingsPath: file })
    assert.deepEqual(read(file), { model: 'opus' })
  })

  it('avec une statusLine utilisateur : l\'encode en entier et la restaure à l\'identique (clés en plus, ordre)', () => {
    fs.writeFileSync(file, JSON.stringify({ a: 1, statusLine: USER_LINE, z: 2 }))
    setup.configureStatusLine({ settingsPath: file, statuslineCommand: BASE })
    const line = read(file).statusLine
    assert.equal(line.padding, 2)
    assert.deepEqual(decodeArg(line.command), USER_LINE)

    setup.restoreStatusLine({ settingsPath: file })
    assert.deepEqual(read(file), { a: 1, statusLine: USER_LINE, z: 2 })
    assert.deepEqual(Object.keys(read(file)), ['a', 'statusLine', 'z'])
  })

  it('aucun fichier d\'état hors de settings.json (seul le chemin des réglages est enregistré)', () => {
    fs.writeFileSync(file, JSON.stringify({ statusLine: USER_LINE }))
    setup.configureStatusLine({ settingsPath: file, statuslineCommand: BASE })
    const names = fs.existsSync(discoveryDir) ? fs.readdirSync(discoveryDir) : []
    assert.equal(names.includes('statusline-original.json'), false)
    // survit à la suppression du dossier agent-lens
    fs.rmSync(discoveryDir, { recursive: true, force: true })
    setup.restoreStatusLine({ settingsPath: file })
    assert.deepEqual(read(file).statusLine, USER_LINE)
  })

  it('idempotent : une statusLine déjà posée par Agent Lens n\'est ni ré-enveloppée ni ré-enregistrée', () => {
    fs.writeFileSync(file, JSON.stringify({ statusLine: USER_LINE }))
    setup.configureStatusLine({ settingsPath: file, statuslineCommand: BASE })
    const written = fs.readFileSync(file, 'utf-8')
    setup.configureStatusLine({ settingsPath: file, statuslineCommand: BASE })
    assert.equal(fs.readFileSync(file, 'utf-8'), written)
    setup.restoreStatusLine({ settingsPath: file })
    assert.deepEqual(read(file).statusLine, USER_LINE)
  })

  it('une enveloppe d\'un autre chemin d\'installation est migrée en gardant l\'original', () => {
    fs.writeFileSync(file, JSON.stringify({ statusLine: USER_LINE }))
    setup.configureStatusLine({ settingsPath: file, statuslineCommand: BASE })
    setup.configureStatusLine({ settingsPath: file, statuslineCommand: '"/usr/bin/node" "/other/.claude/agent-lens/statusline.js"' })
    assert.match(read(file).statusLine.command, /\/other\//)
    setup.restoreStatusLine({ settingsPath: file })
    assert.deepEqual(read(file).statusLine, USER_LINE)
  })

  it('une statusLine qui n\'est pas une commande est laissée telle quelle', () => {
    const odd = { type: 'something', value: 1 }
    fs.writeFileSync(file, JSON.stringify({ statusLine: odd }))
    setup.configureStatusLine({ settingsPath: file, statuslineCommand: BASE })
    assert.deepEqual(read(file).statusLine, odd)
  })

  it('restore ne touche pas une statusLine que l\'utilisateur a changée depuis', () => {
    fs.writeFileSync(file, JSON.stringify({ statusLine: USER_LINE }))
    setup.configureStatusLine({ settingsPath: file, statuslineCommand: BASE })
    const changed = { type: 'command', command: 'echo neuf' }
    fs.writeFileSync(file, JSON.stringify({ statusLine: changed }))
    setup.restoreStatusLine({ settingsPath: file })
    assert.deepEqual(read(file).statusLine, changed)
  })

  it('restore sans enveloppe : ne fait rien', () => {
    fs.writeFileSync(file, JSON.stringify({ statusLine: USER_LINE }))
    setup.restoreStatusLine({ settingsPath: file })
    assert.deepEqual(read(file).statusLine, USER_LINE)
  })

  for (const [label, arg] of [
    ['absent', ''],
    ['base64 corrompu', ' !!!'],
    ['JSON corrompu', ' ' + Buffer.from('{ nope').toString('base64url')],
  ] as const) {
    it(`restore avec un argument ${label} : erreur explicite, settings.json intact`, () => {
      const content = JSON.stringify({ model: 'x', statusLine: { type: 'command', command: BASE + arg } })
      fs.writeFileSync(file, content)
      assert.throws(() => setup.restoreStatusLine({ settingsPath: file }), /statusLine/)
      assert.equal(fs.readFileSync(file, 'utf-8'), content)
    })
  }

  for (const [label, content] of [
    ['un commentaire', '{\n // c\n "statusLine": {"type":"command","command":"x"}\n}'],
    ['un fichier vide', ''],
    ['un fichier tronqué', '{ "statusLine": { "type": '],
  ] as const) {
    it(`refuse et laisse intact un fichier avec ${label}`, () => {
      fs.writeFileSync(file, content)
      assert.throws(() => setup.configureStatusLine({ settingsPath: file, statuslineCommand: BASE }), (e: Error) => e instanceof setup.SettingsUnreadableError)
      assert.equal(fs.readFileSync(file, 'utf-8'), content)
      assert.deepEqual(fs.readdirSync(dir), ['settings.json'])
      assert.throws(() => setup.restoreStatusLine({ settingsPath: file }), (e: Error) => e instanceof setup.SettingsUnreadableError)
      assert.equal(fs.readFileSync(file, 'utf-8'), content)
    })
  }
})

describe('setup.js : ensureSetup et isAlreadySetup ne touchent pas à la barre d\'état (opt-in)', () => {
  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR
    fs.rmSync(path.join(fakeHome, '.claude'), { recursive: true, force: true })
  })

  it('ensureSetup laisse la statusLine de l\'utilisateur et n\'installe pas statusline.js', () => {
    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true })
    const settings = path.join(fakeHome, '.claude', 'settings.json')
    fs.writeFileSync(settings, JSON.stringify({ statusLine: USER_LINE }))
    setup.ensureSetup()
    assert.deepEqual(read(settings).statusLine, USER_LINE)
    assert.equal(fs.existsSync(scriptPath), false)
    assert.equal(setup.isAlreadySetup(), true)
  })
})

describe('setup.js --statusline / --restore-statusline', () => {
  let settings: string
  let out: string
  const run = async (argv: string[], answer: string | null, isTTY = true) => {
    const stdin = new PassThrough()
    if (answer !== null) stdin.end(answer)
    out = ''
    const code = await setup.runStatuslineCli({ argv, stdin, stdout: { write: s => (out += s) }, isTTY })
    return code
  }
  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR
    fs.rmSync(path.join(fakeHome, '.claude'), { recursive: true, force: true })
    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true })
    settings = path.join(fakeHome, '.claude', 'settings.json')
    fs.writeFileSync(settings, JSON.stringify({ statusLine: USER_LINE }, null, 2))
  })

  it('refuse par défaut : réponse vide ou "n", settings.json octet pour octet inchangé, rien installé', async () => {
    const before = fs.readFileSync(settings)
    for (const answer of ['\n', 'n\n', 'peut-être\n']) {
      assert.equal(await run(['--statusline'], answer), 0)
      assert.deepEqual(fs.readFileSync(settings), before)
      assert.equal(fs.existsSync(scriptPath), false)
    }
  })

  it('affiche la statusLine actuelle et la nouvelle avant de demander', async () => {
    await run(['--statusline'], '\n')
    assert.match(out, /bash ~\/\.claude\/my-bar\.sh/)
    assert.match(out, /statusline\.js/)
    assert.match(out, /y\/N/)
  })

  it('accepte "y" : installe le script et pose l\'enveloppe', async () => {
    assert.equal(await run(['--statusline'], 'y\n'), 0)
    assert.equal(fs.readFileSync(scriptPath, 'utf8'), setup.getStatuslineScriptContent())
    const line = read(settings).statusLine
    assert.match(line.command, /agent-lens[\\/]statusline\.js/)
    assert.deepEqual(decodeArg(line.command), USER_LINE)
  })

  it('--yes passe la question, même sans TTY', async () => {
    assert.equal(await run(['--statusline', '--yes'], null, false), 0)
    assert.match(read(settings).statusLine.command, /statusline\.js/)
  })

  it('sans TTY et sans --yes : refuse avec un message, fichier inchangé', async () => {
    const before = fs.readFileSync(settings)
    assert.equal(await run(['--statusline'], 'y\n', false), 1)
    assert.match(out, /--yes/)
    assert.deepEqual(fs.readFileSync(settings), before)
  })

  it('--restore-statusline remet l\'original et le dit', async () => {
    await run(['--statusline', '--yes'], null)
    assert.equal(await run(['--restore-statusline'], null), 0)
    assert.deepEqual(read(settings).statusLine, USER_LINE)
    assert.match(out, /bash ~\/\.claude\/my-bar\.sh/)
  })

  it('--restore-statusline sur un argument corrompu : code 1, message, fichier intact', async () => {
    const content = JSON.stringify({ statusLine: { type: 'command', command: BASE + ' !!!' } })
    fs.writeFileSync(settings, content)
    assert.equal(await run(['--restore-statusline'], null), 1)
    assert.equal(fs.readFileSync(settings, 'utf-8'), content)
  })

  it('--statusline sur un settings.json illisible : code 1, fichier intact', async () => {
    fs.writeFileSync(settings, '{ nope')
    assert.equal(await run(['--statusline', '--yes'], null), 1)
    assert.equal(fs.readFileSync(settings, 'utf-8'), '{ nope')
  })
})

describe('setup.js statusLine avec CLAUDE_CONFIG_DIR : deux comptes', () => {
  after(() => {
    delete process.env.CLAUDE_CONFIG_DIR
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('chaque compte se restaure à l\'identique, sans influencer l\'autre', () => {
    fs.rmSync(path.join(fakeHome, '.claude'), { recursive: true, force: true })
    const a = path.join(fakeHome, 'acct-a')
    const b = path.join(fakeHome, 'acct-b')
    fs.mkdirSync(a)
    fs.mkdirSync(b)
    const lineA = { type: 'command', command: 'echo A', padding: 1 }
    const lineB = { type: 'command', command: 'bash b.sh' }
    fs.writeFileSync(path.join(a, 'settings.json'), JSON.stringify({ statusLine: lineA }))
    fs.writeFileSync(path.join(b, 'settings.json'), JSON.stringify({ statusLine: lineB }))

    process.env.CLAUDE_CONFIG_DIR = a
    setup.configureStatusLine({ statuslineCommand: BASE })
    process.env.CLAUDE_CONFIG_DIR = b
    setup.configureStatusLine({ statuslineCommand: BASE })

    // restaurer B ne change pas A, et inversement
    setup.restoreStatusLine()
    assert.deepEqual(read(path.join(b, 'settings.json')).statusLine, lineB)
    assert.match(read(path.join(a, 'settings.json')).statusLine.command, /statusline\.js/)
    process.env.CLAUDE_CONFIG_DIR = a
    setup.restoreStatusLine()
    assert.deepEqual(read(path.join(a, 'settings.json')).statusLine, lineA)
    assert.equal(fs.existsSync(path.join(fakeHome, '.claude', 'settings.json')), false)
  })

  it('un settings.json illisible du compte courant n\'est pas touché', () => {
    const c = path.join(fakeHome, 'acct-c')
    fs.mkdirSync(c)
    process.env.CLAUDE_CONFIG_DIR = c
    fs.writeFileSync(path.join(c, 'settings.json'), '{ nope')
    assert.throws(() => setup.configureStatusLine({ statuslineCommand: BASE }), (e: Error) => e instanceof setup.SettingsUnreadableError)
    assert.equal(fs.readFileSync(path.join(c, 'settings.json'), 'utf-8'), '{ nope')
  })
})
