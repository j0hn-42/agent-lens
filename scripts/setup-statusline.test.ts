/**
 * Installation de la barre d'état enveloppe (#467) : mêmes garanties que configureHooks (settings.json illisible
 * jamais touché, CLAUDE_CONFIG_DIR respecté), plus réversibilité exacte. HOME est factice avant de charger setup.js.
 */
import { describe, it, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'al-setup-sl-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CLAUDE_CONFIG_DIR

// eslint-disable-next-line @typescript-eslint/no-require-imports
const setup = require('./setup.js') as {
  ensureSetup: () => void
  isAlreadySetup: () => boolean
  getStatuslineScriptContent: () => string
  configureStatusLine: (o?: { settingsPath?: string; statuslineCommand?: string }) => void
  restoreStatusLine: (o?: { settingsPath?: string }) => void
  SettingsUnreadableError: new (...a: never[]) => Error
}

const discoveryDir = path.join(fakeHome, '.claude', 'agent-lens')
const savedPath = path.join(discoveryDir, 'statusline-original.json')
const scriptPath = path.join(discoveryDir, 'statusline.js')
const WRAPPER = '"node" "/h/.claude/agent-lens/statusline.js"'
const USER_LINE = { type: 'command', command: 'bash ~/.claude/my-bar.sh', padding: 2 }

const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf-8'))

describe('setup.js configureStatusLine / restoreStatusLine', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR
    fs.rmSync(path.join(fakeHome, '.claude'), { recursive: true, force: true })
    dir = fs.mkdtempSync(path.join(fakeHome, 'case-'))
    file = path.join(dir, 'settings.json')
  })

  it('sans statusLine : pose l\'enveloppe, enregistre "aucune" et restaure en retirant la clé', () => {
    const original = JSON.stringify({ model: 'opus' }, null, 2) + '\n'
    fs.writeFileSync(file, original)
    setup.configureStatusLine({ settingsPath: file, statuslineCommand: WRAPPER })
    assert.deepEqual(read(file), { model: 'opus', statusLine: { type: 'command', command: WRAPPER } })
    assert.deepEqual(read(savedPath), { command: null, original: null })

    setup.restoreStatusLine({ settingsPath: file })
    assert.deepEqual(read(file), { model: 'opus' })
    assert.equal('statusLine' in read(file), false)
  })

  it('avec une statusLine utilisateur : l\'enregistre en entier et la restaure à l\'identique (clés en plus comprises)', () => {
    fs.writeFileSync(file, JSON.stringify({ a: 1, statusLine: USER_LINE, z: 2 }))
    setup.configureStatusLine({ settingsPath: file, statuslineCommand: WRAPPER })
    assert.deepEqual(read(file).statusLine, { type: 'command', command: WRAPPER, padding: 2 })
    assert.deepEqual(read(savedPath), { command: USER_LINE.command, original: USER_LINE })

    setup.restoreStatusLine({ settingsPath: file })
    assert.deepEqual(read(file), { a: 1, statusLine: USER_LINE, z: 2 })
    assert.deepEqual(Object.keys(read(file)), ['a', 'statusLine', 'z'])
  })

  it('idempotent : une statusLine déjà posée par Agent Lens n\'est pas enveloppée deux fois', () => {
    fs.writeFileSync(file, JSON.stringify({ statusLine: USER_LINE }))
    setup.configureStatusLine({ settingsPath: file, statuslineCommand: WRAPPER })
    const saved = fs.readFileSync(savedPath, 'utf-8')
    const written = fs.readFileSync(file, 'utf-8')
    setup.configureStatusLine({ settingsPath: file, statuslineCommand: WRAPPER })
    assert.equal(fs.readFileSync(savedPath, 'utf-8'), saved)
    assert.equal(fs.readFileSync(file, 'utf-8'), written)
    assert.equal(read(savedPath).command, USER_LINE.command)

    setup.restoreStatusLine({ settingsPath: file })
    assert.deepEqual(read(file).statusLine, USER_LINE)
  })

  it('une enveloppe d\'un autre chemin d\'installation n\'écrase pas non plus l\'original', () => {
    fs.writeFileSync(file, JSON.stringify({ statusLine: USER_LINE }))
    setup.configureStatusLine({ settingsPath: file, statuslineCommand: WRAPPER })
    setup.configureStatusLine({ settingsPath: file, statuslineCommand: '"/usr/bin/node" "/other/.claude/agent-lens/statusline.js"' })
    assert.equal(read(savedPath).command, USER_LINE.command)
    assert.match(read(file).statusLine.command, /\/other\//)
  })

  it('une statusLine qui n\'est pas une commande est laissée telle quelle', () => {
    const odd = { type: 'something', value: 1 }
    fs.writeFileSync(file, JSON.stringify({ statusLine: odd }))
    setup.configureStatusLine({ settingsPath: file, statuslineCommand: WRAPPER })
    assert.deepEqual(read(file).statusLine, odd)
    assert.equal(fs.existsSync(savedPath), false)
  })

  it('restore ne touche pas une statusLine que l\'utilisateur a changée depuis', () => {
    fs.writeFileSync(file, JSON.stringify({ statusLine: USER_LINE }))
    setup.configureStatusLine({ settingsPath: file, statuslineCommand: WRAPPER })
    const changed = { type: 'command', command: 'echo neuf' }
    fs.writeFileSync(file, JSON.stringify({ statusLine: changed }))
    setup.restoreStatusLine({ settingsPath: file })
    assert.deepEqual(read(file).statusLine, changed)
  })

  it('restore sans rien d\'enregistré : ne fait rien', () => {
    fs.writeFileSync(file, JSON.stringify({ statusLine: USER_LINE }))
    setup.restoreStatusLine({ settingsPath: file })
    assert.deepEqual(read(file).statusLine, USER_LINE)
  })

  for (const [label, content] of [
    ['un commentaire', '{\n // c\n "statusLine": {"type":"command","command":"x"}\n}'],
    ['un fichier vide', ''],
    ['un fichier tronqué', '{ "statusLine": { "type": '],
  ] as const) {
    it(`refuse et laisse intact un fichier avec ${label}`, () => {
      fs.writeFileSync(file, content)
      assert.throws(() => setup.configureStatusLine({ settingsPath: file, statuslineCommand: WRAPPER }), (e: Error) => e instanceof setup.SettingsUnreadableError)
      assert.equal(fs.readFileSync(file, 'utf-8'), content)
      assert.deepEqual(fs.readdirSync(dir), ['settings.json'])
      assert.equal(fs.existsSync(savedPath), false)
    })
  }

  it('le refus ne remplace pas l\'original déjà enregistré', () => {
    fs.writeFileSync(file, JSON.stringify({ statusLine: USER_LINE }))
    setup.configureStatusLine({ settingsPath: file, statuslineCommand: WRAPPER })
    const saved = fs.readFileSync(savedPath, 'utf-8')
    const broken = path.join(dir, 'broken.json')
    fs.writeFileSync(broken, '{ nope')
    assert.throws(() => setup.configureStatusLine({ settingsPath: broken, statuslineCommand: WRAPPER }))
    assert.equal(fs.readFileSync(savedPath, 'utf-8'), saved)
  })
})

describe('setup.js ensureSetup et la barre d\'état', () => {
  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR
    fs.rmSync(path.join(fakeHome, '.claude'), { recursive: true, force: true })
  })

  it('installe statusline.js, pose l\'enveloppe et conserve la barre existante', () => {
    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true })
    const settings = path.join(fakeHome, '.claude', 'settings.json')
    fs.writeFileSync(settings, JSON.stringify({ statusLine: USER_LINE }))
    setup.ensureSetup()
    assert.equal(fs.readFileSync(scriptPath, 'utf8'), setup.getStatuslineScriptContent())
    const line = read(settings).statusLine
    assert.match(line.command, /agent-lens[\\/]statusline\.js/)
    assert.equal(read(savedPath).command, USER_LINE.command)
    assert.equal(setup.isAlreadySetup(), true)
    setup.ensureSetup()
    assert.equal(read(savedPath).command, USER_LINE.command)
  })

  it('statusline.js périmé ou statusLine retirée : plus "installé", ensureSetup répare', () => {
    setup.ensureSetup()
    const settings = path.join(fakeHome, '.claude', 'settings.json')
    fs.writeFileSync(scriptPath, '// ancien')
    assert.equal(setup.isAlreadySetup(), false)
    setup.ensureSetup()
    assert.equal(setup.isAlreadySetup(), true)

    const s = read(settings)
    delete s.statusLine
    fs.writeFileSync(settings, JSON.stringify(s))
    assert.equal(setup.isAlreadySetup(), false)
    setup.ensureSetup()
    assert.equal(setup.isAlreadySetup(), true)
  })
})

describe('setup.js statusLine avec CLAUDE_CONFIG_DIR', () => {
  after(() => {
    delete process.env.CLAUDE_CONFIG_DIR
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('écrit le settings.json du second compte, jamais ~/.claude, et ne lève pas sur un fichier illisible', () => {
    fs.rmSync(path.join(fakeHome, '.claude'), { recursive: true, force: true })
    const second = path.join(fakeHome, 'second-account')
    fs.mkdirSync(second)
    process.env.CLAUDE_CONFIG_DIR = second

    fs.writeFileSync(path.join(second, 'settings.json'), '{ nope')
    setup.ensureSetup()
    assert.equal(fs.readFileSync(path.join(second, 'settings.json'), 'utf-8'), '{ nope')
    assert.equal(setup.isAlreadySetup(), false)

    fs.writeFileSync(path.join(second, 'settings.json'), JSON.stringify({ statusLine: USER_LINE }))
    setup.ensureSetup()
    assert.match(read(path.join(second, 'settings.json')).statusLine.command, /statusline\.js/)
    assert.equal(fs.existsSync(path.join(fakeHome, '.claude', 'settings.json')), false)
    assert.equal(setup.isAlreadySetup(), true)

    setup.restoreStatusLine()
    assert.deepEqual(read(path.join(second, 'settings.json')).statusLine, USER_LINE)
  })
})
