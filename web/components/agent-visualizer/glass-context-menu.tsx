'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Z, TIMING } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { GlassCard } from './glass-card'
import { useClickOutside } from '@/hooks/use-click-outside'
import { stopPropagationHandlers } from './shared-ui'
import { clampMenuPosition, nextMenuIndex } from '@/lib/menu-nav'

interface ContextMenuProps {
  position: { x: number; y: number }
  items: Array<{
    label: string
    onClick: () => void
    danger?: boolean
    separator?: boolean
  }>
  onClose: () => void
}

export function GlassContextMenu({ position, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: position.x, top: position.y })

  useClickOutside(ref, onClose, TIMING.contextMenuDelayMs)

  // Map actionable items (separators excluded) to their roving indices
  const actionable = items.map((it, i) => (it.separator ? -1 : i)).filter(i => i >= 0)

  // Keep the whole menu inside the viewport
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // offsetWidth/Height ignore the open animation's scale(0.95) transform
    setPos(clampMenuPosition(position, { width: el.offsetWidth, height: el.offsetHeight }, {
      width: window.innerWidth,
      height: window.innerHeight,
    }))
  }, [position, items.length])

  // Focus the first item on open, restore focus on close
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    itemRefs.current[actionable[0]]?.focus({ preventScroll: true })
    return () => {
      if (previous && previous !== document.body && previous.isConnected) previous.focus({ preventScroll: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Escape arbitration: while the menu is the topmost layer it consumes Escape in the
  // capture phase, whatever has focus, so the global handler (closeTopPanel /
  // clearSelection) never also fires. See the note above dialogEscapeHandler in shared-ui.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const focusAt = (pos: number) => {
    setActive(pos)
    itemRefs.current[actionable[pos]]?.focus({ preventScroll: true })
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onCloseRef.current()
      return
    }
    if (e.key === 'Tab') {
      // Menus are not part of the tab sequence: close and return focus to the trigger.
      e.preventDefault()
      onCloseRef.current()
      return
    }
    const next = nextMenuIndex(active, actionable.length, e.key)
    if (next !== null) {
      e.preventDefault()
      focusAt(next)
    }
  }

  return (
    <div
      ref={ref}
      {...stopPropagationHandlers}
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        zIndex: Z.contextMenu,
      }}
    >
      <GlassCard
        visible={true}
        style={{ minWidth: 160 }}
      >
        <div role="menu" aria-label="Context menu" className="py-1" onKeyDown={onKeyDown}>
          {items.map((item, i) => {
            if (item.separator) {
              return <div key={i} role="separator" className="my-1 h-px" style={{ background: COLORS.holoBg10 }} />
            }
            const rovingPos = actionable.indexOf(i)
            return (
              <button
                key={i}
                ref={el => { itemRefs.current[i] = el }}
                type="button"
                role="menuitem"
                tabIndex={rovingPos === active ? 0 : -1}
                onFocus={() => setActive(rovingPos)}
                onClick={() => {
                  item.onClick()
                  onClose()
                }}
                className="min-h-6 w-full px-3 py-1.5 text-left text-[11px] font-mono transition-colors hover:bg-white/5 focus-visible:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#99e0ff]"
                style={{ color: item.danger ? COLORS.error : COLORS.textPrimary }}
              >
                {item.label}
              </button>
            )
          })}
        </div>
      </GlassCard>
    </div>
  )
}
