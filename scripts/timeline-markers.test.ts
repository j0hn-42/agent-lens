// Scrubber markers (#648): they follow the messages by id, not by array length, so they keep growing past
// the 200-message cap of appendConversation, and they are reset when a conversation is cleared or replaced.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createMarkerTracker } from '../web/lib/timeline-markers'
import { fr, en } from '../web/lib/messages/playback'
import { appendConversation, MAX_CONVERSATION_MESSAGES, MAX_EVENT_LOG as MAX_MARKERS, type ConversationMessage } from '../web/hooks/simulation/types'

type Conv = Map<string, ConversationMessage[]>

function feed(conv: Conv, dropped: Map<string, number>, agent: string, from: number, to: number, prefix = 'm') {
  for (let i = from; i < to; i++) {
    appendConversation(conv, agent, { id: `${prefix}${i}`, type: 'assistant', content: `msg ${i}`, timestamp: i }, dropped)
  }
}

test('markers keep following the messages past the 200-message cap', () => {
  const conv: Conv = new Map(); const dropped = new Map<string, number>()
  const tracker = createMarkerTracker()
  for (let i = 0; i < 300; i++) {
    feed(conv, dropped, 'a', i, i + 1)
    tracker.update(conv, dropped)
  }
  const { events, lost } = tracker.update(conv, dropped)
  assert.equal(events.length, 300)
  assert.equal(events[events.length - 1].timestamp, 299)
  assert.equal(lost, 0)
})

test('five new messages at the cap add five markers', () => {
  const conv: Conv = new Map(); const dropped = new Map<string, number>()
  const tracker = createMarkerTracker()
  feed(conv, dropped, 'a', 0, MAX_CONVERSATION_MESSAGES)
  const before = tracker.update(conv, dropped).events
  feed(conv, dropped, 'a', 200, 205)
  const after = tracker.update(conv, dropped).events
  assert.equal(after.length, before.length + 5)
  assert.notEqual(after, before, 'a new array is returned at each change')
})

test('the same input returns the same array', () => {
  const conv: Conv = new Map(); const dropped = new Map<string, number>()
  const tracker = createMarkerTracker()
  feed(conv, dropped, 'a', 0, 3)
  const a = tracker.update(conv, dropped).events
  assert.equal(tracker.update(conv, dropped).events, a)
})

test('clearing the conversations empties the markers', () => {
  const conv: Conv = new Map(); const dropped = new Map<string, number>()
  const tracker = createMarkerTracker()
  feed(conv, dropped, 'a', 0, 300)
  tracker.update(conv, dropped)
  conv.clear(); dropped.clear()
  assert.equal(tracker.update(conv, dropped).events.length, 0)
  feed(conv, dropped, 'a', 1000, 1005, 'n')
  assert.equal(tracker.update(conv, dropped).events.length, 5)
})

test('an agent whose history restarts smaller is reset, others are kept', () => {
  const conv: Conv = new Map(); const dropped = new Map<string, number>()
  const tracker = createMarkerTracker()
  feed(conv, dropped, 'a', 0, 50); feed(conv, dropped, 'b', 0, 10, 'b')
  tracker.update(conv, dropped)
  conv.set('a', []); dropped.delete('a'); feed(conv, dropped, 'a', 100, 103, 'z')
  const { events } = tracker.update(conv, dropped)
  assert.equal(events.filter(e => e.nodeId === 'a').length, 3)
  assert.equal(events.filter(e => e.nodeId === 'b').length, 10)
})

test('another session under the same agent key does not inherit the old markers', () => {
  const conv: Conv = new Map(); const dropped = new Map<string, number>()
  const tracker = createMarkerTracker()
  feed(conv, dropped, 'a', 0, 20)
  tracker.update(conv, dropped)
  conv.set('a', [{ id: 'x1', type: 'user', content: 'hi', timestamp: 500 }])
  dropped.delete('a')
  const { events } = tracker.update(conv, dropped)
  assert.deepEqual(events.map(e => e.timestamp), [500])
})

test('markers are sorted by time across agents, with a new id for each', () => {
  const conv: Conv = new Map(); const dropped = new Map<string, number>()
  const tracker = createMarkerTracker()
  conv.set('a', [{ id: 'a1', type: 'assistant', content: 'x', timestamp: 10 }])
  tracker.update(conv, dropped)
  conv.set('b', [{ id: 'b1', type: 'tool_call', content: 'y', timestamp: 5 }])
  const { events } = tracker.update(conv, dropped)
  assert.deepEqual(events.map(e => e.timestamp), [5, 10])
  assert.equal(new Set(events.map(e => e.id)).size, 2)
  assert.equal(events[0].type, 'tool_call')
})

test('markers older than what the hook saw are reported as lost, not omitted', () => {
  const conv: Conv = new Map(); const dropped = new Map<string, number>()
  feed(conv, dropped, 'a', 0, 350) // 150 already dropped when the hook first looks
  const tracker = createMarkerTracker()
  const first = tracker.update(conv, dropped)
  assert.equal(first.events.length, 200)
  assert.equal(first.lost, 150)
  // 250 arrive between two updates: only 200 are still readable
  feed(conv, dropped, 'a', 350, 600)
  const second = tracker.update(conv, dropped)
  assert.equal(second.events.length, 400)
  assert.equal(second.lost, 200)
})

test('the marker list is capped, the oldest ones are counted as lost', () => {
  const conv: Conv = new Map(); const dropped = new Map<string, number>()
  const tracker = createMarkerTracker()
  let res = tracker.update(conv, dropped)
  for (let i = 0; i < MAX_MARKERS + 50; i++) {
    feed(conv, dropped, 'a', i, i + 1)
    res = tracker.update(conv, dropped)
  }
  assert.equal(res.events.length, MAX_MARKERS)
  assert.equal(res.lost, 50)
  assert.equal(res.events[res.events.length - 1].timestamp, MAX_MARKERS + 49)
})

/** What seekToTime does: replay the same journal from zero, with fresh message ids */
function replay(upTo: number, prefix: string): { conv: Conv; dropped: Map<string, number> } {
  const conv: Conv = new Map(); const dropped = new Map<string, number>()
  feed(conv, dropped, 'a', 0, upTo, prefix)
  return { conv, dropped }
}

test('a replay with fresh ids and a full window does not duplicate markers', () => {
  const tracker = createMarkerTracker()
  const live = { conv: new Map() as Conv, dropped: new Map<string, number>() }
  for (let i = 0; i < 300; i++) { feed(live.conv, live.dropped, 'a', i, i + 1, 'live'); tracker.update(live.conv, live.dropped) }
  assert.equal(tracker.update(live.conv, live.dropped).events.length, 300)
  const again = replay(300, 'replay')
  const res = tracker.update(again.conv, again.dropped)
  assert.equal(res.events.length, 300)
  assert.equal(new Set(res.events.map(e => e.timestamp)).size, 300)
  assert.equal(res.lost, 0)
})

test('seeking back then forward on a full window keeps one marker per message', () => {
  const tracker = createMarkerTracker()
  const live = { conv: new Map() as Conv, dropped: new Map<string, number>() }
  for (let i = 0; i < 300; i++) { feed(live.conv, live.dropped, 'a', i, i + 1, 'live'); tracker.update(live.conv, live.dropped) }
  const back = replay(250, 'back')
  tracker.update(back.conv, back.dropped)
  const fwd = replay(300, 'fwd')
  const res = tracker.update(fwd.conv, fwd.dropped)
  assert.equal(new Set(res.events.map(e => e.timestamp)).size, res.events.length)
  assert.equal(res.events[res.events.length - 1].timestamp, 299)
  assert.equal(res.events.length + res.lost, 300)
})

test('another session with a full window and the same total is a replacement', () => {
  const tracker = createMarkerTracker()
  const one = replay(300, 'one')
  tracker.update(one.conv, one.dropped)
  const conv: Conv = new Map(); const dropped = new Map<string, number>()
  feed(conv, dropped, 'a', 1000, 1300, 'two')
  const res = tracker.update(conv, dropped)
  assert.equal(res.events.length, 200)
  assert.equal(res.events[0].timestamp, 1100)
  assert.equal(res.lost, 100)
})

test('lost that comes only from the marker cap is not blamed on messages cut before being seen', () => {
  const conv: Conv = new Map(); const dropped = new Map<string, number>()
  const tracker = createMarkerTracker()
  let res = tracker.update(conv, dropped)
  for (let i = 0; i < MAX_MARKERS + 3; i++) { feed(conv, dropped, 'a', i, i + 1); res = tracker.update(conv, dropped) }
  assert.equal(res.lost, 3)
  for (const table of [fr, en]) {
    assert.doesNotMatch(table['bar.markersLost.one'], /coupé|cut/)
    assert.doesNotMatch(table['bar.markersLost.other'], /coupés|cut/)
  }
})
