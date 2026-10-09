import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import {
  claudeConfigDir, claudeProjectsDir, claudeTeamsDir, claudeSettingsPath, discoveryDir,
} from '../src/claude-config-dir'

describe('claudeConfigDir', () => {
  const home = path.resolve('/tmp/fake-home')
  it('defaults to <home>/.claude', () => {
    assert.equal(claudeConfigDir({}, home), path.join(home, '.claude'))
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '' }, home), path.join(home, '.claude'))
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '   ' }, home), path.join(home, '.claude'))
  })
  it('honours CLAUDE_CONFIG_DIR, including ~ expansion', () => {
    const second = path.resolve('/tmp/second-account')
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: second }, home), second)
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '~/.claude-work' }, home), path.join(home, '.claude-work'))
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '~' }, home), home)
  })
  it('derives sub-paths from the config dir, but keeps discovery under the default home', () => {
    const second = path.resolve('/tmp/second-account')
    assert.equal(claudeProjectsDir(second), path.join(second, 'projects'))
    assert.equal(claudeTeamsDir(second), path.join(second, 'teams'))
    assert.equal(claudeSettingsPath(second), path.join(second, 'settings.json'))
    assert.equal(discoveryDir(home), path.join(home, '.claude', 'agent-lens'))
  })
})
