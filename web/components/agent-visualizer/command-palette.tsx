'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING } from '@/lib/focus-ring'
import { paletteGroupName, paletteStatus, searchPalette, type PaletteItem } from '@/lib/command-palette'
import { useLocale } from '@/lib/locale'
import { translate } from '@/lib/messages'
import { GlassCard } from './glass-card'
import { stopPropagationHandlers } from './shared-ui'
import { useModalDialog } from '@/hooks/use-modal-dialog'

export interface CommandPaletteProps {
  /** Whether the palette is open; renders nothing when false */
  open: boolean
  onClose: () => void
  /** Everything the palette can reach (see buildPaletteItems); only read while open */
  items: ReadonlyArray<PaletteItem>
}

/**
 * Modal command palette (Ctrl+K). A combobox with a listbox popup: focus stays in the search field,
 * the active option is named by aria-activedescendant, the result count is announced in a status line.
 * Escape closes it (and nothing else), focus returns to where it was unless the command moved it itself.
 */
export function CommandPalette({ open, onClose, items }: CommandPaletteProps) {
  const { locale } = useLocale()
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key)
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const skipRestoreRef = useRef(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const titleId = useId()
  const listId = useId()
  const optionPrefix = useId()

  useEffect(() => {
    if (!open) return
    skipRestoreRef.current = false
    setQuery('')
    setActiveId(null)
  }, [open])

  // Focus in the search field on open, back where it was on close unless the command moved it itself. The search field is
  // the only stop (the options are reached with the arrows): Tab is held, never wraps (#507).
  const modal = useModalDialog({
    open,
    dialogRef,
    onClose: () => onCloseRef.current(),
    initialFocus: () => inputRef.current,
    shouldRestoreFocus: () => !skipRestoreRef.current,
    tab: 'hold',
  })

  const sections = useMemo(() => (open ? searchPalette(items, query) : []), [open, items, query])
  const flat = useMemo(() => sections.flatMap(s => s.items), [sections])
  // The active option is tracked by id, so live updates of the lists do not move the highlight to another entry
  const activeIndex = Math.max(0, flat.findIndex(i => i.id === activeId))
  const active = flat[activeIndex]
  const optionDomId = (item: PaletteItem) => `${optionPrefix}-${item.id}`
  const activeDomId = active ? optionDomId(active) : undefined

  useEffect(() => {
    if (open && activeDomId) document.getElementById(activeDomId)?.scrollIntoView?.({ block: 'nearest' })
  }, [open, activeDomId])

  if (!open) return null

  const run = (item: PaletteItem) => {
    skipRestoreRef.current = item.movesFocus
    onCloseRef.current()
    item.run()
  }

  const move = (delta: number) => {
    if (flat.length === 0) return
    setActiveId(flat[(activeIndex + delta + flat.length) % flat.length].id)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Ctrl+K (Cmd+K) closes it as Escape does
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      e.stopPropagation()
      onCloseRef.current()
      return
    }
    // Escape and Tab
    if (modal.onKeyDown(e)) return
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
    else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (active) run(active)
    }
  }

  return (
    <div
      {...stopPropagationHandlers}
      role="presentation"
      lang={locale}
      className="fixed inset-0 flex items-start justify-center p-3 pt-[12vh]"
      style={{ zIndex: Z.contextMenu + 1, background: 'var(--lens-scrim)' }}
      onMouseDown={e => { e.stopPropagation(); if (e.target === e.currentTarget) onClose() }}
      onKeyDown={onKeyDown}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="max-h-[calc(100vh-24px)] w-[520px] max-w-[calc(100vw-24px)] outline-none"
      >
        <GlassCard visible={true}>
          <h2 id={titleId} className="sr-only">{t('palette.title')}</h2>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label={t('palette.search')}
            aria-expanded={true}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeDomId}
            autoComplete="off"
            spellCheck={false}
            placeholder={t('palette.search')}
            value={query}
            onChange={e => { setQuery(e.target.value); setActiveId(null) }}
            className={`mb-2 w-full min-h-8 rounded px-2 py-1 text-xs font-mono ${FOCUS_RING}`}
            style={{ background: COLORS.toggleInactive, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
          />

          <div id={listId} role="listbox" aria-label={t('palette.results')} className="max-h-[50vh] overflow-y-auto">
            {sections.map(section => (
              <div key={section.group} role="group" aria-label={paletteGroupName(section.group, locale)} className="mb-1">
                <div aria-hidden="true" className="px-2 pt-1 pb-0.5 text-[11px] font-mono uppercase tracking-wider" style={{ color: COLORS.textMuted }}>
                  {paletteGroupName(section.group, locale)}
                </div>
                {section.items.map(item => {
                  const selected = item === active
                  return (
                    <div
                      key={item.id}
                      id={optionDomId(item)}
                      role="option"
                      aria-selected={selected}
                      aria-keyshortcuts={item.shortcut}
                      tabIndex={-1}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); run(item) } }}
                      onMouseDown={e => e.preventDefault()}
                      onMouseMove={() => { if (!selected) setActiveId(item.id) }}
                      onClick={() => run(item)}
                      className="flex cursor-pointer items-center justify-between gap-3 rounded px-2 py-1 text-xs font-mono"
                      style={{
                        color: COLORS.textPrimary,
                        background: selected ? COLORS.holoBg10 : 'transparent',
                        border: selected ? '1px solid var(--lens-focus)' : '1px solid transparent',
                      }}
                    >
                      <span className="min-w-0 truncate" data-sensitive={item.sensitive ? '' : undefined}>
                        {item.label}
                        {item.detail && <span style={{ color: COLORS.textMuted }}> ({item.detail})</span>}
                      </span>
                      {item.shortcut && (
                        <kbd
                          aria-hidden="true"
                          className="shrink-0 min-w-6 rounded px-1.5 py-0.5 text-center text-[11px]"
                          style={{ background: COLORS.holoBg10, border: `1px solid ${COLORS.glassBorder}`, color: COLORS.textPrimary }}
                        >
                          {item.shortcut === 'Space' ? t('palette.key.space') : item.shortcut === 'Shift+F' ? t('palette.key.shiftF') : item.shortcut}
                        </kbd>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>

          <div role="status" className="mt-2 border-t pt-2 text-[11px] font-mono" style={{ borderColor: COLORS.glassBorder, color: COLORS.textMuted }}>
            {paletteStatus(sections, locale)}
          </div>
          <div aria-hidden="true" className="mt-1 text-[11px] font-mono" style={{ color: COLORS.textMuted }}>
            {t('palette.hint')}
          </div>
        </GlassCard>
      </div>
    </div>
  )
}
