// Browser entry of the Context panel harness (context-panel.ts, #599): the REAL ProjectContextPanel with a fixed context (CLAUDE.md,
// memory, cited issues, capabilities), a selected session (RESUME block) and a session branch. The Branch / Pull request / Checks
// table is fed by the harness route of /issue-links. The demo cannot draw any of it: the bridge declares the panel unavailable
// there. The locale is the one stored by the test (agent-lens:locale). Bundled by esbuild at test time; nothing of it ships.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { loadWantedLocale } from '@/lib/locale'
import { ProjectContextPanel } from '@/components/agent-visualizer/project-context-panel'
import type { ProjectContextData } from '@/lib/project-context'

const noop = () => {}
const SESSION = 'a1b2c3d4-e5f6-4a7b-8c9d-0123456789ab'
const context: ProjectContextData = {
  sessionId: SESSION,
  loadedAt: 1,
  files: [
    { kind: 'claude-md', name: 'CLAUDE.md', found: true, text: '# Alpha\n\nNever display a state that cannot be proven. A very long line without any break: ' + 'x'.repeat(120), bytes: 400, truncated: false },
    { kind: 'memory', name: 'MEMORY.md', found: false, text: '', bytes: 0, truncated: false },
  ],
  issues: [12, 130, 599, 1024],
  capabilities: {
    status: 'ok', partial: false, truncated: false,
    instructions: [{ type: 'Project', name: '/home/me/code/alpha/CLAUDE.md' }],
    skillsInvoked: [{ name: 'run-checks', calls: 2 }],
    skillsListed: ['run-checks', 'pr-fork', 'issue-waves'],
    mcpServers: [{ name: 'plugin_github_github', announced: true, calls: 3, tools: [{ name: 'issue_read', calls: 3 }] }],
  },
}

// #662: the French table is loaded on demand; the harness renders once the stored language is there, as the app does
void loadWantedLocale().finally(() => createRoot(document.getElementById('root')!).render(
  <ProjectContextPanel
    visible
    sessionId={SESSION}
    fetchContext={async () => context}
    relayOrigin={location.origin}
    sessionBranch="fix/599-reflow-contexte-tres-long-nom-de-branche"
    session={{ id: SESSION, runtime: 'claude', cwd: '/home/me/code/alpha/projects/un-repertoire-au-nom-assez-long', imported: false }}
    onClose={noop}
  />,
))
