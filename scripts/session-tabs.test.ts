import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { IMPORTED_PROJECT_ID, IMPORTED_PROJECT_NAME, type SessionInfo } from '../web/lib/bridge-types'
import { folderPrefixedLabel, sessionFolder, spansSeveralFolders } from '../web/lib/session-tabs'
import { selectionLabel } from '../web/lib/session-tree'

const session = (id: string, label: string, extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, label, status: 'active', startTime: 0, lastActivityTime: 0, ...extra })

const alpha = session('a', 'fix login', { projectId: 'pa', projectName: 'alpha' })
const beta = session('b', 'fix login', { projectId: 'pb', projectName: 'beta' })

test('sessionFolder only names a folder the source proved (project id and name together)', () => {
  assert.equal(sessionFolder(alpha), 'alpha')
  assert.equal(sessionFolder(session('x', 'l')), null)
  assert.equal(sessionFolder(session('x', 'l', { projectName: 'alpha' })), null, 'a name without project id is not proof')
  assert.equal(sessionFolder(session('x', 'l', { projectId: 'pa' })), null)
  assert.equal(sessionFolder(session('x', 'l', { projectId: IMPORTED_PROJECT_ID, projectName: IMPORTED_PROJECT_NAME })), null, 'imported transcripts are not a local folder')
  assert.equal(sessionFolder(session('x', 'l', { projectId: 'pa', projectName: '   ' })), null)
})

test('spansSeveralFolders needs two distinct proven folders', () => {
  assert.equal(spansSeveralFolders([alpha, beta]), true)
  assert.equal(spansSeveralFolders([alpha, session('c', 'other', { projectId: 'pa', projectName: 'alpha' })]), false, 'worktrees of one repository share a project id')
  assert.equal(spansSeveralFolders([alpha, session('c', 'no git')]), false, 'a session outside git is not a second folder')
  assert.equal(spansSeveralFolders([]), false)
})

test('folderPrefixedLabel prefixes only when the folder tells two sessions apart', () => {
  assert.equal(folderPrefixedLabel(alpha, [alpha, beta]), 'alpha / fix login')
  assert.equal(folderPrefixedLabel(beta, [alpha, beta]), 'beta / fix login')
  assert.equal(folderPrefixedLabel(alpha, [alpha]), 'fix login', 'one folder: nothing to tell apart')
  assert.equal(folderPrefixedLabel(session('c', 'no git'), [alpha, beta]), 'no git', 'no proven folder: no prefix')
})

test('folderPrefixedLabel does not repeat a folder the label already starts with, and prefixes a renamed label too', () => {
  const same = session('c', 'Alpha: hotfix', { projectId: 'pa', projectName: 'alpha' })
  assert.equal(folderPrefixedLabel(same, [same, beta]), 'Alpha: hotfix')
  const renamed = session('d', 'my name', { projectId: 'pa', projectName: 'alpha', originalLabel: 'fix login' })
  assert.equal(folderPrefixedLabel(renamed, [renamed, beta]), 'alpha / my name')
})

test('selectionLabel (top bar) carries the folder when several folders are open', () => {
  assert.equal(selectionLabel('a', [alpha, beta]), 'alpha / fix login')
  assert.equal(selectionLabel('a', [alpha]), 'fix login')
  assert.equal(selectionLabel('team:t', [alpha, beta]), 'Team t')
})
