import { useEffect, useState } from 'react'
import {
  loadIssueLinks, issueLinksRetryDelayMs, ISSUE_LINKS_CACHE_TTL_MS, ISSUE_LINKS_MAX_RETRIES, type IssueLink,
} from '@/lib/issue-links'

const CACHE_MAX_ROLES = 32
const cache = new Map<string, { at: number; links: IssueLink[] }>()

/** 'idle': nothing asked; 'loading': first answer pending; 'ok': the relay answered (the list may truly be empty); 'unavailable': the last attempt failed */
export type IssueLinksStatus = 'idle' | 'loading' | 'ok' | 'unavailable'

export interface IssueLinksState {
  links: IssueLink[]
  status: IssueLinksStatus
}

const IDLE: IssueLinksState = { links: [], status: 'idle' }
const LOADING: IssueLinksState = { links: [], status: 'loading' }
const UNAVAILABLE: IssueLinksState = { links: [], status: 'unavailable' }

/**
 * Issues / PRs labelled `agent:<role>`, from the relay. `origin` null (no relay) or no role: nothing is
 * requested. Only a successful answer (a true empty list included) is cached; a 503, a network error or a
 * timeout is reported as 'unavailable', never cached, and retried with a short backoff (honouring Retry-After).
 */
export function useIssueLinks(origin: string | null | undefined, role: string | undefined, sessionId?: string): IssueLinksState {
  const [state, setState] = useState<IssueLinksState>(IDLE)

  useEffect(() => {
    if (origin == null || !role) { setState(IDLE); return }
    const key = `${origin}|${role}|${sessionId ?? ''}`
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < ISSUE_LINKS_CACHE_TTL_MS) { setState({ links: hit.links, status: 'ok' }); return }
    setState(LOADING)
    const ctrl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined

    const attempt = (n: number) => {
      void loadIssueLinks(origin, role, (url, init) => fetch(url, init), ctrl.signal, sessionId).then(result => {
        if (ctrl.signal.aborted) return
        if (result.status === 'ok') {
          if (cache.size >= CACHE_MAX_ROLES) {
            const oldest = cache.keys().next().value
            if (oldest !== undefined) cache.delete(oldest)
          }
          cache.set(key, { at: Date.now(), links: result.links })
          setState({ links: result.links, status: 'ok' })
          return
        }
        setState(UNAVAILABLE)
        if (n < ISSUE_LINKS_MAX_RETRIES) timer = setTimeout(() => attempt(n + 1), issueLinksRetryDelayMs(n, result.retryAfterMs))
      })
    }
    attempt(0)
    return () => { ctrl.abort(); if (timer !== undefined) clearTimeout(timer) }
  }, [origin, role, sessionId])

  return state
}
