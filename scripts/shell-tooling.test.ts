// Tooling recognised on a Bash command line (#317): Python, tests, docker, package managers.
// Everything comes from the command text; a pill says the command was issued, never that it passed.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { toolingCommands, toolGlyph, todoProgress, urlHost, notebookCell } from '../web/lib/action-summary'

test('python scripts and modules', () => {
  assert.deepEqual(toolingCommands('python analyse.py --fast'), [{ kind: 'python', label: 'python analyse.py' }])
  assert.deepEqual(toolingCommands('python3 -m http.server 8000'), [{ kind: 'python', label: 'python -m http.server' }])
  assert.deepEqual(toolingCommands('uv run python tools/x.py'), [{ kind: 'python', label: 'python tools/x.py' }])
  assert.deepEqual(toolingCommands('python -c "print(1)"'), [{ kind: 'python', label: 'python' }])
})

test('test runners', () => {
  assert.deepEqual(toolingCommands('pytest -q tests/'), [{ kind: 'test', label: 'pytest' }])
  assert.deepEqual(toolingCommands('python -m pytest'), [{ kind: 'test', label: 'python -m pytest' }])
  assert.deepEqual(toolingCommands('pnpm test'), [{ kind: 'test', label: 'pnpm test' }])
  assert.deepEqual(toolingCommands('pnpm --dir web run test:e2e'), [{ kind: 'test', label: 'pnpm run test:e2e' }])
  assert.deepEqual(toolingCommands('node --import tsx --test a.test.ts'), [{ kind: 'test', label: 'node --test' }])
  assert.deepEqual(toolingCommands('cargo test'), [{ kind: 'test', label: 'cargo test' }])
  assert.deepEqual(toolingCommands('npx vitest run'), [{ kind: 'test', label: 'vitest' }])
})

test('package managers and docker', () => {
  assert.deepEqual(toolingCommands('pnpm install --frozen-lockfile'), [{ kind: 'package', label: 'pnpm install' }])
  assert.deepEqual(toolingCommands('pip install -r r.txt'), [{ kind: 'package', label: 'pip install' }])
  assert.deepEqual(toolingCommands('docker compose up -d'), [{ kind: 'docker', label: 'docker compose up' }])
  assert.deepEqual(toolingCommands('docker build -t x .'), [{ kind: 'docker', label: 'docker build' }])
})

test('not tooling: other commands, quoted text, look-alikes, bare tools', () => {
  assert.deepEqual(toolingCommands('ls -la'), [])
  assert.deepEqual(toolingCommands('echo "pytest && pnpm install"'), [])
  assert.deepEqual(toolingCommands('pythonista run'), [])
  assert.deepEqual(toolingCommands('pnpm'), [])
  assert.deepEqual(toolingCommands('pnpm dev'), [])
})

test('compound commands list each distinct call in order', () => {
  assert.deepEqual(
    toolingCommands('pnpm install && pnpm test; pnpm test'),
    [{ kind: 'package', label: 'pnpm install' }, { kind: 'test', label: 'pnpm test' }],
  )
})

test('Bash glyph: first recognised command wins, plain commands stay generic', () => {
  assert.equal(toolGlyph('Bash', { command: 'python a.py' }), 'python')
  assert.equal(toolGlyph('Bash', { command: 'cd x && pytest' }), 'test')
  assert.equal(toolGlyph('Bash', { command: 'docker ps' }), 'docker')
  assert.equal(toolGlyph('Bash', { command: 'pnpm i' }), 'package')
  assert.equal(toolGlyph('Bash', { command: 'git add . && pnpm test' }), 'git')
  assert.equal(toolGlyph('Bash', { command: 'ls' }), 'shell')
})

test('glyph of the other tools', () => {
  assert.equal(toolGlyph('TodoWrite', {}), 'todo')
  assert.equal(toolGlyph('WebSearch', {}), 'web')
  assert.equal(toolGlyph('WebFetch', {}), 'web')
  assert.equal(toolGlyph('AskUserQuestion', {}), 'ask')
  assert.equal(toolGlyph('Task', {}), 'task')
  assert.equal(toolGlyph('Agent', {}), 'task')
  assert.equal(toolGlyph('NotebookEdit', {}), 'notebook')
})

test('todoProgress: counts from the list in the call, null when it is not a list', () => {
  assert.deepEqual(
    todoProgress({ todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }] }),
    { done: 1, active: 1, total: 3 },
  )
  assert.equal(todoProgress({ todos: [] }), null)
  assert.equal(todoProgress({ todos: 'x' }), null)
  assert.equal(todoProgress({ todos: [{ status: 'completed' }] }), null)
})

test('urlHost: host of an http(s) URL, nothing otherwise', () => {
  assert.equal(urlHost('https://stripe.com/docs/api'), 'stripe.com')
  assert.equal(urlHost('http://localhost:3000/x'), 'localhost:3000')
  assert.equal(urlHost('not a url'), null)
  assert.equal(urlHost('file:///etc/passwd'), null)
  assert.equal(urlHost(undefined), null)
})

test('notebookCell: what the call states about the cell', () => {
  assert.deepEqual(notebookCell({ cell_number: 3, edit_mode: 'replace' }), { cell: 'cell 3', mode: 'replace' })
  assert.deepEqual(notebookCell({ cell_id: 'abc', edit_mode: 'insert' }), { cell: 'cell abc', mode: 'insert' })
  assert.deepEqual(notebookCell({ notebook_path: '/n.ipynb' }), { cell: null, mode: null })
})
