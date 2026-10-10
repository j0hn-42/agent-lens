/**
 * #177 : « Connect to Running Agent » doit ouvrir le panneau s'il n'existe pas,
 * démarrer la source JSONL dans tous les cas et signaler un échec à l'utilisateur.
 */
import './helpers/alias-vscode'
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const vs = require('vscode') as Record<string, any>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const posted: any[] = []
let created = 0
let errors: string[] = []
let disposeCb: (() => void) | undefined

function fakePanel() {
  created++
  return {
    webview: { html: '', postMessage: (m: unknown) => { posted.push(m); return Promise.resolve(true) }, onDidReceiveMessage: () => ({ dispose() {} }) },
    onDidDispose: (cb: () => void) => { disposeCb = cb; return { dispose() {} } },
    reveal() {}, dispose() {}, iconPath: undefined,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const context = { extensionUri: { fsPath: '/ext' }, subscriptions: [] as { dispose(): void }[] } as any
let dir = ''

describe('connectToAgent (#177)', () => {
  beforeEach(() => {
    posted.length = 0; created = 0; errors = []; context.subscriptions.length = 0
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-connect-'))
    vs.Uri = { joinPath: (_b: unknown, ...p: string[]) => ({ fsPath: p.join('/'), toString: () => p.join('/') }), file: (p: string) => ({ fsPath: p }) }
    vs.ViewColumn = { One: 1, Beside: 2 }
    vs.window.createWebviewPanel = fakePanel
    vs.window.showErrorMessage = (m: string) => { errors.push(m); return Promise.resolve(undefined) }
    vs.window.showInformationMessage = () => Promise.resolve(undefined)
  })
  afterEach(() => {
    disposeCb?.()
    for (const s of context.subscriptions) s.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('jsonl sans panneau : crée le panneau et reçoit les événements', async () => {
    const file = path.join(dir, 'events.jsonl')
    fs.writeFileSync(file, JSON.stringify({ type: 'agent_spawn', time: 1 }) + '\n')
    const { connectToAgent } = await import('../src/extension')
    await connectToAgent('jsonl', context, async () => file)
    assert.equal(created, 1)
    assert.ok(posted.some(m => m.type === 'agent-event' && m.event.type === 'agent_spawn'), JSON.stringify(posted))
  })

  it('mock sans panneau : crée le panneau et poste la config de démo', async () => {
    const { connectToAgent } = await import('../src/extension')
    await connectToAgent('mock', context)
    assert.equal(created, 1)
    assert.ok(posted.some(m => m.type === 'config' && m.config.showMockData === true))
  })

  it('jsonl illisible : showErrorMessage explicite', async () => {
    const { connectToAgent } = await import('../src/extension')
    // un répertoire n'est pas lisible comme fichier JSONL
    await connectToAgent('jsonl', context, async () => dir)
    assert.equal(errors.length, 1)
    assert.match(errors[0], /JSONL/)
  })
})
