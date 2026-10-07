'use client'

import { createContext, useContext, useState } from 'react'
import { COLORS } from '@/lib/colors'
import { truncatePath } from '@/lib/utils'
import { truncateWithMarker, truncateLines, FOCUS_RING } from '@/lib/feed-utils'
import { SearchIcon, GlobeIcon, CheckIcon } from './feed-icons'

// Context for file-open callback — provided by parent components
type OpenFileCallback = (filePath: string, line?: number) => void
const OpenFileContext = createContext<OpenFileCallback | null>(null)
export const OpenFileProvider = OpenFileContext.Provider

interface ToolContentRendererProps {
  toolName: string
  inputData?: Record<string, unknown>
  args?: string
  compact?: boolean  // shorter rendering for inline chat
}

export function ToolContentRenderer({ toolName, inputData, args, compact = false }: ToolContentRendererProps) {
  if (!inputData) {
    return <span style={{ color: COLORS.contentDim }}>{args || toolName}</span>
  }

  switch (toolName) {
    case 'Edit':
      return <EditContent data={inputData} compact={compact} />
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
    default:
      return <span style={{ color: COLORS.contentDim }}>{args || toolName}</span>
  }
}

/** Text clamped to `max` chars with a '… (+N chars)' marker and a 'Show all' toggle. */
function ClampedText({ text, max }: { text: string; max: number }) {
  const [showAll, setShowAll] = useState(false)
  const t = truncateWithMarker(text, max)
  return (
    <>
      {showAll ? text : t.text}
      {t.hidden > 0 && !showAll && <span style={{ color: COLORS.textMuted }}>{t.marker}</span>}
      {t.hidden > 0 && (
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll(v => !v)}
          className={`ml-1.5 min-h-6 px-1 rounded text-[11px] underline ${FOCUS_RING}`}
          style={{ color: COLORS.textMuted }}
        >
          {showAll ? 'Show less' : 'Show all'}
        </button>
      )}
    </>
  )
}

function ShowAllToggle({ visible, showAll, onToggle }: { visible: boolean; showAll: boolean; onToggle: () => void }) {
  if (!visible) return null
  return (
    <button
      type="button"
      aria-expanded={showAll}
      onClick={onToggle}
      className={`mt-0.5 min-h-6 px-1 rounded text-[11px] underline ${FOCUS_RING}`}
      style={{ color: COLORS.textMuted }}
    >
      {showAll ? 'Show less' : 'Show all'}
    </button>
  )
}

function FilePath({ path: filePath }: { path: string }) {
  const openFile = useContext(OpenFileContext)
  if (!filePath) return null
  const short = truncatePath(filePath)
  if (!openFile) {
    return (
      <div className="text-[11px] mb-1 truncate" style={{ color: COLORS.filePathInactive }} title={filePath}>
        {short}
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={() => openFile(filePath)}
      title={filePath}
      aria-label={`Open ${filePath}`}
      className={`block max-w-full min-h-6 mb-1 text-left text-[11px] truncate rounded hover:underline ${FOCUS_RING}`}
      style={{ color: COLORS.filePathActive }}
    >
      {short}
    </button>
  )
}

function EditContent({ data, compact }: { data: Record<string, unknown>; compact: boolean }) {
  const [showAll, setShowAll] = useState(false)
  const filePath = String(data.file_path || '')
  const maxLines = showAll ? Infinity : (compact ? 4 : 8)
  const old = truncateLines(String(data.old_string || ''), maxLines)
  const next = truncateLines(String(data.new_string || ''), maxLines)
  const hiddenTotal = old.hidden + next.hidden

  return (
    <div>
      <FilePath path={filePath} />
      <div className="rounded overflow-hidden text-xs font-mono leading-snug" style={{ background: COLORS.codeBlockBg }}>
        {old.lines.map((line, i) => (
          <div key={`old-${i}`} className="px-1.5 py-px" style={{ color: COLORS.diffRemoved, background: COLORS.diffRemovedBg }}>
            <span className="sr-only">Removed: </span>
            <span aria-hidden="true" className="mr-1">-</span>{line || ' '}
          </div>
        ))}
        {old.hidden > 0 && (
          <div className="px-1.5 py-px" style={{ color: COLORS.diffRemoved }}>… (+{old.hidden} lines removed)</div>
        )}
        {next.lines.map((line, i) => (
          <div key={`new-${i}`} className="px-1.5 py-px" style={{ color: COLORS.diffAdded, background: COLORS.diffAddedBg }}>
            <span className="sr-only">Added: </span>
            <span aria-hidden="true" className="mr-1">+</span>{line || ' '}
          </div>
        ))}
        {next.hidden > 0 && (
          <div className="px-1.5 py-px" style={{ color: COLORS.diffAdded }}>… (+{next.hidden} lines added)</div>
        )}
      </div>
      <ShowAllToggle visible={hiddenTotal > 0 || showAll} showAll={showAll} onToggle={() => setShowAll(v => !v)} />
    </div>
  )
}

interface TodoItem {
  content: string
  status: string
  activeForm?: string
}

function isTodoArray(v: unknown): v is TodoItem[] {
  return Array.isArray(v) && v.every(t => t && typeof t === 'object' && 'content' in t)
}

const TODO_STATUS_TEXT: Record<string, string> = {
  completed: 'Completed',
  in_progress: 'In progress',
  pending: 'Pending',
}

function TodoContent({ data }: { data: Record<string, unknown> }) {
  if (!isTodoArray(data.todos)) return null
  const todos = data.todos

  return (
    <ul className="space-y-0.5 list-none p-0 m-0" aria-label="Todo list">
      {todos.map((todo, i) => {
        const icon = todo.status === 'completed' ? <CheckIcon /> :
          todo.status === 'in_progress' ? '●' : '○'
        const color = todo.status === 'completed' ? COLORS.todoCompleted :
          todo.status === 'in_progress' ? COLORS.tool_calling : COLORS.todoPending
        const statusText = TODO_STATUS_TEXT[todo.status] ?? String(todo.status).replace(/_/g, ' ')

        return (
          <li key={i} className="flex items-start gap-1.5 text-xs font-mono">
            <span aria-hidden="true" style={{ color, flexShrink: 0 }}>{icon}</span>
            <span className="sr-only">{statusText}: </span>
            <span style={{
              color: todo.status === 'completed' ? COLORS.todoCompletedText : COLORS.assistantText,
              textDecoration: todo.status === 'completed' ? 'line-through' : 'none',
            }}>
              {String(todo.content)}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function BashContent({ data, compact }: { data: Record<string, unknown>; compact: boolean }) {
  const command = String(data.command || '')
  const description = String(data.description || '')
  const maxLen = compact ? 120 : 300

  return (
    <div>
      {description && (
        <div className="text-[11px] mb-1" style={{ color: COLORS.contentDim }}>{description}</div>
      )}
      <div className="rounded px-1.5 py-1 text-xs font-mono break-words" style={{ background: COLORS.codeBlockBg, color: COLORS.tool_calling }}>
        <span aria-hidden="true" className="mr-1" style={{ color: COLORS.contentDim }}>$</span>
        <ClampedText text={command} max={maxLen} />
      </div>
    </div>
  )
}

function WriteContent({ data, compact }: { data: Record<string, unknown>; compact: boolean }) {
  const [showAll, setShowAll] = useState(false)
  const filePath = String(data.file_path || '')
  const t = truncateLines(String(data.content || ''), showAll ? Infinity : (compact ? 4 : 8))

  return (
    <div>
      <FilePath path={filePath} />
      <div className="rounded px-1.5 py-1 text-xs font-mono leading-snug" style={{ background: COLORS.codeBlockBg, color: COLORS.contentDim }}>
        {t.lines.map((line, i) => (
          <div key={i} className={showAll ? 'whitespace-pre-wrap break-words' : 'truncate'} title={!showAll && line.length > 60 ? line : undefined}>{line || ' '}</div>
        ))}
        {t.hidden > 0 && (
          <div>… (+{t.hidden} lines)</div>
        )}
      </div>
      <ShowAllToggle visible={t.hidden > 0 || showAll} showAll={showAll} onToggle={() => setShowAll(v => !v)} />
    </div>
  )
}

function ReadContent({ data }: { data: Record<string, unknown> }) {
  const filePath = String(data.file_path || '')
  const offset = typeof data.offset === 'number' ? data.offset : undefined
  const limit = typeof data.limit === 'number' ? data.limit : undefined

  return (
    <div>
      <FilePath path={filePath} />
      {(offset != null || limit != null) && (
        <div className="text-[11px]" style={{ color: COLORS.contentDim }}>
          {offset ? `from line ${offset}` : ''}{offset && limit ? ', ' : ''}{limit ? `${limit} lines` : ''}
        </div>
      )}
    </div>
  )
}

function GrepContent({ data }: { data: Record<string, unknown> }) {
  const pattern = String(data.pattern || '')
  const searchPath = String(data.path || '')
  const glob = typeof data.glob === 'string' ? data.glob : undefined

  return (
    <div className="text-xs font-mono break-words">
      <span style={{ color: COLORS.tool_calling }}>{pattern}</span>
      {searchPath && <span className="ml-1" style={{ color: COLORS.contentDim }} title={searchPath}>in {truncatePath(searchPath, 2)}</span>}
      {glob && <span className="ml-1" style={{ color: COLORS.contentDim }}>({glob})</span>}
    </div>
  )
}

function GlobContent({ data }: { data: Record<string, unknown> }) {
  const pattern = String(data.pattern || '')
  const searchPath = String(data.path || '')

  return (
    <div className="text-xs font-mono break-words">
      <span style={{ color: COLORS.tool_calling }}>{pattern}</span>
      {searchPath && <span className="ml-1" style={{ color: COLORS.contentDim }} title={searchPath}>in {truncatePath(searchPath, 2)}</span>}
    </div>
  )
}

function WebSearchContent({ data }: { data: Record<string, unknown> }) {
  const query = String(data.query || '')

  return (
    <div className="rounded px-1.5 py-1 text-xs font-mono flex items-center gap-1.5" style={{ background: COLORS.codeBlockBg }}>
      <span aria-hidden="true" style={{ color: COLORS.searchIcon }}><SearchIcon /></span>
      <span className="sr-only">Web search:</span>
      <span style={{ color: COLORS.assistantText }}>{query}</span>
    </div>
  )
}

function WebFetchContent({ data }: { data: Record<string, unknown> }) {
  const url = String(data.url || '')
  const prompt = String(data.prompt || '')

  return (
    <div>
      <div className="rounded px-1.5 py-1 text-xs font-mono break-all" style={{ background: COLORS.codeBlockBg, color: COLORS.filePathActive }}>
        <span aria-hidden="true" className="mr-1"><GlobeIcon /></span><span className="sr-only">Fetch: </span>
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
  const questions = Array.isArray(data.questions) ? data.questions as Array<{ question?: string; options?: string[] }> : undefined
  if (!questions || questions.length === 0) return null

  return (
    <div className="space-y-1.5">
      {questions.map((q, i) => (
        <div key={i}>
          <div className="text-xs font-mono mb-0.5" style={{ color: COLORS.tool_calling }}>
            {q.question}
          </div>
          {Array.isArray(q.options) && q.options.length > 0 && (
            <ul className="list-none p-0 m-0 text-xs font-mono" aria-label="Options">
              {q.options.map((opt, j) => (
                <li key={j} style={{ color: COLORS.contentDim }}>
                  <span aria-hidden="true">– </span>{String(opt)}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}
