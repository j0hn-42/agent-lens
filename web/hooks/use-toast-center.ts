'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useToasts } from '@/hooks/use-toasts'
import type { BridgeNotice } from '@/lib/vscode-bridge'

/** The toast queue plus the undo plumbing, and the bridge notices (relay down/up, malformed data, session reset) shown as toasts */
export function useToastCenter(notice: BridgeNotice | null) {
  const { toasts, push: pushToast, dismiss: dismissToast, runAction, runLatestAction, hasAction: hasUndoToast, setPaused: setToastsPaused } = useToasts()
  // Confirm that an undo happened (also announced to screen readers through the toast live region)
  const runToastAction = useCallback((id: number) => {
    runAction(id)
    pushToast({ message: 'Undone', durationMs: 3000 })
  }, [runAction, pushToast])
  const undoLast = useCallback((): boolean => {
    const ran = runLatestAction()
    if (ran) pushToast({ message: 'Undone', durationMs: 3000 })
    return ran
  }, [runLatestAction, pushToast])

  // Surface bridge notices as non-blocking toasts
  const lastNoticeIdRef = useRef(0)
  useEffect(() => {
    if (!notice || notice.id === lastNoticeIdRef.current) return
    lastNoticeIdRef.current = notice.id
    pushToast({ message: notice.message, durationMs: notice.kind === 'relay-down' ? 8000 : 5000 })
  }, [notice, pushToast])

  return { toasts, pushToast, dismissToast, runToastAction, undoLast, hasUndoToast, setToastsPaused }
}
