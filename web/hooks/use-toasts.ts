import { useCallback, useEffect, useRef, useState } from 'react'
import { toastRemaining } from '@/lib/chrome-utils'

export interface ToastItem {
  id: number
  message: string
  actionLabel?: string
  onAction?: () => void
  /** Called once when the toast goes away without its action being used (timeout or dismiss) */
  onExpire?: () => void
  durationMs: number
}

export type ToastInput = Omit<ToastItem, 'id' | 'durationMs'> & { durationMs?: number }

export type PauseSource = 'hover' | 'focus'

const DEFAULT_DURATION_MS = 5000
const MAX_TOASTS = 3

interface TimerState { handle: ReturnType<typeof setTimeout> | null; startedAt: number; remaining: number }

/**
 * Minimal non-blocking toast queue. Rendered by <ToastRegion>.
 * Timers pause while the pointer hovers or keyboard focus is inside the region (WCAG 2.2.1)
 * and resume with the time they had left.
 */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const idRef = useRef(0)
  const timersRef = useRef<Map<number, TimerState>>(new Map())
  const toastsRef = useRef<ToastItem[]>([])
  const pausedRef = useRef<Set<PauseSource>>(new Set())
  toastsRef.current = toasts

  const remove = useCallback((id: number, expired: boolean) => {
    const timer = timersRef.current.get(id)
    if (timer?.handle) clearTimeout(timer.handle)
    timersRef.current.delete(id)
    const item = toastsRef.current.find(t => t.id === id)
    if (!item) return
    toastsRef.current = toastsRef.current.filter(t => t.id !== id)
    setToasts(toastsRef.current)
    if (toastsRef.current.length === 0) pausedRef.current.clear()
    if (expired) item.onExpire?.()
  }, [])

  const startTimer = useCallback((id: number, remaining: number) => {
    const state: TimerState = { handle: null, startedAt: Date.now(), remaining }
    state.handle = setTimeout(() => remove(id, true), remaining)
    timersRef.current.set(id, state)
  }, [remove])

  const dismiss = useCallback((id: number) => remove(id, true), [remove])

  const runAction = useCallback((id: number) => {
    const item = toastsRef.current.find(t => t.id === id)
    remove(id, false)
    item?.onAction?.()
  }, [remove])

  /** Run the action of the newest toast that has one (keyboard Undo). Returns true if one ran. */
  const runLatestAction = useCallback((): boolean => {
    for (let i = toastsRef.current.length - 1; i >= 0; i--) {
      const t = toastsRef.current[i]
      if (t.onAction) { runAction(t.id); return true }
    }
    return false
  }, [runAction])

  /** True while a visible toast carries an action (Undo) */
  const hasAction = useCallback((): boolean => toastsRef.current.some(t => typeof t.onAction === 'function'), [])

  const setPaused = useCallback((source: PauseSource, paused: boolean) => {
    const before = pausedRef.current.size > 0
    if (paused) pausedRef.current.add(source)
    else pausedRef.current.delete(source)
    const after = pausedRef.current.size > 0
    if (before === after) return
    const now = Date.now()
    for (const [id, state] of Array.from(timersRef.current.entries())) {
      if (after && state.handle) {
        clearTimeout(state.handle)
        state.handle = null
        state.remaining = toastRemaining(state.remaining, state.startedAt, now)
      } else if (!after && !state.handle) {
        startTimer(id, state.remaining)
      }
    }
  }, [startTimer])

  const push = useCallback((input: ToastInput): number => {
    const id = ++idRef.current
    const item: ToastItem = { ...input, id, durationMs: input.durationMs ?? DEFAULT_DURATION_MS }
    // Evict the oldest toast when the queue is full (its expiry callback still runs)
    const overflow = toastsRef.current.length + 1 - MAX_TOASTS
    if (overflow > 0) {
      for (const old of toastsRef.current.slice(0, overflow)) remove(old.id, true)
    }
    toastsRef.current = [...toastsRef.current, item]
    setToasts(toastsRef.current)
    if (pausedRef.current.size > 0) {
      // Region is hovered/focused right now: the timer starts when the user leaves
      timersRef.current.set(id, { handle: null, startedAt: Date.now(), remaining: item.durationMs })
    } else {
      startTimer(id, item.durationMs)
    }
    return id
  }, [remove, startTimer])

  useEffect(() => {
    const timers = timersRef.current
    return () => { for (const t of timers.values()) if (t.handle) clearTimeout(t.handle) }
  }, [])

  return { toasts, push, dismiss, runAction, runLatestAction, hasAction, setPaused }
}
