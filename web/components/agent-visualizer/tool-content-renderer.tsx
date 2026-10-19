'use client'

import { createContext, useContext, useState } from 'react'
import { COLORS } from '@/lib/colors'
import { truncatePath } from '@/lib/utils'
import { truncateWithMarker, truncateLines } from '@/lib/feed-utils'
import { FOCUS_RING_INSET } from '@/lib/focus-ring'
import { canonicalTool, patchStats, PATCH_CAPTURE_LIMIT, todoItems, editStats,shellCommands, toolingCommands, writeStats, readRange, todoProgress, urlHost, notebookCell, type EditStats, type ToolingKind, type ResultPill } from '@/lib/action-summary'
import { SearchIcon, GlobeIcon, CheckIcon, GitIcon, GhIcon, PythonIcon, TestIcon, DockerIcon, PackageIcon } from './feed-icons'
import { DATA_EN, t as tr, pluralText, toolLinesText, editSentenceText } from '@/lib/panel-text'
import type { Locale, MessageKey } from '@/lib/messages'

/** Language of the words around a call's data. English unless the caller says otherwise: the tool detail popup is not translated yet. */
const ToolLocaleContext = createContext<Locale>('en')
function useTool() {
  const locale = useContext(ToolLocaleContext)
  return { locale, t: (key: MessageKey, params?: Record<string, string | number>) => tr(locale, key, params) }
}

// Context for file-open callback — provided by parent components
type OpenFileCallback = (filePath: string, line?: number) => void
const OpenFileContext = createContext<OpenFileCallback | null>(null)
export const OpenFileProvider = OpenFileContext.Provider

interface ToolContentRendererProps {
  toolName: string
  inputData?: Record<string, unknown>
  args?: string
  compact?: boolean  // shorter rendering for inline chat
  /** The call ended without a change being proven (error, cancelled, expired): an Edit / MultiEdit says what it asked for, never a change */
  outcome?: UnappliedOutcome
  /** Language of the labels around the data (default English) */
  locale?: Locale
}

/** How an Edit / MultiEdit call ended when it proved no change */
export type UnappliedOutcome = 'error' | 'cancelled' | 'expired'

export function ToolContentRenderer({ locale = 'en', ...props }: ToolContentRendererProps) {
  return <ToolLocaleContext.Provider value={locale}><ToolContent {...props} /></ToolLocaleContext.Provider>
}

function ToolContent({ toolName, inputData, args, compact = false, outcome }: Omit<ToolContentRendererProps, 'locale'>) {
  if (!inputData) {
    return <span {...DATA_EN} style={{ color: COLORS.contentDim }}>{args || toolName}</span>
  }

  switch (canonicalTool(toolName)) {
    case 'apply_patch':
      return <PatchContent data={inputData} compact={compact} />
    case 'Edit':
      return <EditContent data={inputData} compact={compact} outcome={outcome} />
    case 'MultiEdit':
      return <MultiEditContent data={inputData} compact={compact} outcome={outcome} />
    case 'TodoWrite':
      return <TodoContent data={inputData} />
    case 'Bash':
      return <BashContent data={inputData} compact={compact} />
    case 'Write':
      return <WriteContent data={inputData} compact={compact} />
    case 'Read':
      return <ReadContent data={inputData} />
    case 'Grep':
      return <GrepContent data={inputData} />
    case 'Glob':
      return <GlobContent data={inputData} />
    case 'WebSearch':
      return <WebSearchContent data={inputData} />
    case 'WebFetch':
      return <WebFetchContent data={inputData} />
    case 'AskUserQuestion':
      return <AskUserContent data={inputData} />
    case 'Task':
    case 'Agent':
      return <TaskContent data={inputData} />
    case 'NotebookEdit':
      return <NotebookContent data={inputData} />
    default:
      return <span {...DATA_EN} style={{ color: COLORS.contentDim }}>{args || toolName}</span>
  }
}

/** Text clamped to `max` chars with a '… (+N chars)' marker and a 'Show all' toggle. */
function ClampedText({ text, max }: { text: string; max: number }) {
  const [showAll, setShowAll] = useState(false)
  const { t: tt } = useTool()
  const t = truncateWithMarker(text, max)
  return (
    <>
      <span {...DATA_EN}>{showAll ? text : t.text}</span>
      {t.hidden > 0 && !showAll && <span style={{ color: COLORS.textMuted }}>{tt('conv.marker', { n: t.hidden })}</span>}
      {t.hidden > 0 && (
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll(v => !v)}
          className={`ml-1.5 min-h-6 px-1 rounded text-[11px] underline ${FOCUS_RING_INSET}`}
          style={{ color: COLORS.textMuted }}
        >
          {showAll ? tt('tool.showLess') : tt('tool.showAll')}
        </button>
      )}
    </>
  )
}

function ShowAllToggle({ visible, showAll, onToggle }: { visible: boolean; showAll: boolean; onToggle: () => void }) {
  const { t } = useTool()
  if (!visible) return null
  return (
    <button
      type="button"
      aria-expanded={showAll}
      onClick={onToggle}
      className={`mt-0.5 min-h-6 px-1 rounded text-[11px] underline ${FOCUS_RING_INSET}`}
      style={{ color: COLORS.textMuted }}
    >
      {showAll ? t('tool.showLess') : t('tool.showAll')}
    </button>
  )
}

function FilePath({ path: filePath }: { path: string }) {
  const openFile = useContext(OpenFileContext)
  const { t } = useTool()
  if (!filePath) return null
  const short = truncatePath(filePath)
  if (!openFile) {
    return (
      <div {...DATA_EN} className="text-[11px] mb-1 truncate" style={{ color: COLORS.filePathInactive }} title={filePath}>
        {short}
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={() => openFile(filePath)}
      title={filePath}
      aria-label={t('tool.open', { path: filePath })}
      className={`block max-w-full min-h-6 mb-1 text-left text-[11px] truncate rounded hover:underline ${FOCUS_RING_INSET}`}
      style={{ color: COLORS.filePathActive }}
    >
      <span {...DATA_EN}>{short}</span>
    </button>
  )
}

/** One old_string / new_string pair of an Edit or a MultiEdit block. */
interface EditPair { old: string; next: string }

/** "+N -M" with a spoken equivalent: the sign carries the meaning, the color only reinforces it. A patch is a real
 *  diff; an Edit / MultiEdit (`pairs`) only has the two strings, so it says what they are in words. */
function EditSummary({ stats, pairs, outcome }: { stats: EditStats; pairs?: readonly EditPair[]; outcome?: UnappliedOutcome }) {
  const { locale, t } = useTool()
  const sentence = pairs ? editSentenceText(locale, stats, pairs, outcome) : null
  if (pairs && sentence == null) return null
  return (
    <div role="group" aria-label={t('tool.edit.summary')} className="mb-1 flex flex-wrap items-center gap-x-2 text-[11px] font-mono">
      {sentence != null ? (
        <span style={{ color: COLORS.contentDim }}>{sentence}</span>
      ) : (
        <>
          <span aria-hidden="true" style={{ color: COLORS.diffAdded }}>+{stats.added}</span>
          <span aria-hidden="true" style={{ color: COLORS.diffRemoved }}>-{stats.removed}</span>
          <span className="sr-only">{t('tool.edit.srDiff', { added: toolLinesText(locale, stats.added), removed: toolLinesText(locale, stats.removed) })}</span>
        </>
      )}
      {stats.blocks != null && <span style={{ color: COLORS.contentDim }}>{pluralText(locale, 'tool.blocks', stats.blocks)}</span>}
    </div>
  )
}

function DiffBlock({ oldText, newText, maxLines, asked = false }: { oldText: string; newText: string; maxLines: number; asked?: boolean }) {
  const { t } = useTool()
  const old = truncateLines(oldText, maxLines)
  const next = truncateLines(newText, maxLines)
  return (
    <div className="rounded overflow-hidden text-xs font-mono leading-snug" style={{ background: COLORS.codeBlockBg }}>
      {old.lines.map((line, i) => (
        <div key={`old-${i}`} className="px-1.5 py-px" style={{ color: COLORS.diffRemoved, background: COLORS.diffRemovedBg }}>
          <span className="sr-only">{asked ? t('tool.diff.askedOld') : t('tool.diff.removed')} </span>
          <span aria-hidden="true" className="mr-1">-</span><span {...DATA_EN}>{line || ' '}</span>
        </div>
      ))}
      {old.hidden > 0 && (
        <div className="px-1.5 py-px" style={{ color: COLORS.diffRemoved }}>{asked ? t('tool.diff.moreOldAsked', { n: old.hidden }) : t('tool.diff.moreRemoved', { n: old.hidden })}</div>
      )}
      {next.lines.map((line, i) => (
        <div key={`new-${i}`} className="px-1.5 py-px" style={{ color: COLORS.diffAdded, background: COLORS.diffAddedBg }}>
          <span className="sr-only">{asked ? t('tool.diff.askedNew') : t('tool.diff.added')} </span>
          <span aria-hidden="true" className="mr-1">+</span><span {...DATA_EN}>{line || ' '}</span>
        </div>
      ))}
      {next.hidden > 0 && (
        <div className="px-1.5 py-px" style={{ color: COLORS.diffAdded }}>{asked ? t('tool.diff.moreNewAsked', { n: next.hidden }) : t('tool.diff.moreAdded', { n: next.hidden })}</div>
      )}
    </div>
  )
}

const hiddenLines = (oldText: string, newText: string, max: number) =>
  truncateLines(oldText, max).hidden + truncateLines(newText, max).hidden

function EditContent({ data, compact, outcome }: { data: Record<string, unknown>; compact: boolean; outcome?: UnappliedOutcome }) {
  const [showAll, setShowAll] = useState(false)
  const filePath = String(data.file_path || '')
  const oldText = String(data.old_string || '')
  const newText = String(data.new_string || '')
  const base = compact ? 4 : 8
  const stats = editStats('Edit', data)

  return (
    <div>
      <FilePath path={filePath} />
      {stats && <EditSummary stats={stats} pairs={[{ old: oldText, next: newText }]} outcome={outcome} />}
      <DiffBlock oldText={oldText} newText={newText} maxLines={showAll ? Infinity : base} asked={outcome !== undefined} />
      <ShowAllToggle visible={hiddenLines(oldText, newText, base) > 0 || showAll} showAll={showAll} onToggle={() => setShowAll(v => !v)} />
    </div>
  )
}

/** Codex apply_patch: the raw patch text. Figures are counted only from a patch that was not cut. */
function PatchContent({ data, compact }: { data: Record<string, unknown>; compact: boolean }) {
  const [showAll, setShowAll] = useState(false)
  const { t } = useTool()
  const patch = typeof data.patch === 'string' ? data.patch : ''
  const stats = patchStats(data)
  if (!patch) return null
  const cut = patch.length >= PATCH_CAPTURE_LIMIT
  const body = truncateLines(patch.split('\n').filter(l => !/^\*\*\* (Begin|End) Patch/.test(l)).join('\n'), showAll ? Infinity : (compact ? 4 : 8))
  const files = stats?.files ?? []

  return (
    <div>
      {files.length > 0 && (
        <ul aria-label={t('tool.patch.files')} className="mb-1 list-none p-0 m-0 text-[11px] font-mono">
          {files.map(f => (
            <li key={`${f.op} ${f.path}`} title={f.path} className="truncate" style={{ color: COLORS.filePathInactive }}>
              <span {...DATA_EN} style={{ color: COLORS.contentDim }}>{f.op}</span>{' '}<span {...DATA_EN}>{f.path}</span>
            </li>
          ))}
        </ul>
      )}
      {stats && <EditSummary stats={{ added: stats.added, removed: stats.removed, blocks: null }} />}
      {cut && <div className="mb-1 text-[11px]" style={{ color: COLORS.contentDim }}>{t('tool.patch.cut', { n: PATCH_CAPTURE_LIMIT })}</div>}
      <div className="rounded overflow-hidden text-xs font-mono leading-snug" style={{ background: COLORS.codeBlockBg }}>
        {body.lines.map((line, i) => {
          const added = line.startsWith('+')
          const removed = line.startsWith('-')
          return (
            <div
              key={i}
              className="px-1.5 py-px whitespace-pre-wrap break-words"
              style={added ? { color: COLORS.diffAdded, background: COLORS.diffAddedBg } : removed ? { color: COLORS.diffRemoved, background: COLORS.diffRemovedBg } : { color: COLORS.contentDim }}
            >
              {added && <span className="sr-only">{t('tool.diff.added')} </span>}
              {removed && <span className="sr-only">{t('tool.diff.removed')} </span>}
              <span {...DATA_EN}>{line || ' '}</span>
            </div>
          )
        })}
        {body.hidden > 0 && <div className="px-1.5 py-px" style={{ color: COLORS.contentDim }}>{t('tool.moreLines', { n: body.hidden })}</div>}
      </div>
      <ShowAllToggle visible={body.hidden > 0 || showAll} showAll={showAll} onToggle={() => setShowAll(v => !v)} />
    </div>
  )
}

function MultiEditContent({ data, compact, outcome }: { data: Record<string, unknown>; compact: boolean; outcome?: UnappliedOutcome }) {
  const [showAll, setShowAll] = useState(false)
  const { t } = useTool()
  const filePath = String(data.file_path || '')
  const stats = editStats('MultiEdit', data)
  // editStats only returns stats when every block carries both strings
  const edits = stats ? (data.edits as Array<{ old_string: string; new_string: string }>) : []
  const base = compact ? 4 : 8

  return (
    <div>
      <FilePath path={filePath} />
      {stats && <EditSummary stats={stats} pairs={edits.map(e => ({ old: e.old_string, next: e.new_string }))} outcome={outcome} />}
      {edits.map((e, i) => (
        <div key={i} className={i > 0 ? 'mt-1.5' : undefined}>
          <div className="mb-0.5 text-[11px]" style={{ color: COLORS.contentDim }}>{t('tool.block', { i: i + 1, n: edits.length })}</div>
          <DiffBlock oldText={e.old_string} newText={e.new_string} maxLines={showAll ? Infinity : base} asked={outcome !== undefined} />
        </div>
      ))}
      <ShowAllToggle
        visible={showAll || edits.some(e => hiddenLines(e.old_string, e.new_string, base) > 0)}
        showAll={showAll}
        onToggle={() => setShowAll(v => !v)}
      />
    </div>
  )
}

const TODO_STATUS_KEY: Record<string, MessageKey> = {
  completed: 'tool.todo.completed',
  in_progress: 'tool.todo.in_progress',
  pending: 'tool.todo.pending',
}

function TodoContent({ data }: { data: Record<string, unknown> }) {
  const { t } = useTool()
  const todos = todoItems(data)
  if (!todos) return null
  const progress = todoProgress(data)

  return (
    <>
    {progress && (
      <div role="group" aria-label={t('tool.todo.progress')} className="mb-1 flex flex-wrap gap-x-2 text-[11px] font-mono" style={{ color: COLORS.contentDim }}>
        <span>{t('tool.todo.done', { done: progress.done, total: progress.total })}</span>
        {progress.active > 0 && <span>{t('tool.todo.active', { n: progress.active })}</span>}
      </div>
    )}
    <ul className="space-y-0.5 list-none p-0 m-0" aria-label={t('tool.todo.list')}>
      {todos.map((todo, i) => {
        const icon = todo.status === 'completed' ? <CheckIcon /> :
          todo.status === 'in_progress' ? '●' : '○'
        const color = todo.status === 'completed' ? COLORS.todoCompleted :
          todo.status === 'in_progress' ? COLORS.tool_calling : COLORS.todoPending
        const statusText = TODO_STATUS_KEY[todo.status] ? t(TODO_STATUS_KEY[todo.status]) : String(todo.status).replace(/_/g, ' ')

        return (
          <li key={i} className="flex items-start gap-1.5 text-xs font-mono">
            <span aria-hidden="true" style={{ color, flexShrink: 0 }}>{icon}</span>
            <span className="sr-only">{statusText}: </span>
            <span {...DATA_EN} style={{
              color: todo.status === 'completed' ? COLORS.todoCompletedText : COLORS.assistantText,
              textDecoration: todo.status === 'completed' ? 'line-through' : 'none',
            }}>
              {String(todo.content)}
            </span>
          </li>
        )
      })}
    </ul>
    </>
  )
}

/** A row of small labelled chips with a shape: the label is text, the icon is decoration. */
function Pills({ label, items }: { label: string; items: Array<{ key: string; icon: React.ReactNode; text: string }> }) {
  if (items.length === 0) return null
  return (
    <ul aria-label={label} className="mt-1 flex flex-wrap gap-1 list-none p-0 m-0">
      {items.map(it => (
        <li
          key={it.key}
          className="inline-flex items-center gap-1 rounded px-1.5 py-px text-[11px] font-mono"
          style={{ background: COLORS.codeBlockBg, color: COLORS.contentDim, border: `1px solid ${COLORS.resultBorder}` }}
        >
          {it.icon}
          <span {...DATA_EN}>{it.text}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * What a call's own output proves (#317): the PR / issue a gh call printed, as a link, or the file count
 * Grep / Glob reported. Text and shape (icon, underline) carry the meaning, never the color alone.
 */
export function ResultPillView({ pill, locale = 'en' }: { pill: ResultPill | null | undefined; locale?: Locale }) {
  if (!pill) return null
  const chip = 'inline-flex items-center gap-1 rounded px-1.5 py-px text-[11px] font-mono'
  const chipStyle = { background: COLORS.codeBlockBg, color: COLORS.contentDim, border: `1px solid ${COLORS.resultBorder}` }
  return (
    <ul aria-label={tr(locale, 'tool.result.summary')} className="mt-1 flex flex-wrap gap-1 list-none p-0 m-0">
      <li className={chip} style={chipStyle}>
        {pill.kind === 'link' ? (
          <a
            href={pill.link.url}
            target="_blank"
            rel="noopener noreferrer"
            title={pill.link.url}
            className={`inline-flex items-center gap-1 underline rounded ${FOCUS_RING_INSET}`}
            style={{ color: COLORS.textPrimary }}
          >
            <GhIcon size={11} />
            {pill.link.kind === 'pr' ? 'PR' : 'issue'} #{pill.link.number}
            <span className="sr-only">{tr(locale, 'tool.newTab')}</span>
          </a>
        ) : (
          <>
            <SearchIcon size={11} />
            {pluralText(locale, 'count.file', pill.files)}
          </>
        )}
      </li>
    </ul>
  )
}

function toolingIcon(kind: ToolingKind) {
  switch (kind) {
    case 'python': return <PythonIcon size={11} />
    case 'test': return <TestIcon size={11} />
    case 'docker': return <DockerIcon size={11} />
    case 'package': return <PackageIcon size={11} />
  }
}

function TaskContent({ data }: { data: Record<string, unknown> }) {
  const type = typeof data.subagent_type === 'string' ? data.subagent_type : ''
  const description = typeof data.description === 'string' ? data.description : ''
  if (!type && !description) return null
  return (
    <div {...DATA_EN} className="text-xs font-mono break-words">
      {type && <span className="mr-1.5 rounded px-1.5 py-px text-[11px]" style={{ background: COLORS.codeBlockBg, color: COLORS.tool_calling }}>{type}</span>}
      {description && <span style={{ color: COLORS.assistantText }}>{description}</span>}
    </div>
  )
}

function NotebookContent({ data }: { data: Record<string, unknown> }) {
  const path = String(data.notebook_path || '')
  const { cell, mode } = notebookCell(data)
  return (
    <div>
      <FilePath path={path} />
      {(cell || mode) && (
        <div {...DATA_EN} className="text-[11px] font-mono" style={{ color: COLORS.contentDim }}>
          {[cell, mode].filter(Boolean).join(', ')}
        </div>
      )}
    </div>
  )
}

function BashContent({ data, compact }: { data: Record<string, unknown>; compact: boolean }) {
  const { t } = useTool()
  const command = String(data.command || '')
  const description = String(data.description || '')
  const maxLen = compact ? 120 : 300
  const vcs = shellCommands(command)
  const tooling = toolingCommands(command)

  return (
    <div>
      {description && (
        <div {...DATA_EN} className="text-[11px] mb-1" style={{ color: COLORS.contentDim }}>{description}</div>
      )}
      <div className="rounded px-1.5 py-1 text-xs font-mono break-words" style={{ background: COLORS.codeBlockBg, color: COLORS.tool_calling }}>
        <span aria-hidden="true" className="mr-1" style={{ color: COLORS.contentDim }}>$</span>
        <ClampedText text={command} max={maxLen} />
      </div>
      <Pills
        label={t('tool.vcs')}
        items={vcs.map(c => ({ key: `${c.tool} ${c.sub}`, icon: c.tool === 'git' ? <GitIcon size={11} /> : <GhIcon size={11} />, text: `${c.tool} ${c.sub}` }))}
      />
      <Pills
        label={t('tool.tooling')}
        items={tooling.map(c => ({ key: `${c.kind} ${c.label}`, icon: toolingIcon(c.kind), text: c.label }))}
      />
    </div>
  )
}

function WriteContent({ data, compact }: { data: Record<string, unknown>; compact: boolean }) {
  const [showAll, setShowAll] = useState(false)
  const { locale } = useTool()
  const filePath = String(data.file_path || '')
  const t = truncateLines(String(data.content || ''), showAll ? Infinity : (compact ? 4 : 8))
  const stats = writeStats(data)

  return (
    <div>
      <FilePath path={filePath} />
      {stats && <div className="mb-1 text-[11px] font-mono" style={{ color: COLORS.contentDim }}>{toolLinesText(locale, stats.lines)}</div>}
      <div className="rounded px-1.5 py-1 text-xs font-mono leading-snug" style={{ background: COLORS.codeBlockBg, color: COLORS.contentDim }}>
        {t.lines.map((line, i) => (
          <div key={i} className={showAll ? 'whitespace-pre-wrap break-words' : 'truncate'} title={!showAll && line.length > 60 ? line : undefined}><span {...DATA_EN}>{line || ' '}</span></div>
        ))}
        {t.hidden > 0 && (
          <div>{tr(locale, 'tool.moreLines', { n: t.hidden })}</div>
        )}
      </div>
      <ShowAllToggle visible={t.hidden > 0 || showAll} showAll={showAll} onToggle={() => setShowAll(v => !v)} />
    </div>
  )
}

function ReadContent({ data }: { data: Record<string, unknown> }) {
  const { t } = useTool()
  const filePath = String(data.file_path || '')
  const range = readRange(data)

  return (
    <div>
      <FilePath path={filePath} />
      {range && (
        <div className="text-[11px]" style={{ color: COLORS.contentDim }}>
          {range.to == null ? t('tool.read.from', { from: range.from }) : t('tool.read.range', { from: range.from, to: range.to })}
        </div>
      )}
    </div>
  )
}

function GrepContent({ data }: { data: Record<string, unknown> }) {
  const { t } = useTool()
  const pattern = String(data.pattern || '')
  const searchPath = String(data.path || '')
  const glob = typeof data.glob === 'string' ? data.glob : undefined

  return (
    <div className="text-xs font-mono break-words">
      <span {...DATA_EN} style={{ color: COLORS.tool_calling }}>{pattern}</span>
      {searchPath && <span className="ml-1" style={{ color: COLORS.contentDim }} title={searchPath}>{t('tool.in', { path: truncatePath(searchPath, 2) })}</span>}
      {glob && <span {...DATA_EN} className="ml-1" style={{ color: COLORS.contentDim }}>({glob})</span>}
    </div>
  )
}

function GlobContent({ data }: { data: Record<string, unknown> }) {
  const { t } = useTool()
  const pattern = String(data.pattern || '')
  const searchPath = String(data.path || '')

  return (
    <div className="text-xs font-mono break-words">
      <span {...DATA_EN} style={{ color: COLORS.tool_calling }}>{pattern}</span>
      {searchPath && <span className="ml-1" style={{ color: COLORS.contentDim }} title={searchPath}>{t('tool.in', { path: truncatePath(searchPath, 2) })}</span>}
    </div>
  )
}

function WebSearchContent({ data }: { data: Record<string, unknown> }) {
  const { t } = useTool()
  const query = String(data.query || '')

  return (
    <div className="rounded px-1.5 py-1 text-xs font-mono flex items-center gap-1.5" style={{ background: COLORS.codeBlockBg }}>
      <span aria-hidden="true" style={{ color: COLORS.searchIcon }}><SearchIcon /></span>
      <span className="sr-only">{t('tool.webSearch')}</span>
      <span {...DATA_EN} style={{ color: COLORS.assistantText }}>{query}</span>
    </div>
  )
}

function WebFetchContent({ data }: { data: Record<string, unknown> }) {
  const { t } = useTool()
  const url = String(data.url || '')
  const prompt = String(data.prompt || '')
  const host = urlHost(url)

  return (
    <div>
      {host && <div {...DATA_EN} className="mb-1 text-[11px] font-mono" style={{ color: COLORS.contentDim }}>{host}</div>}
      <div className="rounded px-1.5 py-1 text-xs font-mono break-all" style={{ background: COLORS.codeBlockBg, color: COLORS.filePathActive }}>
        <span aria-hidden="true" className="mr-1"><GlobeIcon /></span><span className="sr-only">{t('tool.fetch')} </span>
        <ClampedText text={url} max={80} />
      </div>
      {prompt && (
        <div className="mt-1 text-[11px] break-words" style={{ color: COLORS.contentDim }}>
          <ClampedText text={prompt} max={120} />
        </div>
      )}
    </div>
  )
}

function AskUserContent({ data }: { data: Record<string, unknown> }) {
  const { t } = useTool()
  const questions = Array.isArray(data.questions) ? data.questions as Array<{ question?: string; options?: string[] }> : undefined
  if (!questions || questions.length === 0) return null

  return (
    <div className="space-y-1.5">
      {questions.map((q, i) => (
        <div key={i}>
          <div {...DATA_EN} className="text-xs font-mono mb-0.5" style={{ color: COLORS.tool_calling }}>
            {q.question}
          </div>
          {Array.isArray(q.options) && q.options.length > 0 && (
            <ul className="list-none p-0 m-0 text-xs font-mono" aria-label={t('tool.options')}>
              {q.options.map((opt, j) => (
                <li key={j} style={{ color: COLORS.contentDim }}>
                  <span aria-hidden="true">– </span><span {...DATA_EN}>{String(opt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}
