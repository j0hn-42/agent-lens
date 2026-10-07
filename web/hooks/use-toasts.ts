import { useCallback, useEffect, useRef, useState } from 'react'

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

const DEFAULT_DURATION_MS = 5000
const MAX_TOASTS = 3

/** Minimal non-blocking toast queue. Rendered by <ToastRegion>. */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const idRef = useRef(0)
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())
  const toastsRef = useRef<ToastItem[]>([])
  toastsRef.current = toasts

  const remove = useCallback((id: number, expired: boolean) => {
    const timer = timersRef.current.get(id)
    if (timer) clearTimeout(timer)
    timersRef.current.delete(id)
    const item = toastsRef.current.find(t => t.id === id)
    if (!item) return
    toastsRef.current = toastsRef.current.filter(t => t.id !== id)
    setToasts(toastsRef.current)
    if (expired) item.onExpire?.()
  }, [])

  const dismiss = useCallback((id: number) => remove(id, true), [remove])

  const runAction = useCallback((id: number) => {
    const item = toastsRef.current.find(t => t.id === id)
    remove(id, false)
    item?.onAction?.()
  }, [remove])

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
    timersRef.current.set(id, setTimeout(() => remove(id, true), item.durationMs))
    return id
  }, [remove])

  useEffect(() => {
    const timers = timersRef.current
    return () => { for (const t of timers.values()) clearTimeout(t) }
  }, [])

  return { toasts, push, dismiss, runAction }
}
