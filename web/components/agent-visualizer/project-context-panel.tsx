'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING } from '@/lib/feed-utils'
import { useProjectContext } from '@/hooks/use-project-context'
import type { ProjectContextData, ProjectContextFile } from '@/lib/project-context'
import { PanelHeader, SlidingPanel, useDockPanel, dockAttrs } from './shared-ui'

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

const UNREADABLE_REASON = { symlink: 'symbolic link', 'not-a-file': 'not a regular file', unreadable: 'permission or read error' } as const

const kb = (bytes: number) => Math.max(1, Math.round(bytes / 1024))

function Note({ children, role }: { children: React.ReactNode; role?: 'alert' | 'status' }) {
  return <p role={role} className="text-[11px] font-mono py-2 m-0" style={{ color: COLORS.textMuted }}>{children}</p>
}

function FileBlock({ file }: { file: ProjectContextFile }) {
  // The text block is a scroll container: it joins the tab order only while it actually scrolls, so a keyboard
  // user can scroll it (WCAG 2.1.1) without a static tabIndex on a non-interactive element (set imperatively,
  // as in the link panel).
  const preRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = preRef.current
    if (!el) return
    if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) el.setAttribute('tabindex', '0')
    else el.removeAttribute('tabindex')
  }, [file.text, file.found])
  return (
    <section aria-label={file.name} className="mb-2">
      <h3 className="m-0 text-[11px] font-mono font-semibold tracking-wider" style={{ color: COLORS.panelLabel }}>{file.name}</h3>
      {!file.found ? (
        <Note>{file.unreadable ? `${file.name} is present but was not read (${UNREADABLE_REASON[file.unreadable]}).` : `${file.name} not found for this project.`}</Note>
      ) : (
        <>
          {file.truncated && (
            <p className="text-[11px] font-mono m-0 py-1" style={{ color: COLORS.tool }}>
              Truncated: first {LIMIT_KB} KB of {kb(file.bytes)} KB.
            </p>
          )}
          <pre
            ref={preRef}
            aria-label={`${file.name} content`}
            className={`m-0 max-h-[260px] overflow-auto whitespace-pre-wrap break-words text-[11px] font-mono rounded p-2 ${FOCUS_RING}`}
            style={{ background: COLORS.holoBg05, color: COLORS.assistantText, scrollbarWidth: 'thin' }}
          >{file.text}</pre>
        </>
      )}
    </section>
  )
}

/**
 * Context and Files are mutually exclusive: Context takes the 'files' slot of the right dock, so the shared
 * layout places it (below the top bar and the message feed, above the control bar). Mounted only while open:
 * a mounted-but-closed registration would close the Files panel's slot.
 */
function ContextDock({ children }: { children: (maxHeight: number | string) => ReactNode }) {
  const dock = useDockPanel('files', true)
  const { rect } = dock
  return (
    <SlidingPanel
      visible
      position={rect ? { top: rect.y, left: rect.x } : { top: 'calc(var(--topbar-h, 60px) + 8px)', right: 12 }}
      zIndex={Z.sidePanel}
      width={rect?.w ?? 360}
      attrs={dockAttrs('files', 'right', dock)}
      style={dock.hidden ? { display: 'none' } : undefined}
    >
      {children(rect?.h ?? '70vh')}
    </SlidingPanel>
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
    <ContextDock>
      {maxHeight => (
      <div className="glass-card relative flex flex-col" style={{ maxHeight }}>
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

        <div className="min-h-0 flex-1 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
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
      )}
    </ContextDock>
  )
}
