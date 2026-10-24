// #247: message catalog, French first. Pure logic, node:test.
import './all-locales' // #662: both languages are loaded before the tests
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { LOCALES, DEFAULT_LOCALE, MESSAGES, resolveLocale, translate, type Locale, type MessageKey } from '../web/lib/messages'
import { MESSAGE_DOMAINS } from '../web/lib/messages/domains'

test('French comes first in the catalog', () => {
  assert.deepEqual([...LOCALES], ['fr', 'en'])
})

test('every locale has exactly the same keys, none empty', () => {
  const ref = Object.keys(MESSAGES.fr).sort()
  for (const l of LOCALES) {
    assert.deepEqual(Object.keys(MESSAGES[l]).sort(), ref, `keys of ${l}`)
    for (const k of ref) assert.ok(MESSAGES[l][k as MessageKey].trim().length > 0, `${l}.${k}`)
  }
})

test('every locale keeps the same {placeholders} as French', () => {
  const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join()
  for (const k of Object.keys(MESSAGES.fr) as MessageKey[]) {
    for (const l of LOCALES) assert.equal(ph(MESSAGES[l][k]), ph(MESSAGES.fr[k]), `${l}.${k}`)
  }
})

test('locale resolution: stored choice, then browser languages, then the default', () => {
  assert.equal(resolveLocale('en', ['fr-FR']), 'en')
  assert.equal(resolveLocale(null, ['de-DE', 'fr-CA', 'en']), 'fr')
  assert.equal(resolveLocale(null, ['en-US']), 'en')
  assert.equal(resolveLocale(null, ['de']), DEFAULT_LOCALE)
  assert.equal(resolveLocale('xx', []), DEFAULT_LOCALE)
  assert.equal(resolveLocale('__proto__', undefined), DEFAULT_LOCALE)
})

test('translate fills placeholders and falls back to the default locale for an unknown one', () => {
  assert.equal(translate('en', 'motion.layer.background'), MESSAGES.en['motion.layer.background'])
  assert.match(translate('fr', 'motion.calmCount', { n: 2 }), /2/)
  assert.equal(translate('xx' as never, 'motion.layer.agents'), MESSAGES[DEFAULT_LOCALE]['motion.layer.agents'])
})

// Step 2: the catalog covers the canvas controls and the settings dialog
// units and a word that is the same in both languages
const SAME_IN_BOTH = new Set<string>(['controls.seconds', 'controls.minutes', 'controls.zoomGroup', 'settings.section.notifications', 'settings.language.fr', 'settings.language.en', 'permission.rowTitle', 'permission.session', 'permission.withSubject', 'permission.actionNameShort', 'permission.deadlineMin', 'permission.deadlineSec', 'topbar.notify', 'quota.window.fiveHour', 'count.agent.one', 'count.agent.other', 'legend.disc-code', 'topbar.panel.conversation.name', 'topbar.panel.conversation.tooltip', 'cols.runtime', 'cols.runtime.value', 'sessions.role.agent', 'topbar.counts.sessions.one', 'topbar.counts.sessions.other', 'conv.count.one', 'conv.count.other', 'conv.count.search.one', 'conv.count.search.other', 'conv.pair.second', 'conv.team.sessionHint', 'conv.hier.agent', 'conv.comm.message', 'conv.row.sessionTitle', 'conv.picker.group.session', 'conv.picker.group.workflow', 'ctx.issues.heading', 'cap.plugin', 'sw.col.pr', 'tl.col.agent', 'tl.kind.message', 'tl.glyph.idle', 'tl.glyph.error', 'bar.pause'])

test('a French message is not a copy of the English one', () => {
  for (const k of Object.keys(MESSAGES.fr) as MessageKey[]) {
    if (SAME_IN_BOTH.has(k)) continue
    assert.notEqual(MESSAGES.fr[k], MESSAGES.en[k], `fr.${k} is still English`)
  }
})

test('the controls and settings keys exist in every locale', () => {
  const wanted = [
    'controls.zoomIn', 'controls.zoomOut', 'controls.fit', 'controls.zoomGroup', 'controls.view', 'controls.viewSettings', 'controls.pause', 'controls.keepCards',
    'controls.expireAfter', 'controls.seconds', 'controls.minutes',
    'common.close', 'settings.title', 'settings.language', 'settings.language.auto', 'settings.theme',
    'settings.notify.cost.help', 'settings.notify.invalid',
  ]
  for (const k of wanted) for (const l of LOCALES) assert.ok(k in MESSAGES[l], `${l}.${k}`)
})

test('a figure keeps its qualification in French (at least, estimated)', () => {
  assert.match(MESSAGES.fr['settings.notify.cost.help'], /au moins/)
  assert.match(MESSAGES.fr['settings.notify.cost.help'], /estim/)
})

test('the canvas control labels are the ones the owner validated, in both locales', () => {
  const expected = {
    fr: { fit: 'Tout afficher', pause: 'Figer les animations', keepCards: 'Garder les cartes affichées', expireAfter: 'Masquer les appels sans réponse après', view: 'Affichage', viewSettings: 'Réglages d’affichage', zoomIn: 'Zoom avant', zoomOut: 'Zoom arrière' },
    en: { fit: 'Fit to view', pause: 'Freeze motion', keepCards: 'Pin cards', expireAfter: 'Hide unanswered calls after', view: 'View', viewSettings: 'View settings', zoomIn: 'Zoom in', zoomOut: 'Zoom out' },
  } as const
  for (const l of LOCALES) for (const [k, v] of Object.entries(expected[l])) assert.equal(MESSAGES[l][`controls.${k}` as MessageKey], v, `${l}.controls.${k}`)
})

test('the native notification bodies exist in both languages with the same placeholders and differ in French (#373)', () => {
  const keys = (Object.keys(MESSAGES.fr) as MessageKey[]).filter(k => k.startsWith('notify.'))
  assert.deepEqual([...keys].sort(), ['notify.complete.one', 'notify.complete.other', 'notify.cost'])
  const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join()
  for (const k of keys) {
    assert.notEqual(MESSAGES.fr[k], MESSAGES.en[k], k)
    assert.equal(holes(MESSAGES.fr[k]), holes(MESSAGES.en[k]), k)
  }
})

// #612: the catalog is split by domain in web/lib/messages/, one file per domain holding both languages side by side,
// and web/lib/messages.ts assembles them, so two pull requests on different domains touch different files.
const DOMAIN_DIR = path.join(__dirname, '..', 'web', 'lib', 'messages')
/** The files of that folder that are not a domain: the list of domains and the helpers they share */
const NOT_DOMAINS = new Set(['domains.ts', 'shared.ts'])

test('every file of web/lib/messages/ is a registered domain, and every registered domain has its file (#612)', () => {
  const files = fs.readdirSync(DOMAIN_DIR).filter(f => f.endsWith('.ts') && !NOT_DOMAINS.has(f)).map(f => f.replace(/\.ts$/, '')).sort()
  assert.ok(files.length > 1, 'the catalog is split in several domain files')
  assert.deepEqual(Object.keys(MESSAGE_DOMAINS).sort(), files)
})

test('every domain has both languages, with the same keys, none empty (#612)', () => {
  for (const [name, domain] of Object.entries(MESSAGE_DOMAINS)) {
    const tables = domain as Partial<Record<Locale, Readonly<Record<string, string>>>>
    for (const l of LOCALES) {
      const table = tables[l]
      assert.ok(table && typeof table === 'object', `${name} has no ${l} table`)
      assert.ok(Object.keys(table).length > 0, `${name}.${l} is empty`)
      assert.deepEqual(Object.keys(table).sort(), Object.keys(tables.fr ?? {}).sort(), `${name}: keys of ${l} differ from fr`)
      for (const [k, v] of Object.entries(table)) assert.ok(typeof v === 'string' && v.trim().length > 0, `${name}.${l}.${k}`)
    }
  }
})

test('no key is defined in two domain files (#612)', () => {
  for (const l of LOCALES) {
    const owner = new Map<string, string>()
    for (const [name, domain] of Object.entries(MESSAGE_DOMAINS)) {
      for (const k of Object.keys(domain[l])) {
        assert.ok(!owner.has(k), `${l}.${k} is defined in ${owner.get(k)} and in ${name}`)
        owner.set(k, name)
      }
    }
  }
})

test('a new domain is added in one place: messages.ts assembles every domain of domains.ts without naming them (#613)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'lib', 'messages.ts'), 'utf8')
  for (const name of Object.keys(MESSAGE_DOMAINS)) {
    assert.ok(!source.includes(`MESSAGE_DOMAINS['${name}']`), `messages.ts names the domain ${name}: list it in domains.ts only`)
  }
})

/** The key prefixes a domain file declares on its second line ("// Keys: tray.*, quota.*."), without the ".*" */
function declaredPrefixes(name: string): string[] {
  const line = fs.readFileSync(path.join(DOMAIN_DIR, `${name}.ts`), 'utf8').split('\n')[1] ?? ''
  const m = line.match(/^\/\/ Keys: ((?:[\w-]+\.\*(?:, )?)+)\./)
  assert.ok(m, `${name}.ts declares its key prefixes on its second line ("// Keys: <prefix>.*, ...")`)
  return m[1].split(', ').map(p => p.replace(/\.\*$/, ''))
}

test('every key of a domain file starts with a prefix that domain declares, and no prefix has two owners (#613)', () => {
  const owner = new Map<string, string>()
  for (const [name, domain] of Object.entries(MESSAGE_DOMAINS)) {
    const prefixes = declaredPrefixes(name)
    for (const p of prefixes) {
      assert.ok(!owner.has(p), `prefix ${p}.* is declared by ${owner.get(p)} and by ${name}`)
      owner.set(p, name)
    }
    for (const k of Object.keys(domain.fr)) {
      assert.ok(prefixes.some(p => k.startsWith(`${p}.`)), `${k} is in ${name}.ts, whose keys are ${prefixes.map(p => `${p}.*`).join(', ')}`)
    }
  }
})

test('the assembled catalog is exactly the union of the domain files, nothing lost or added (#612)', () => {
  for (const l of LOCALES) {
    const merged: Record<string, string> = {}
    for (const domain of Object.values(MESSAGE_DOMAINS)) Object.assign(merged, domain[l])
    assert.deepEqual({ ...MESSAGES[l] }, merged, `assembled ${l}`)
    const total = Object.values(MESSAGE_DOMAINS).reduce((n, d) => n + Object.keys(d[l]).length, 0)
    assert.equal(Object.keys(MESSAGES[l]).length, total, `${l}: number of keys`)
  }
})
