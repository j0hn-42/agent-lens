/**
 * Minimal vscode module shim for running extension code outside VS Code.
 * Only implements what hook-server.ts, session-watcher.ts and webview-provider.ts (tests) actually use.
 */
'use strict'

class EventEmitter {
  constructor() { this._listeners = [] }
  get event() {
    return (listener) => {
      this._listeners.push(listener)
      return { dispose: () => { const i = this._listeners.indexOf(listener); if (i >= 0) this._listeners.splice(i, 1) } }
    }
  }
  fire(data) { for (const l of this._listeners) l(data) }
  dispose() { this._listeners = [] }
}

const Uri = {
  file: (p) => ({ fsPath: p, path: p, toString: () => `file://${p}` }),
  joinPath: (base, ...segments) => Uri.file([base.path, ...segments].join('/')),
}

module.exports = {
  EventEmitter,
  Uri,
  workspace: {
    workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
    getConfiguration: () => ({ get: () => undefined }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {
    showInformationMessage: () => {},
  },
}
