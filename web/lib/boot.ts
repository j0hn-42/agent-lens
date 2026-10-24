/**
 * What the first render needs and is not in the first load (#662): the table of the language asked for when it is
 * not the default one, and the demo scenario when the demo is on at start. The entries (Next page, webview, standalone
 * app) render once this resolves, so the first paint is in the right language and the demo has its events: never a
 * screen in English that switches to French, never an empty demo that stops on its own.
 * A chunk that does not load leaves the app in English, or with the demo off: nothing is shown that was not loaded.
 */
import { loadWantedLocale } from './locale'
import { demoAtStart, loadMockScenario } from './demo-scenario'

export function prepareBoot(): Promise<void> {
  const loads: Promise<void>[] = [loadWantedLocale()]
  if (demoAtStart()) loads.push(loadMockScenario())
  return Promise.allSettled(loads).then(() => undefined)
}
