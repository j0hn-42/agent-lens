'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING_INSET } from '@/lib/focus-ring'
import { useProjectContext } from '@/hooks/use-project-context'
import type { ProjectContextData, ProjectContextFile } from '@/lib/project-context'
import { SessionWorkSection } from './session-work-section'
import { CapabilitiesSection } from './capabilities-section'
import { ResumeSection } from './resume-section'
import type { ResumableSession } from '@/lib/resume-command'
import { PanelHeader, SlidingPanel, useDockPanel, dockAttrs } from './shared-ui'
import { useLocale } from '@/lib/locale'
import { translate, type Locale } from '@/lib/messages'
import { panelName } from '@/lib/command-palette'
import { DATA_EN, t as tr } from '@/lib/panel-text'

/** Same bound as the relay (extension PROJECT_CONTEXT_MAX_FILE_BYTES) */
const LIMIT_KB = 64

interface ProjectContextPanelProps {
  visible: boolean
  /** Single selected session; null for the 'All' and team views */
  sessionId: string | null
  /** Set when the relay cannot be asked from here (VS Code, demo): states why instead of loading, in the language of the panel */
  unavailableReason?: 'vscode' | 'demo'
  fetchContext: (sessionId: string) => Promise<ProjectContextData | 'unavailable'>
  /** Relay origin for the PRs and issues of the session's project ('' = same origin); null or absent: none is requested (#228) */
  relayOrigin?: string | null
  /** Branch the selected session recorded; absent when it recorded none */
  sessionBranch?: string
  /** The selected session as listed (#240): its resume command is built from it, with no request */
  session?: ResumableSession
  /** Set only inside VS Code (#240): asks the extension for a terminal in the session's directory */
  onOpenTerminal?: (sessionId: string) => void
  onClose: () => void
}

const UNREADABLE_REASON = { symlink: 'ctx.reason.symlink', 'not-a-file': 'ctx.reason.notAFile', unreadable: 'ctx.reason.unreadable' } as const

const kb = (bytes: number) => Math.max(1, Math.round(bytes / 1024))

function Note({ children, role }: { children: React.ReactNode; role?: 'alert' | 'status' }) {
  return <p role={role} className="text-[11px] font-mono py-2 m-0" style={{ color: COLORS.textMuted }}>{children}</p>
}

function FileBlock({ file, locale }: { file: ProjectContextFile; locale: Locale }) {
  const t = (key: Parameters<typeof tr>[1], params?: Parameters<typeof tr>[2]) => tr(locale, key, params)
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
        <Note>{file.unreadable ? t('ctx.unreadable', { name: file.name, reason: t(UNREADABLE_REASON[file.unreadable]) }) : t('ctx.notFound', { name: file.name })}</Note>
      ) : (
        <>
          {file.truncated && (
            <p className="text-[11px] font-mono m-0 py-1" style={{ color: COLORS.tool }}>
              {t('ctx.truncated', { limit: LIMIT_KB, kb: kb(file.bytes) })}
            </p>
          )}
          <pre
            ref={preRef}
            {...DATA_EN}
            aria-label={t('ctx.fileContent', { name: file.name })}
            className={`m-0 max-h-[260px] overflow-auto whitespace-pre-wrap break-words text-[11px] font-mono rounded p-2 ${FOCUS_RING_INSET}`}
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
  const { locale } = useLocale()
  return (
    <SlidingPanel
      visible
      position={rect ? { top: rect.y, left: rect.x } : { top: 'calc(var(--topbar-h, 60px) + 8px)', right: 12 }}
      zIndex={Z.sidePanel}
      width={rect?.w ?? 360}
      attrs={{ ...dockAttrs('files', 'right', dock), 'data-sensitive': '' }}
      label={panelName(locale, 'context')}
      labelLang={locale}
      style={dock.hidden ? { display: 'none' } : undefined}
    >
      {children(rect?.h ?? '70vh')}
    </SlidingPanel>
  )
}

export function ProjectContextPanel({ visible, sessionId, unavailableReason, fetchContext, relayOrigin, sessionBranch, session, onOpenTerminal, onClose }: ProjectContextPanelProps) {
  // Loads only while the panel is open, for one selected session, when the relay can be reached
  const canLoad = !unavailableReason && sessionId !== null
  const { state, refresh } = useProjectContext(fetchContext, sessionId, visible && canLoad)
  const { locale } = useLocale()
  const t = (key: Parameters<typeof tr>[1], params?: Parameters<typeof tr>[2]) => tr(locale, key, params)

  if (!visible) return null

  const current = canLoad && state.sessionId === sessionId ? state : null
  const data = current?.status === 'ready' ? current.data
    : current?.status === 'error' || current?.status === 'loading' ? current.stale : undefined

  return (
    <ContextDock>
      {maxHeight => (
      <div lang={locale} className="glass-card relative flex flex-col" data-sensitive="" style={{ maxHeight, background: COLORS.void }}>
        <PanelHeader
          onClose={onClose}
          closeLabel={t('common.close')}
          actions={canLoad && (
            <button
              type="button"
              onClick={refresh}
              aria-label={t('ctx.refresh.aria')}
              title={t('ctx.refresh')}
              className={`text-[11px] font-mono px-1.5 min-h-6 min-w-6 rounded ${FOCUS_RING_INSET}`}
              style={{ color: COLORS.textMuted }}
            >
              {t('ctx.refresh')}
            </button>
          )}
        >
          <span lang={locale} className="text-[11px] font-mono tracking-wider" style={{ color: COLORS.textPrimary }}>{translate(locale, 'panel.heading.context')}</span>
        </PanelHeader>

        <div className="min-h-0 flex-1 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
          {/* Needs no relay: shown in VS Code as well, for the single selected session */}
          {sessionId !== null && session?.id === sessionId && <ResumeSection session={session} onOpenTerminal={onOpenTerminal} />}

          {unavailableReason ? <Note>{t(unavailableReason === 'vscode' ? 'ctx.unavailable.vscode' : 'ctx.unavailable.demo')}</Note>
            : sessionId === null ? <Note>{t('ctx.selectOne')}</Note>
            : current?.status === 'unavailable' ? <Note>{t('ctx.noContext')}</Note>
            : null}

          {current?.status === 'loading' && <Note role="status">{t('ctx.loading')}</Note>}
          {current?.status === 'error' && (
            <p role="alert" className="text-[11px] font-mono py-2 m-0" style={{ color: COLORS.error }}>
              {t('ctx.error', { message: current.message })}{data ? t('ctx.error.stale') : ''}
            </p>
          )}

          {data && (
            <>
              {data.files.map(f => <FileBlock key={f.kind} file={f} locale={locale} />)}
              {data.issues.length > 0 && (
                <section aria-label={t('ctx.issues.region')} className="mb-1">
                  <h3 className="m-0 text-[11px] font-mono font-semibold tracking-wider" style={{ color: COLORS.panelLabel }}><span {...DATA_EN}>{t('ctx.issues.heading')}</span></h3>
                  <Note>{t('ctx.issues.note')}</Note>
                  <ul className="flex flex-wrap gap-1 list-none p-0 m-0">
                    {data.issues.map(n => (
                      <li key={n} className="text-[11px] font-mono px-1.5 rounded" style={{ background: COLORS.holoBg05, color: COLORS.assistantText }}>#{n}</li>
                    ))}
                  </ul>
                </section>
              )}
              <CapabilitiesSection capabilities={data.capabilities} />
            </>
          )}

          {canLoad && relayOrigin != null && (
            <SessionWorkSection relayOrigin={relayOrigin} sessionId={sessionId} sessionBranch={sessionBranch} active={visible} />
          )}
        </div>
      </div>
      )}
    </ContextDock>
  )
}
