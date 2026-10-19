// Browser entry of the Files & repeats harness (files-repeats.ts, #518): the REAL FileAttentionPanel with 8 files and N repeated
// reads, which the demo never shows (its scenario repeats nothing). ?repeats=N (default 5), ?files=N (default 8). The locale is the
// one stored by the test (agent-lens:locale). Bundled by esbuild at test time; nothing of it ships.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { FileAttentionPanel } from '@/components/agent-visualizer/file-attention-panel'
import { emptyWasteLedger, recordToolStart, recordToolEnd, type WasteLedger } from '@/lib/waste'
import type { Agent, FileAttention } from '@/lib/agent-types'

const q = new URLSearchParams(location.search)
const repeats = Number(q.get('repeats') ?? 5)
const fileCount = Number(q.get('files') ?? 8)
const noop = () => {}
const AGENT = 'default:main'
const agents = new Map<string, Agent>([[AGENT, { id: AGENT, displayName: 'alpha' } as unknown as Agent]])

let n = 0
let waste: WasteLedger = emptyWasteLedger()
for (let r = 0; r < repeats; r++) {
  const file = `/home/me/code/alpha/web/components/agent-visualizer/panel-${r}.tsx`
  for (let i = 0; i < 3; i++) {
    const id = `tc${++n}`
    waste = recordToolStart(waste, { sessionId: 'default', agentId: AGENT, toolName: 'Read', inputData: { file_path: file }, toolUseId: id, toolCallId: id, time: n })
    waste = recordToolEnd(waste, id, 1200, 'reported')
  }
}

const files = new Map<string, FileAttention>()
for (let i = 0; i < fileCount; i++) {
  const path = `/home/me/code/alpha/src/module-${i}/file-${i}.ts`
  files.set(path, { path, reads: 2, edits: i % 2, totalTokens: 12_000 - i * 1000, lastAccessed: i, agents: [AGENT] })
}

createRoot(document.getElementById('root')!).render(
  <FileAttentionPanel visible fileAttention={files} waste={waste} agents={agents} onClose={noop} onOpenFile={noop} />,
)
