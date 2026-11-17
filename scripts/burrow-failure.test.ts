// Burrow view: a failed tool call. The animal stumbles where it is, and its bubble gives the exit code only when the
// received text of a failed shell command proves one; nothing else is said, no line is made up.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { exitCodeOf } from '../web/lib/burrow/burrow-failure'

test('exitCodeOf: the exit code of a failed shell command, read strictly from the start of its received text', () => {
  const bash = (text: string, field: 'errorMessage' | 'result' = 'errorMessage') => exitCodeOf({ toolName: 'Bash', [field]: text })
  assert.equal(bash('Exit code 2'), 2)
  assert.equal(bash('Exit code 127\nbash: foo: command not found'), 127)
  assert.equal(bash('[FAILED] Exit code 1', 'result'), 1, 'the hook path prefixes the result')
  assert.equal(bash('Exit code 0'), 0)
  assert.equal(bash('Exit code 255'), 255)
  assert.equal(bash('exit code 2'), null, 'the case is the received one')
  assert.equal(bash('Exit code 2000'), null)
  assert.equal(bash('Exit code 256'), null, 'not an exit status')
  assert.equal(bash('Error: Exit code 2'), null, 'only at the start')
  assert.equal(bash('Exit code -1'), null)
  assert.equal(bash(''), null)
  assert.equal(exitCodeOf({ toolName: 'Bash' }), null, 'no text received')
  assert.equal(exitCodeOf({ toolName: 'Read', errorMessage: 'Exit code 2' }), null, 'only a shell command has an exit code')
  // the error message comes first, the result when there is none
  assert.equal(exitCodeOf({ toolName: 'Bash', errorMessage: 'Exit code 3', result: 'Exit code 4' }), 3)
  assert.equal(exitCodeOf({ toolName: 'Bash', errorMessage: '', result: 'Exit code 4' }), 4)
})
