/**
 * The optional PermissionRequest hook of the operator control (#240, PR 3) in the shared settings code:
 * it is ours (uninstall removes it), but it is not the observation hook (it never counts as "configured"
 * and re-running the observation setup must not remove it).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  hookKind, isAgentLensHook, settingsHaveAgentLensHooks, settingsHaveControlHook,
  removeAgentLensHooks, applyAgentLensHooks, applyControlHook, removeControlHook,
} from '../scripts/claude-hooks'

const obs = { type: 'command', command: '"node" "/h/.claude/agent-lens/hook.js"', timeout: 2 }
const ctl = { type: 'command', command: '"node" "/h/.claude/agent-lens/permission-hook.js"', timeout: 60 }
const ctlWin = { type: 'command', command: '"C:\\node.exe" "C:\\Users\\x\\.claude\\agent-lens\\permission-hook.js"', timeout: 60 }
const userCmd = { type: 'command', command: 'echo mine' }

describe('hookKind of the control hook', () => {
  it('is "control", Windows paths included, and never "current"', () => {
    assert.equal(hookKind(ctl), 'control')
    assert.equal(hookKind(ctlWin), 'control')
    assert.equal(hookKind(obs), 'current')
    assert.equal(hookKind({ command: 'node /h/other/permission-hook.js' }), null)
  })
  it('is ours (isAgentLensHook) but does not make Agent Lens "configured"', () => {
    assert.equal(isAgentLensHook({ hooks: [ctl] }), true)
    assert.equal(settingsHaveAgentLensHooks({ hooks: { PermissionRequest: [{ hooks: [ctl] }] } }), false)
    assert.equal(settingsHaveControlHook({ hooks: { PermissionRequest: [{ hooks: [ctl] }] } }), true)
    assert.equal(settingsHaveControlHook({ hooks: { PermissionRequest: [{ hooks: [userCmd] }] } }), false)
    assert.equal(settingsHaveControlHook({ hooks: { Stop: [{ hooks: [obs] }] } }), false)
  })
})

describe('applyControlHook / removeControlHook', () => {
  it('adds one PermissionRequest entry, replaces a previous one, keeps the user hooks', () => {
    const settings: Record<string, unknown> = { hooks: { PermissionRequest: [{ hooks: [userCmd] }, { hooks: [ctl] }], Stop: [{ hooks: [obs] }] } }
    applyControlHook(settings, { hooks: [ctl] })
    const entries = (settings.hooks as Record<string, Array<{ hooks: unknown[] }>>).PermissionRequest
    assert.equal(entries.length, 2)
    assert.deepEqual(entries[0].hooks, [userCmd])
    assert.deepEqual(entries[1].hooks, [ctl])
    assert.equal((settings.hooks as Record<string, unknown[]>).Stop.length, 1, 'the observation hooks are untouched')
  })
  it('removes only the control hook', () => {
    const settings: Record<string, unknown> = { hooks: { PermissionRequest: [{ hooks: [userCmd, ctl] }], Stop: [{ hooks: [obs] }] } }
    assert.equal(removeControlHook(settings), true)
    assert.deepEqual(settings, { hooks: { PermissionRequest: [{ hooks: [userCmd] }], Stop: [{ hooks: [obs] }] } })
    assert.equal(removeControlHook(settings), false)
  })
  it('drops the event when nothing else is left in it', () => {
    const settings: Record<string, unknown> = { hooks: { PermissionRequest: [{ hooks: [ctl] }], Stop: [{ hooks: [obs] }] } }
    removeControlHook(settings)
    assert.deepEqual(Object.keys(settings.hooks as object), ['Stop'])
  })
})

describe('the observation setup and the control hook', () => {
  it('applyAgentLensHooks (configure / setup.js) keeps the control hook', () => {
    const settings: Record<string, unknown> = { hooks: { PermissionRequest: [{ hooks: [ctl] }], Stop: [{ hooks: [obs] }] } }
    applyAgentLensHooks(settings, { Stop: [{ hooks: [obs] }], PreToolUse: [{ hooks: [obs] }] })
    const hooks = settings.hooks as Record<string, Array<{ hooks: unknown[] }>>
    assert.deepEqual(hooks.PermissionRequest, [{ hooks: [ctl] }])
    assert.equal(hooks.Stop.length, 1)
    assert.equal(hooks.PreToolUse.length, 1)
  })
  it('removeAgentLensHooks (uninstall) removes the control hook too', () => {
    const settings: Record<string, unknown> = { hooks: { PermissionRequest: [{ hooks: [ctl] }], Stop: [{ hooks: [obs] }] } }
    assert.equal(removeAgentLensHooks(settings), true)
    assert.equal(settings.hooks, undefined)
  })
})
