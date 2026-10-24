// #510: the Node side of the shared protocol contract (app-tray/protocol-fixtures.json).
// The Go side (app-tray/native/trayproto/contract_test.go) reads the same file: a line the driver writes
// here is a line the Go binary parses there, and a line the Go binary writes there is one the driver accepts here.
// The refused lines (driverToBinaryRefused) are checked on the Go side only: the driver has no parser for the lines
// it writes, so this side only checks that the section is there (#613).
import '../../scripts/all-locales' // #662: both languages are loaded before the tests
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { LOCALES, translate, type Locale } from '../../web/lib/messages'
import { deriveMenu } from './menu-model'
import { encodeMessage, parseBinaryMessage, type BinaryMessage, type DriverMessage } from './protocol'

interface Scenario { locale: string; status: unknown; port: number | null; ownsRelay: boolean }
interface Fixtures {
  driverToBinary: { name: string; scenario?: Scenario; message: DriverMessage; line: string }[]
  driverToBinaryRefused: { name: string; line: string }[]
  binaryToDriver: { name: string; message: BinaryMessage; line: string }[]
}

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'protocol-fixtures.json'), 'utf8')) as Fixtures

describe('shared protocol contract: driver side (#510)', () => {
  it('has cases in every section', () => {
    assert.ok(fixtures.driverToBinary.length >= 4)
    assert.ok(fixtures.driverToBinaryRefused.length >= 10)
    assert.equal(fixtures.binaryToDriver.length, 7)
  })

  it('the menus of the contract are the ones deriveMenu really builds', () => {
    const withScenario = fixtures.driverToBinary.filter(c => c.scenario)
    assert.ok(withScenario.length >= 2)
    for (const { name, scenario, message } of withScenario) {
      const s = scenario as Scenario
      assert.ok((LOCALES as readonly string[]).includes(s.locale), name)
      const menu = deriveMenu({
        probe: s.status === null ? { kind: 'not-started' } : { kind: 'ok', body: s.status, receivedAt: 1 },
        now: 1, port: s.port, ownsRelay: s.ownsRelay, t: (k, p) => translate(s.locale as Locale, k, p),
      })
      assert.deepEqual({ type: 'menu', ...menu }, message, name)
    }
  })

  it('the driver writes exactly the line of the contract', () => {
    for (const { name, message, line } of fixtures.driverToBinary) {
      assert.equal(encodeMessage(message), `${line}\n`, name)
    }
  })

  it('the driver accepts every line the binary is expected to write', () => {
    for (const { name, message, line } of fixtures.binaryToDriver) {
      assert.deepEqual(parseBinaryMessage(line), { ok: true, message }, name)
    }
  })

  it('covers every item id a click may carry', () => {
    const ids = fixtures.binaryToDriver.flatMap(c => (c.message.type === 'click' ? [c.message.id] : []))
    assert.deepEqual([...ids].sort(), ['copyUrl', 'open', 'quit', 'skipped', 'state'])
  })
})
