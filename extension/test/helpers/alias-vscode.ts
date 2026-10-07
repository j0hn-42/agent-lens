/**
 * Test helper: resolve the `vscode` module to scripts/vscode-shim.js so extension
 * code (hook-server) can be imported outside VS Code. Import this BEFORE the code
 * under test, and load that code with a dynamic import().
 */
import Module from 'node:module'
import * as path from 'node:path'

const shim = path.resolve(__dirname, '../../../scripts/vscode-shim.js')
const m = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string }
const original = m._resolveFilename
m._resolveFilename = function (request: string, ...rest: unknown[]) {
  return original.call(this, request === 'vscode' ? shim : request, ...rest)
}
