// #656: the attach burst both bridge measurements send. One session: an `agent_spawn`, then `tool_call_start` /
// `tool_call_end` pairs (about 386 bytes of JSON each), all `replayed: true` as a history read at attach (#652).
// Not run by any test: see bridge-host.mjs and bridge-webview.mjs.
export const BURST_SESSION_ID = 'bench-session-0001-aaaa-bbbb-cccc'

export function makeBurst(n) {
  const sid = BURST_SESSION_ID
  const evs = [{ time: 0, type: 'agent_spawn', sessionId: sid, replayed: true, payload: { name: 'main', isMain: true, task: 'attach burst' } }]
  for (let i = 1; i < n; i++) {
    const k = Math.floor(i / 2)
    const id = `toolu_01${String(k).padStart(22, '0')}`
    const file = `/home/user/project/src/module-${k % 400}/file-${k % 97}.ts`
    evs.push(i % 2
      ? { time: i * 0.01, type: 'tool_call_start', sessionId: sid, replayed: true, payload: { agent: 'main', tool: 'Read', args: file, inputData: { file_path: file }, toolUseId: id } }
      : { time: i * 0.01, type: 'tool_call_end', sessionId: sid, replayed: true, payload: { agent: 'main', tool: 'Read', toolUseId: id, result: `Read ${file}: ${50 + k % 300} lines, exported symbols resolved, no diagnostics reported by the language server`, tokenCost: 300 + k % 900, tokenSource: 'reported', isError: false } })
  }
  return evs
}

export const median = (values) => { const v = [...values].sort((a, b) => a - b); return v[Math.floor(v.length / 2)] }
