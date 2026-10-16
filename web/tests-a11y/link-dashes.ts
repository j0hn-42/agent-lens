// Test helper (#440): count the dashes drawn for a session LINK in a recorded canvas call list.
//
// A session halo is drawn with the same ratio as a task link ([2k, 5k] = 0.4, draw-teams.ts), so a bare
// count of setLineDash(0.4) also counts halos: it grows with the number of frames, which real time decides.
// A link segment is recognised by what follows its dash: beginPath -> moveTo (the halo traces its arc
// BEFORE its dash, so it never matches). The count is then 0 without link, whatever the number of frames.
export type RecordedCall = { name: string; args: unknown[] }

export function linkDashCount(calls: ReadonlyArray<RecordedCall>, kind: 'task' | 'worktree'): number {
  const wanted = kind === 'task' ? 0.4 : 1.6
  return calls.filter((c, i) => {
    if (c.name !== 'setLineDash' || !Array.isArray(c.args[0]) || c.args[0].length !== 2) return false
    const [on, off] = c.args[0] as number[]
    if (Math.round((on / off) * 10) / 10 !== wanted) return false
    return calls[i + 1]?.name === 'beginPath' && calls[i + 2]?.name === 'moveTo'
  }).length
}
