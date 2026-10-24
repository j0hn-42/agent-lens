/**
 * The demo scenario, loaded on demand (#662). mock-scenario.ts and the scenarios it picks from (tour, guided, stress
 * test, workflows) are a chunk of their own: a live session never loads them. The entries load it before their first
 * render when the demo is on at start (boot.ts), and the bridge loads it before it turns the demo on later.
 * Until it is loaded the scenario is empty: no event, no duration, no session, never a made-up one.
 *
 * What only depends on the URL (which scenario, which stress level) is read here, without loading the data.
 */
import type { SimulationEvent } from './agent-types'
import type { SessionInfo } from './bridge-types'

/** The levels of stress-test-scenario.ts (?stress=light|medium|heavy|extreme); scripts/lazy-bundle.test.ts keeps them equal */
const STRESS_LEVELS = ['light', 'medium', 'heavy', 'extreme'] as const
type DemoStressLevel = (typeof STRESS_LEVELS)[number]

// ─── Stress Test Support ─────────────────────────────────────────────────────
// Add ?stress=light|medium|heavy|extreme to the URL to load a stress scenario.
// This replaces the normal mock scenario for profiling purposes.
export function getStressLevel(): DemoStressLevel | null {
  if (typeof window === 'undefined') return null
  const level = new URLSearchParams(window.location.search).get('stress')
  return level && (STRESS_LEVELS as readonly string[]).includes(level) ? level as DemoStressLevel : null
}

export function getScenarioName(): string | null {
  if (typeof window === 'undefined') return null
  // `process` does not exist in a browser bundle that does not define the variable (#534): never read it bare.
  // The bundler replaces the literal `process.env.NEXT_PUBLIC_DEMO_SCENARIO`; the try only covers a build that does not.
  let fromEnv: string | undefined
  try { fromEnv = process.env.NEXT_PUBLIC_DEMO_SCENARIO } catch { fromEnv = undefined }
  return new URLSearchParams(window.location.search).get('scenario') || fromEnv || null
}

const stressLevel = getStressLevel()
const SCENARIO_NAME = getScenarioName()

/** True when the step-by-step guided demo (?scenario=guided) is the active scenario. */
export const IS_GUIDED_DEMO = !stressLevel && SCENARIO_NAME === 'guided'

/** Sessions the demo declares (the tour spans three: the relay would normally list them). Empty for the others. */
export const HAS_MOCK_SESSIONS = !stressLevel && SCENARIO_NAME === 'tour'

/** The demo is on at start unless the build turns it off (NEXT_PUBLIC_DEMO=0), as useVSCodeBridge decides */
export function demoAtStart(): boolean {
  let flag: string | undefined
  try { flag = process.env.NEXT_PUBLIC_DEMO } catch { flag = undefined }
  return flag !== '0'
}

type ScenarioModule = typeof import('./mock-scenario')
let loaded: ScenarioModule | null = null
let pending: Promise<void> | null = null

export function isMockScenarioLoaded(): boolean {
  return loaded !== null
}

/** Loads the scenario chunk once; a failed load can be retried */
export function loadMockScenario(): Promise<void> {
  if (loaded) return Promise.resolve()
  if (!pending) {
    pending = import('./mock-scenario').then(m => { loaded = m }).finally(() => { pending = null })
  }
  return pending
}

const NO_EVENTS: SimulationEvent[] = []

/** The events of the demo; empty until the scenario is loaded */
export function getMockScenario(): SimulationEvent[] {
  return loaded ? loaded.MOCK_SCENARIO : NO_EVENTS
}

/** Length of the demo timeline (last event + 10 s); 0 until the scenario is loaded */
export function mockDuration(): number {
  return loaded ? loaded.MOCK_DURATION : 0
}

/** Dated at the call (the browser, after mount), see tourSessions; empty until the scenario is loaded */
export function mockSessions(now: number = Date.now()): SessionInfo[] {
  return loaded ? loaded.mockSessions(now) : []
}
