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
  it('collects every --allow-host name, in order, and defaults to none (#241)', () => {
    assert.deepEqual(parseArgs([]).allowHosts, [])
    const a = parseArgs(['--allow-host', 'box.ts.net', '--no-open', '--allow-host', 'lens.example.com:8443'])
    assert.deepEqual(a.allowHosts, ['box.ts.net', 'lens.example.com:8443'])
  })
  it('keeps a trailing --allow-host / --host without value, so that the start refuses it instead of ignoring it (#241)', () => {
    assert.deepEqual(parseArgs(['--allow-host']).allowHosts, [''])
    assert.equal(parseArgs(['--host']).host, '')
  })
  it('keeps --host so that the start can refuse it instead of silently ignoring it (#241)', () => {
    assert.equal(parseArgs([]).host, undefined)
    assert.equal(parseArgs(['--host', '0.0.0.0']).host, '0.0.0.0')
  })
  it('--remote is off by default and only set by the flag itself (#474)', () => {
    assert.equal(parseArgs([]).remote, false)
    assert.equal(parseArgs(['--host', '192.168.1.10']).remote, false)
    const a = parseArgs(['--remote', '--host', '192.168.1.10'])
    assert.equal(a.remote, true)
    assert.equal(a.host, '192.168.1.10')
  })
  it('a --host / --allow-host without value does not swallow the next flag (#474)', () => {
    const a = parseArgs(['--host', '--remote'])
    assert.equal(a.host, '')
    assert.equal(a.remote, true)
    const b = parseArgs(['--allow-host', '--no-open'])
    assert.deepEqual(b.allowHosts, [''])
    assert.equal(b.open, false)
  })
  it('reads the --flag=value form of --host / --allow-host / --remote instead of ignoring it (#474)', () => {
    assert.equal(parseArgs(['--host=0.0.0.0']).host, '0.0.0.0')
    assert.equal(parseArgs(['--host=']).host, '')
    assert.deepEqual(parseArgs(['--allow-host=box.ts.net']).allowHosts, ['box.ts.net'])
    // Any value given to --remote is still an explicit request: fail closed, the start refuses it
    assert.equal(parseArgs(['--remote=0']).remote, true)
  })
  it('an option that takes a value does not swallow a following flag (#474)', () => {
    for (const opt of ['--import', '--webhook', '--launch-repo']) {
      const a = parseArgs([opt, '--host', '0.0.0.0'])
      assert.equal(a.host, '0.0.0.0', opt)
    }
    assert.deepEqual(parseArgs(['--import', '--remote']).imports, [])
    assert.equal(parseArgs(['--import', '--remote']).remote, true)
  })
  it('--allow-launch is off by default; --launch-repo collects owner/name in order (#229)', () => {
    assert.equal(parseArgs([]).allowLaunch, false)
    assert.deepEqual(parseArgs([]).launchRepos, [])
    const a = parseArgs(['--allow-launch', '--launch-repo', 'j0hn-42/agent-lens', '--no-open', '--launch-repo', 'o/n'])
    assert.equal(a.allowLaunch, true)
    assert.deepEqual(a.launchRepos, ['j0hn-42/agent-lens', 'o/n'])
    assert.deepEqual(parseArgs(['--launch-repo']).launchRepos, [])
  })
})
