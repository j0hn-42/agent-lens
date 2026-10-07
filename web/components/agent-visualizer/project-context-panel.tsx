'use client'

import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING } from '@/lib/feed-utils'
import { useProjectContext } from '@/hooks/use-project-context'
import type { ProjectContextData, ProjectContextFile } from '@/lib/project-context'
import { PanelHeader, SlidingPanel } from './shared-ui'

/** Same bound as the relay (extension PROJECT_CONTEXT_MAX_FILE_BYTES) */
const LIMIT_KB = 64

interface ProjectContextPanelProps {
  visible: boolean
  /** Single selected session; null for the 'All' and team views */
  sessionId: string | null
  /** Set when the relay cannot be asked from here (VS Code, demo): states why instead of loading */
  unavailableReason?: string
  fetchContext: (sessionId: string) => Promise<ProjectContextData | 'unavailable'>
  onClose: () => void
}

const kb = (bytes: number) => Math.max(1, Math.round(bytes / 1024))

function Note({ children, role }: { children: React.ReactNode; role?: 'alert' | 'status' }) {
  return <p role={role} className="text-[11px] font-mono py-2 m-0" style={{ color: COLORS.textMuted }}>{children}</p>
}

function FileBlock({ file }: { file: ProjectContextFile }) {
  return (
    <section aria-label={file.name} className="mb-2">
      <h3 className="m-0 text-[11px] font-mono font-semibold tracking-wider" style={{ color: COLORS.panelLabel }}>{file.name}</h3>
      {!file.found ? (
        <Note>{file.name} not found for this project.</Note>
      ) : (
        <>
          {file.truncated && (
            <p className="text-[11px] font-mono m-0 py-1" style={{ color: COLORS.tool }}>
              Truncated: first {LIMIT_KB} KB of {kb(file.bytes)} KB.
            </p>
          )}
          <pre
            tabIndex={0}
            aria-label={`${file.name} content`}
            className={`m-0 max-h-[260px] overflow-auto whitespace-pre-wrap break-words text-[11px] font-mono rounded p-2 ${FOCUS_RING}`}
            style={{ background: COLORS.holoBg05, color: COLORS.assistantText, scrollbarWidth: 'thin' }}
          >{file.text}</pre>
        </>
      )}
    </section>
  )
}

export function ProjectContextPanel({ visible, sessionId, unavailableReason, fetchContext, onClose }: ProjectContextPanelProps) {
  // Loads only while the panel is open, for one selected session, when the relay can be reached
  const canLoad = !unavailableReason && sessionId !== null
  const { state, refresh } = useProjectContext(fetchContext, sessionId, visible && canLoad)

  if (!visible) return null

  const current = canLoad && state.sessionId === sessionId ? state : null
  const data = current?.status === 'ready' ? current.data
    : current?.status === 'error' || current?.status === 'loading' ? current.stale : undefined

  return (
    <SlidingPanel visible={visible} position={{ top: 48, right: 12 }} zIndex={Z.sidePanel} width={360}>
      <div className="glass-card relative">
        <PanelHeader
          onClose={onClose}
          actions={canLoad && (
            <button
              type="button"
              onClick={refresh}
              aria-label="Refresh project context"
              title="Refresh"
              className={`text-[11px] font-mono px-1.5 min-h-6 min-w-6 rounded ${FOCUS_RING}`}
              style={{ color: COLORS.textMuted }}
            >
              Refresh
            </button>
          )}
        >
          <span className="text-[11px] font-mono tracking-wider" style={{ color: COLORS.textPrimary }}>PROJECT CONTEXT</span>
        </PanelHeader>

        <div className="max-h-[70vh] overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
          {unavailableReason ? <Note>{unavailableReason}</Note>
            : sessionId === null ? <Note>Select a single session to see its project context.</Note>
            : current?.status === 'unavailable' ? <Note>No project context is available for this session (its working directory is unknown).</Note>
            : null}

          {current?.status === 'loading' && <Note role="status">Loading…</Note>}
          {current?.status === 'error' && (
            <p role="alert" className="text-[11px] font-mono py-2 m-0" style={{ color: COLORS.error }}>
              Could not load the project context: {current.message}.{data ? ' Showing the previous, possibly outdated, content.' : ''}
            </p>
          )}

          {data && (
            <>
              {data.files.map(f => <FileBlock key={f.kind} file={f} />)}
              {data.issues.length > 0 && (
                <section aria-label="Referenced issues" className="mb-1">
                  <h3 className="m-0 text-[11px] font-mono font-semibold tracking-wider" style={{ color: COLORS.panelLabel }}>ISSUES</h3>
                  <Note>Numbers cited in the files above (their content is not loaded).</Note>
                  <ul className="flex flex-wrap gap-1 list-none p-0 m-0">
                    {data.issues.map(n => (
                      <li key={n} className="text-[11px] font-mono px-1.5 rounded" style={{ background: COLORS.holoBg05, color: COLORS.assistantText }}>#{n}</li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </SlidingPanel>
  )
}
