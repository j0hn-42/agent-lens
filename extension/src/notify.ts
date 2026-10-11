/**
 * Native VS Code notifications asked for by the webview (#225). Pure (no `vscode` import): the caller passes the
 * message API. The webview is not trusted: the message is validated field by field, stripped of control characters,
 * capped, and throttled per trigger so a loop in the page cannot flood the editor.
 */
import { CONTROL_ALL } from './control-chars'

export const NOTIFY_TRIGGERS = ['attention', 'complete', 'cost'] as const
export type NotifyTrigger = (typeof NOTIFY_TRIGGERS)[number]

export const NOTIFY_TITLE_MAX = 40
export const NOTIFY_BODY_MAX = 200

export interface NotifyMessage {
  trigger: NotifyTrigger
  title: string
  body: string
}

function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(CONTROL_ALL, '').trim().slice(0, max)
  return text === '' ? null : text
}

/** The validated notification, or null when the message is not a well-formed request. */
export function parseNotifyMessage(raw: unknown): NotifyMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.trigger !== 'string' || !(NOTIFY_TRIGGERS as readonly string[]).includes(o.trigger)) return null
  const title = clean(o.title, NOTIFY_TITLE_MAX)
  const body = clean(o.body, NOTIFY_BODY_MAX)
  if (!title || !body) return null
  return { trigger: o.trigger as NotifyTrigger, title, body }
}

/** At most one message per trigger per window. */
export class NotifyThrottle {
  private readonly last = new Map<NotifyTrigger, number>()
  constructor(private readonly windowMs: number) {}
  allow(trigger: NotifyTrigger, now: number): boolean {
    const before = this.last.get(trigger)
    if (before !== undefined && now - before < this.windowMs) return false
    this.last.set(trigger, now)
    return true
  }
}

export interface NotifyUi {
  showWarningMessage(message: string): unknown
  showInformationMessage(message: string): unknown
}

/** Shows the message unless the user is already looking at the Agent Lens panel; a finished session informs, the rest warns. */
export function showNativeNotification(msg: NotifyMessage, state: { focused: boolean }, ui: NotifyUi): void {
  if (state.focused) return
  const text = `${msg.title}: ${msg.body}`
  if (msg.trigger === 'complete') ui.showInformationMessage(text)
  else ui.showWarningMessage(text)
}
