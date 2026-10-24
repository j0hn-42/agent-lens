'use client'

// Agent picker of the Conversation panel (owner's request, option B): from AGENT_PICKER_MIN agents with messages, one
// button "Agent: All (83)" replaces the row of tabs that scrolled sideways. It opens, inside the panel, a search field
// (combobox) over a listbox grouped by team / workflow, by session and with the finished agents apart (folded when many).
// The unread agents are said in words in their option and counted in a pill beside the button. The list pushes the
// message list down instead of covering it, so nothing it holds or the focus can hide behind it (WCAG 2.4.11).

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Agent, TeamSummary } from '@/lib/agent-types'
import { COLORS, getStateColor } from '@/lib/colors'
import {
  agentNameOf, agentPickerGroups, filterPickerIds, doneCollapsedByDefault, isAgentDone, type PickerGroup,
} from '@/lib/feed-utils'
import { FOCUS_RING, FOCUS_RING_INSET } from '@/lib/focus-ring'
import { TOUCH_TARGET } from '@/lib/mobile-view'
import { useLocale } from '@/lib/locale'
import type { Locale } from '@/lib/messages'
import { stateText } from '@/lib/card-text'
import { DATA_EN, t as tr, pluralCountText, formatCount, messageCountText } from '@/lib/panel-text'
import { ChevronIcon } from './feed-icons'

export interface AgentPickerProps {
  /** Agents with messages, in panel order (main first, then by name) */
  ids: readonly string[]
  agents: ReadonlyMap<string, Agent>
  teams?: ReadonlyMap<string, TeamSummary>
  /** 'all' or the agent key whose messages are listed */
  activeKey: string
  unread: ReadonlySet<string>
  messageCounts: ReadonlyMap<string, number>
  totalMessages: number
  /** Choose an option; `shift` is the pair shortcut (Shift-click / Shift+Enter), as on a tab */
  onPick: (key: string, shift: boolean) => void
  /** Controls placed after the button on the same row (the "Filter pair" button) */
  children?: React.ReactNode
  /** Told when the list opens or closes (the panel folds its Teams block while the list is open, to give it the height) */
  onOpenChange?: (open: boolean) => void
}

/** "(Thinking)" or "(done)": the state of an agent as the tabs say it */
function stateLabelOf(locale: Locale, agent: Agent | undefined): string {
  // Capitalised like the other states (« Inactif », « Réflexion »): « conv.tab.done » is also a lower-case tab word (#613)
  if (!isAgentDone(agent)) return stateText(locale, agent?.state ?? 'idle')
  const done = tr(locale, 'conv.tab.done')
  return done.charAt(0).toLocaleUpperCase(locale) + done.slice(1)
}

function groupLabel(locale: Locale, g: PickerGroup): string {
  const n = formatCount(locale, g.ids.length)
  if (g.kind === 'done') return tr(locale, 'conv.picker.group.done', { n })
  // The 'active' group holds the agents of no team (finished ones go to 'done'): its label says « No team », since the
  // unfinished agents of a team or workflow are counted in their own group
  if (g.kind === 'active') return tr(locale, 'conv.picker.group.noTeam', { n })
  if (g.kind === 'session') return tr(locale, 'conv.picker.group.session', { label: g.name, n })
  // The team or workflow name, then the start of the lead session id when two groups share a name (as the Teams block says it)
  const name = g.sessionHint ? `${g.name} ${tr(locale, 'conv.team.sessionHint', { id: g.sessionHint })}` : g.name
  return tr(locale, g.kind === 'workflow' ? 'conv.picker.group.workflow' : 'conv.picker.group.team', { name, n })
}

const ROW = `min-h-7 ${TOUCH_TARGET}`

export function AgentPicker({ ids, agents, teams, activeKey, unread, messageCounts, totalMessages, onPick, children, onOpenChange }: AgentPickerProps) {
  const { locale } = useLocale()
  const t = (key: Parameters<typeof tr>[1], params?: Parameters<typeof tr>[2]) => tr(locale, key, params)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [doneOpen, setDoneOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const baseId = useId()
  const listId = `${baseId}-list`
  const popupId = `${baseId}-popup`
  const hintId = `${baseId}-hint`
  const doneGroupId = `${baseId}-done`
  const optionDomId = (key: string) => `${baseId}-opt-${key.replace(/[^\w-]/g, '_')}`

  const unreadIds = useMemo(() => ids.filter(id => unread.has(id)), [ids, unread])
  const allGroups = useMemo(() => agentPickerGroups(ids, agents, teams), [ids, agents, teams])
  const doneTotal = allGroups.find(g => g.kind === 'done')?.ids.length ?? 0
  const searching = query.trim() !== ''
  const groups = useMemo(
    () => (open ? agentPickerGroups(filterPickerIds(ids, agents, { query, unreadOnly, unread }), agents, teams) : []),
    [open, ids, agents, teams, query, unreadOnly, unread],
  )
  // While searching or listing the unread agents, finished matches are shown: a search never hides what it found
  const showDone = doneOpen || searching || unreadOnly
  const shownGroups = groups.filter(g => g.kind !== 'done' || showDone)
  const showAll = !searching && !unreadOnly
  const flat = [...(showAll ? ['all'] : []), ...shownGroups.flatMap(g => g.ids)]
  const shownAgents = flat.length - (showAll ? 1 : 0)
  const active = flat.includes(activeId ?? '') ? activeId! : flat[0]
  const activeDomId = active !== undefined ? optionDomId(active) : undefined

  const openList = (onlyUnread: boolean) => {
    const activeAgent = activeKey === 'all' ? undefined : agents.get(activeKey)
    setQuery('')
    setUnreadOnly(onlyUnread)
    setDoneOpen(!doneCollapsedByDefault(doneTotal, activeKey !== 'all' && isAgentDone(activeAgent)))
    setActiveId(onlyUnread ? null : activeKey)
    setOpen(true)
  }
  const close = (returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) buttonRef.current?.focus()
  }
  const pick = (key: string, shift: boolean) => {
    onPick(key, shift)
    close(true)
  }

  useEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true })
  }, [open])
  const onOpenChangeRef = useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange
  useEffect(() => { onOpenChangeRef.current?.(open) }, [open])
  useEffect(() => () => onOpenChangeRef.current?.(false), [])
  // The active option (on opening: the current choice, even one picked on the canvas) is brought into the list's view
  // Also when its group changes with no change of option: live, the agent of the active option finishes and its option
  // moves to the Finished group (#613). Not on every shift of the list (a new agent above it), which would pull the
  // list back to the option while the reader looks elsewhere in it.
  const activeGroup = shownGroups.find(g => active !== undefined && g.ids.includes(active))?.kind ?? ''
  useEffect(() => {
    if (open && activeDomId) document.getElementById(activeDomId)?.scrollIntoView?.({ block: 'nearest' })
  }, [open, activeDomId, activeGroup])
  // A click outside closes the list (focus stays where the click put it)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const move = (delta: number) => {
    if (flat.length === 0) return
    const i = Math.max(0, flat.indexOf(active))
    setActiveId(flat[(i + delta + flat.length) % flat.length])
  }

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
    else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (active !== undefined) pick(active, e.shiftKey)
    }
  }

  // Escape anywhere in the open list closes it and gives focus back to the button (the panel stays open); Tab past the last
  // control of the list leaves it: the list closes and focus goes where Tab took it
  useEffect(() => {
    const root = rootRef.current
    if (!open || !root) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      buttonRef.current?.focus()
    }
    const onFocusOut = (e: FocusEvent) => {
      if (e.relatedTarget instanceof Node && !root.contains(e.relatedTarget)) setOpen(false)
    }
    root.addEventListener('keydown', onKey)
    root.addEventListener('focusout', onFocusOut)
    return () => { root.removeEventListener('keydown', onKey); root.removeEventListener('focusout', onFocusOut) }
  }, [open])

  const activeAgent = activeKey === 'all' ? undefined : agents.get(activeKey)
  const activeName = activeKey === 'all' ? null : agentNameOf(agents, activeKey)

  const optionRow = (key: string) => {
    const isAll = key === 'all'
    const agent = isAll ? undefined : agents.get(key)
    const name = isAll ? t('conv.picker.all', { n: formatCount(locale, ids.length) }) : agentNameOf(agents, key)
    const color = isAll ? COLORS.holoBase : (agent ? getStateColor(agent.state) : COLORS.idle)
    const done = !isAll && isAgentDone(agent)
    const count = isAll ? totalMessages : (messageCounts.get(key) ?? 0)
    const isActive = key === active
    const isCurrent = key === activeKey
    const hasUnread = !isAll && unread.has(key)
    return (
      <div
        key={key}
        id={optionDomId(key)}
        role="option"
        aria-selected={isActive}
        // Not a tab stop: the search field keeps the focus and names the active option (aria-activedescendant)
        tabIndex={-1}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); pick(key, e.shiftKey) } }}
        onMouseDown={e => e.preventDefault()}
        onMouseMove={() => { if (!isActive) setActiveId(key) }}
        onClick={e => pick(key, e.shiftKey)}
        title={isAll ? undefined : name}
        // Text that flows (a long name wraps under its dot instead of pushing it onto a line of its own); the check mark sits on the right
        className={`relative flex items-center pl-2 pr-6 py-1 ${ROW} rounded cursor-pointer text-xs font-mono`}
        style={{
          color: isCurrent ? color : COLORS.textPrimary,
          background: isActive ? COLORS.holoBg10 : 'transparent',
          // The active option is the visible focus of the list (aria-activedescendant): drawn with the focus token (WCAG 2.4.7)
          border: isActive ? '1px solid var(--lens-focus)' : '1px solid transparent',
          fontWeight: isCurrent ? 600 : undefined,
        }}
      >
        <span className="min-w-0 break-words">
        {!isAll && <span aria-hidden="true" className="inline-block w-2 h-2 mr-1.5 rounded-full align-middle" style={{ background: color, opacity: done ? 0.5 : 1 }} />}
        {isAll ? <span>{name}</span> : <span {...DATA_EN}>{name}</span>}
        {/* The spaces are text nodes between the pieces, so the accessible name keeps them (2.5.3: the name reads as shown) */}
        {!isAll && <>{' '}<span>(<span>{stateLabelOf(locale, agent)}</span>)</span></>}
        {count > 0 && <>{' '}<span style={{ color: COLORS.textMuted }}>{messageCountText(locale, count)}</span></>}
        {/* The count is the agent's total of messages; how many are unread is not known here, so the words that follow carry
            no number (« 5 messages, dont des non lus », never « 5 messages non lus ») */}
        {hasUnread && <span className="font-semibold" style={{ color: COLORS.textPrimary }}>
          {count > 0 ? t('conv.picker.someUnread') : <>{' '}{t('conv.tab.unread')}</>}
          <span aria-hidden="true" className="inline-block w-1.5 h-1.5 rounded-full ml-1 align-middle" style={{ background: COLORS.unreadDot }} />
        </span>}
        </span>
        {isCurrent && <><span aria-hidden="true" className="absolute right-2">✓</span><span className="sr-only">{t('conv.picker.current')}</span></>}
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      data-agent-picker=""
      // The open list takes at most 70 % of the panel height, or 16rem when 70 % is less (a short panel: 640x400, i.e. 1280x800
      // at 200 %, left a 230 px panel and a 15 px list, WCAG 1.4.10). It may then shrink to the room left, never below the
      // listbox's own minimum (three options): past that the open area scrolls vertically as a whole, so no option is lost
      className={`flex flex-col min-h-0 px-2 pt-1.5 pb-1.5 ${open ? 'flex-shrink overflow-y-auto' : 'flex-shrink-0'}`}
      style={{
        maxHeight: open ? 'max(70%, 16rem)' : undefined,
        borderBottom: `1px solid ${COLORS.holoBorder06}`,
        scrollbarWidth: 'thin', scrollbarColor: `${COLORS.scrollbarThumb} transparent`,
      }}
    >
      <div className="flex flex-wrap items-center gap-1">
        <button
          ref={buttonRef}
          type="button"
          data-agent-picker-button=""
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? popupId : undefined}
          title={activeName ?? undefined}
          onClick={() => (open ? close(false) : openList(false))}
          onKeyDown={e => { if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); openList(false) } }}
          // Grows to the row; at 320 px it shares it with Filter pair (a second row would leave the open list no height)
          className={`flex-[1_1_9rem] min-w-0 inline-flex items-center gap-1 px-2 ${ROW} rounded-md text-xs font-mono text-left ${FOCUS_RING_INSET}`}
          style={{ background: COLORS.holoBg05, color: COLORS.textPrimary, border: `1px solid ${COLORS.controlBorder}` }}
        >
          {/* Text that flows: a long agent name wraps onto a second line instead of being cut by an ellipsis */}
          <span className="min-w-0 break-words">
            <span style={{ color: COLORS.textMuted }}>{t('conv.picker.button')}</span>
            {' '}
            {activeName === null
              ? <span className="font-semibold">{t('conv.picker.all', { n: formatCount(locale, ids.length) })}</span>
              : <span className="font-semibold" {...DATA_EN}>{activeName}</span>}
            {activeName !== null && <>{' '}<span>(<span>{stateLabelOf(locale, activeAgent)}</span>)</span></>}
          </span>
          <span aria-hidden="true" className="ml-auto shrink-0" style={{ color: COLORS.textMuted }}><ChevronIcon direction={open ? 'up' : 'down'} size={10} /></span>
        </button>
        {unreadIds.length > 0 && (
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open && unreadOnly}
            onClick={() => (open && unreadOnly ? close(false) : openList(true))}
            className={`shrink-0 inline-flex items-center gap-1 px-2 ${ROW} rounded-full text-2xs font-mono font-semibold ${FOCUS_RING_INSET}`}
            style={{ color: COLORS.textPrimary, border: `1px solid ${COLORS.controlBorder}` }}
          >
            <span aria-hidden="true" className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: COLORS.unreadDot }} />
            {pluralCountText(locale, 'conv.picker.unread', unreadIds.length)}
          </button>
        )}
        {children}
      </div>

      {open && (
        // Shrinks with the open area down to its search row, three options, a group heading and the count line (an explicit minimum: the automatic
        // one would be the whole list, so the listbox would never scroll); below that the open area scrolls instead
        <div id={popupId} className="mt-1.5 flex flex-col min-h-[11.75rem] max-md:min-h-[15.25rem] rounded" style={{ border: `1px solid ${COLORS.controlBorder}`, background: COLORS.panelBg }}>
          <div className="flex flex-wrap items-center gap-1 p-1.5">
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-label={t('conv.picker.search')}
              aria-expanded={true}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeDomId}
              aria-describedby={hintId}
              autoComplete="off"
              spellCheck={false}
              placeholder={t('conv.picker.search')}
              value={query}
              onChange={e => { setQuery(e.target.value); setActiveId(null) }}
              onKeyDown={onInputKeyDown}
              className={`flex-[1_1_8rem] min-w-0 px-2 py-1 ${ROW} rounded text-xs font-mono placeholder:text-[color:var(--ph)] ${FOCUS_RING}`}
              style={{ background: COLORS.holoBg05, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary, ['--ph' as string]: COLORS.textMuted }}
            />
            {(unreadIds.length > 0 || unreadOnly) && (
              <button
                type="button"
                aria-pressed={unreadOnly}
                onClick={() => { setUnreadOnly(v => !v); setActiveId(null) }}
                className={`shrink-0 px-2 ${ROW} rounded text-2xs font-mono ${FOCUS_RING_INSET}`}
                style={{ background: unreadOnly ? COLORS.toggleActive : 'transparent', color: unreadOnly ? COLORS.assistantText : COLORS.textMuted, border: `1px solid ${COLORS.controlBorder}` }}
              >
                {t('conv.picker.unreadOnly')}
              </button>
            )}
            {doneTotal > 0 && !searching && !unreadOnly && (
              <button
                type="button"
                aria-expanded={doneOpen}
                aria-controls={doneOpen ? doneGroupId : undefined}
                onClick={() => setDoneOpen(v => !v)}
                className={`shrink-0 inline-flex items-center gap-1 px-2 ${ROW} rounded text-2xs font-mono ${FOCUS_RING_INSET}`}
                style={{ color: COLORS.textMuted, border: `1px solid ${COLORS.controlBorder}` }}
              >
                <ChevronIcon direction={doneOpen ? 'up' : 'down'} size={10} />
                {/* Its state is aria-expanded and the chevron; the name is the visible text, short enough to share the row with the search */}
                {t('conv.picker.group.done', { n: formatCount(locale, doneTotal) })}
              </button>
            )}
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label={t('conv.picker.list')}
            // At least three options high (28 px, 44 px under 768 px) plus a group heading, however short the panel: a list one can
            // browse, not a sliver (640x400 left it 15 px high before). Under 768 px 160 px, not 152: with the active option at an edge,
            // a heading and two more whole options still fit (153 px showed two when a heading was in view)
            className="flex-1 min-h-[6.5rem] max-md:min-h-[10rem] overflow-y-auto px-1.5 pb-1"
            style={{ scrollbarWidth: 'thin', scrollbarColor: `${COLORS.scrollbarThumb} transparent` }}
          >
            {showAll && optionRow('all')}
            {shownGroups.map(g => (
              <div key={g.key} id={g.kind === 'done' ? doneGroupId : undefined} role="group" aria-label={groupLabel(locale, g)} className="mt-1">
                <div aria-hidden="true" className="px-2 pt-0.5 text-2xs font-mono font-semibold tracking-wider" style={{ color: COLORS.panelLabel }}>
                  {groupLabel(locale, g)}
                </div>
                {g.ids.map(optionRow)}
              </div>
            ))}
            {flat.length === 0 && (
              <p className="m-0 px-2 py-2 text-2xs font-mono" style={{ color: COLORS.textMuted }}>{t('conv.picker.none')}</p>
            )}
          </div>
          <div className="px-2 py-1 text-2xs font-mono" style={{ borderTop: `1px solid ${COLORS.holoBorder06}`, color: COLORS.textMuted }}>
            <p role="status" className="m-0">{pluralCountText(locale, 'conv.picker.count', shownAgents, { total: ids.length })}</p>
            <p id={hintId} className="m-0 max-md:hidden">{t('conv.picker.hint')}</p>
          </div>
        </div>
      )}
    </div>
  )
}
