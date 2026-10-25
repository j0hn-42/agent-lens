// #659 / #613: cost of buffering one event in the session buffers (appendSessionEvent, estimated bytes included), in
// Node. Not run by any test; the figures of docs/performance.md come from it.
// Usage: node --import tsx scripts/bench/session-buffers.mts [events=260000] [rounds=7]
import * as buffers from '../../web/lib/session-buffers.ts'
import type { SimulationEvent } from '../../web/lib/agent-types.ts'

// The web package is loaded as CommonJS by tsx: its exports can arrive on `default`
const { createSessionBuffers, appendSessionEvent } = (buffers as any).appendSessionEvent ? buffers : (buffers as any).default

const N = Number(process.argv[2] ?? 260_000)
const ROUNDS = Number(process.argv[3] ?? 7)
const SESSIONS = 50

/** An event whose JSON is about `chars` characters long (the text fields carry the weight). */
function makeEvent(sessionId: string, i: number, chars: number): SimulationEvent {
  return { time: i, type: 'tool_call_end', sessionId, payload: { agent: 'main', tool: 'Read', toolUseId: `toolu_${i}`, result: 'r'.repeat(chars - 150), tokenCost: 300, isError: false } } as unknown as SimulationEvent
}

const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]

function run(label: string, chars: number, maxBytes: number): void {
  const times: number[] = []
  for (let r = 0; r < ROUNDS; r++) {
    // New events each round (their JSON length is cached per object) and made before the clock starts
    const events = Array.from({ length: N }, (_, i) => makeEvent(`session-${i % SESSIONS}`, i, chars))
    const s = createSessionBuffers()
    const t0 = process.hrtime.bigint()
    for (const ev of events) appendSessionEvent(s, ev.sessionId as string, ev, null, 5000, 50, maxBytes)
    times.push(Number(process.hrtime.bigint() - t0) / 1000 / N)
  }
  console.log(`${label.padEnd(34)} ${median(times).toFixed(2)} us / event (median of ${ROUNDS} rounds, ${N} events, JSON ~${chars} chars)`)
}

run('real profile, 64 MiB byte cap', 1240, 64 * 1024 * 1024)
run('worst profile, 64 MiB byte cap', 6965, 64 * 1024 * 1024)
run('real profile, byte cap out of reach', 1240, Number.MAX_SAFE_INTEGER)
