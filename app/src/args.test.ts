import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs } from './args'

describe('parseArgs', () => {
  it('defaults allWorkspaces to false', () => {
    assert.equal(parseArgs([]).allWorkspaces, false)
  })
  it('parses --all-workspaces alongside other flags', () => {
    const a = parseArgs(['--all-workspaces', '--no-open', '-p', '4000'])
    assert.equal(a.allWorkspaces, true)
    assert.equal(a.open, false)
    assert.equal(a.port, 4000)
  })
  it('collects every --import path, in order, and defaults to none', () => {
    assert.deepEqual(parseArgs([]).imports, [])
    const a = parseArgs(['--import', '/tmp/a.jsonl', '--no-open', '--import', '/tmp/cloud'])
    assert.deepEqual(a.imports, ['/tmp/a.jsonl', '/tmp/cloud'])
    assert.equal(a.open, false)
  })
  it('collects every --webhook URL, in order, and defaults to none (#236)', () => {
    assert.deepEqual(parseArgs([]).webhooks, [])
    const a = parseArgs(['--webhook', 'https://a.example.com/h', '--no-open', '--webhook', 'http://127.0.0.1:9/h'])
    assert.deepEqual(a.webhooks, ['https://a.example.com/h', 'http://127.0.0.1:9/h'])
    assert.deepEqual(parseArgs(['--webhook']).webhooks, [])
  })
  it('ignores a trailing --import without a path', () => {
    assert.deepEqual(parseArgs(['--import']).imports, [])
  })
})
