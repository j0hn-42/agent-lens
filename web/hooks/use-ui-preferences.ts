/**
 * useUiPreferences(): persisted UI toggles (#32), backed by localStorage.
 *
 * - SSR-safe: the server snapshot is always DEFAULT_UI_PREFS, so the first client render equals the
 *   server render; stored values are applied right after hydration (useSyncExternalStore re-renders).
 * - Cross-tab: a `storage` event from another tab updates every subscribed component.
 * - Batched: any number of setPref calls inside one tick/frame produce a single localStorage write;
 *   a pending write is flushed on `pagehide`.
 *
 * INTEGRATION SNIPPET for web/components/agent-visualizer/index.tsx (mechanical replacement):
 *
 *   import { useUiPreferences } from '@/hooks/use-ui-preferences'
 *   import { restoreSelectedSessionId } from '@/lib/ui-preferences'
 *
 *   const { prefs, setPref } = useUiPreferences()
 *
 *   // replaces: const [showStats, setShowStats] = useState(false)   (and the 5 siblings below)
 *   const showStats = prefs.showStats
 *   const showHexGrid = prefs.showHexGrid
 *   const showCostOverlay = prefs.showCostOverlay
 *   const showTimeline = prefs.showTimeline
 *   const showFileAttention = prefs.showFiles          // key is `showFiles`
 *   const showTranscript = prefs.showConversation      // key is `showConversation`
 *
 *   // replaces setShowStats(v) / setShowStats(p => !p) at every call site (toggles, panel close handlers,
 *   // the Escape stack closeTopPanel):  setPref('showStats', v)  /  setPref('showStats', !showStats)
 *   // (setPref takes a value, not an updater: read the current value from `prefs`)
 *
 *   // Selected session: persist on change ...
 *   useEffect(() => { setPref('lastSelectedSessionId', isRealSession(selectedSessionId) ? selectedSessionId : null) }, [selectedSessionId])
 *   // ... and restore once, when the first session list arrives (only if still listed and not completed):
 *   const restoredRef = useRef(false)
 *   useEffect(() => {
 *     if (restoredRef.current || sessions.length === 0) return
 *     restoredRef.current = true
 *     const id = restoreSelectedSessionId(prefs.lastSelectedSessionId, sessions)
 *     if (id) bridge.selectSession(id)
 *   }, [sessions])
 *   // (never persist ALL_SESSIONS_ID or a team pseudo selection: pass null)
 *
 *   // Right dock width: const [width, setWidth] = [prefs.dockRightWidth, (w: number) => setPref('dockRightWidth', w)]
 *   // (values are clamped to 280..720; call it on drag end, not on every pointermove, to keep writes cheap)
 *
 * Already persisted elsewhere, do NOT add here: mute, hide-inactive, single-key shortcuts,
 * show-finished-sessions (SHOW_FINISHED_STORAGE_KEY). Speed is deliberately not persisted.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import {
  DEFAULT_UI_PREFS,
  UI_PREFS_STORAGE_KEY,
  createPrefsStore,
  createSafeStorage,
  type PrefsStore,
  type UiPrefKey,
  type UiPrefs,
} from '@/lib/ui-preferences'

function frameScheduler(fn: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(() => fn())
    return () => cancelAnimationFrame(id)
  }
  const h = setTimeout(fn, 16)
  return () => clearTimeout(h)
}

/** Build a store on the window's localStorage (with in-memory fallback). Exported for tests. */
export function createBrowserPrefsStore(): PrefsStore {
  const storage = createSafeStorage(() => (typeof window === 'undefined' ? null : window.localStorage))
  return createPrefsStore({ storage, schedule: frameScheduler })
}

let defaultStore: PrefsStore | null = null
function getDefaultStore(): PrefsStore {
  if (!defaultStore) defaultStore = createBrowserPrefsStore()
  return defaultStore
}

const getServerSnapshot = (): UiPrefs => DEFAULT_UI_PREFS as UiPrefs

export interface UseUiPreferences {
  prefs: UiPrefs
  setPref: <K extends UiPrefKey>(key: K, value: UiPrefs[K]) => void
  resetPrefs: () => void
}

/** @param store injection point for tests; production code passes nothing */
export function useUiPreferences(store: PrefsStore = getDefaultStore()): UseUiPreferences {
  const prefs = useSyncExternalStore(store.subscribe, store.getSnapshot, getServerSnapshot)

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      // key === null: storage.clear() in the other tab
      if (e.key !== null && e.key !== UI_PREFS_STORAGE_KEY) return
      store.applyExternal(e.key === null ? null : e.newValue)
    }
    const onHide = () => store.flush()
    window.addEventListener('storage', onStorage)
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('pagehide', onHide)
    }
  }, [store])

  const setPref = useCallback(
    <K extends UiPrefKey>(key: K, value: UiPrefs[K]) => store.set(key, value),
    [store],
  )
  const resetPrefs = useCallback(() => store.reset(), [store])
  return { prefs, setPref, resetPrefs }
}
