/** Texts of the history catch-up indicator (#210): the counts are the real queued and processed events. */
export interface HistoryProgress { done: number; total: number }

export function historyLoadingText({ done, total }: HistoryProgress): string {
  return `Loading history (${done}/${total})`
}

export function historyLoadedText(total: number): string {
  return `History loaded (${total} ${total === 1 ? 'event' : 'events'})`
}
