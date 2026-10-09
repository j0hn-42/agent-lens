#!/usr/bin/env node
/**
 * vscode:uninstall script — runs when the extension is uninstalled.
 * Removes Agent Lens hooks from ALL known Claude Code settings files,
 * then deletes the entire ~/.claude/agent-lens/ directory.
 *
 * Hook detection and the settings write are the shared ones (./claude-hooks.js): Windows
 * paths match, only our hooks are removed (user sibling hooks stay), the write is atomic,
 * and an unreadable settings file is left untouched.
 *
 * Global settings cleaned (deduplicated): ~/.claude/settings.json, $CLAUDE_CONFIG_DIR/settings.json,
 * and every settings.json recorded in settings-paths.txt when hooks were written (other accounts).
 * Project settings: workspaces.json manifest, then discovery files ({hash}-{pid}.json) as a fallback.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  isAgentLensHook, removeAgentLensHooks, updateSettings, claudeConfigDir, readSettingsPaths,
} = require('./claude-hooks');

function discoveryDir() {
  return path.join(os.homedir(), '.claude', 'agent-lens');
}

/** Remove our hooks from one settings file; best effort, an unreadable file is never modified. */
function removeHooksFromFile(settingsPath) {
  try {
    updateSettings(settingsPath, removeAgentLensHooks, { deleteIfEmpty: true });
  } catch { /* best effort: unreadable or unwritable file left as is */ }
}

function globalSettingsPaths(dir = discoveryDir()) {
  return [
    path.join(os.homedir(), '.claude', 'settings.json'),
    path.join(claudeConfigDir(), 'settings.json'),
    ...readSettingsPaths(dir),
  ];
}

function collectWorkspaces(dir = discoveryDir()) {
  const workspaces = new Set();

  // Source 1: workspaces.json manifest
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'workspaces.json'), 'utf-8'));
    if (Array.isArray(data)) {
      for (const w of data) { if (typeof w === 'string') { workspaces.add(w); } }
    }
  } catch { /* skip */ }

  // Source 2: discovery files (fallback — covers versions before the manifest existed)
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'workspaces.json');
    for (const file of files) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
        if (d && typeof d.workspace === 'string') { workspaces.add(d.workspace); }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  return workspaces;
}

function main() {
  const dir = discoveryDir();
  const files = new Set(globalSettingsPaths(dir).map(p => path.resolve(p)));
  for (const workspace of collectWorkspaces(dir)) {
    files.add(path.resolve(workspace, '.claude', 'settings.local.json'));
  }
  for (const file of files) { removeHooksFromFile(file); }

  // Delete entire agent-lens directory (manifests, discovery files, hook script)
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

module.exports = { isAgentLensHook, removeHooksFromFile, globalSettingsPaths, collectWorkspaces };

if (require.main === module) { main(); }
