import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { parseQuotaBody, createQuotaStore } from './quota'

const win = (used: unknown, resets: unknown) => ({ used_percentage: used, resets_at: resets })
const body = (rateLimits: unknown) => JSON.stringify({ rate_limits: rateLimits })

test('parseQuotaBody accepte les deux fenêtres', () => {
  assert.deepEqual(
    parseQuotaBody(body({ five_hour: win(62, 1790000000), seven_day: win(10.5, 1790500000) })),
    { fiveHour: { usedPercentage: 62, resetsAt: 1790000000 }, sevenDay: { usedPercentage: 10.5, resetsAt: 1790500000 } },
  )
})

test('parseQuotaBody accepte une seule fenêtre et les bornes 0 et 100', () => {
  assert.deepEqual(parseQuotaBody(body({ seven_day: win(100, 0) })), { fiveHour: null, sevenDay: { usedPercentage: 100, resetsAt: 0 } })
  assert.deepEqual(parseQuotaBody(body({ five_hour: win(0, 5) })), { fiveHour: { usedPercentage: 0, resetsAt: 5 }, sevenDay: null })
})

test('parseQuotaBody ignore les clés inconnues dans rate_limits', () => {
  assert.deepEqual(
    parseQuotaBody(body({ five_hour: win(1, 2), spend_limit: { foo: 1 } })),
    { fiveHour: { usedPercentage: 1, resetsAt: 2 }, sevenDay: null },
  )
})

test('parseQuotaBody refuse ce qui n’est pas prouvable', () => {
  const bad: string[] = [
    'not json',
    '[]',
    'null',
    JSON.stringify({ rate_limits: { five_hour: win(1, 2) }, extra: 1 }),
    JSON.stringify({}),
    body([]),
    body(null),
    body({}),
    body({ spend_limit: {} }),
    body({ five_hour: win(-1, 2) }),
    body({ five_hour: win(101, 2) }),
    '{"rate_limits":{"five_hour":{"used_percentage":NaN,"resets_at":2}}}',
    body({ five_hour: win('62', 2) }),
    body({ five_hour: win(1, 1.5) }),
    body({ five_hour: win(1, -1) }),
    body({ five_hour: win(1, '2') }),
    body({ five_hour: { used_percentage: 1 } }),
    body({ five_hour: null }),
    body({ five_hour: win(1, 2), seven_day: win(500, 2) }),
  ]
  for (const text of bad) assert.equal(parseQuotaBody(text), null, text)
})

test('le store renvoie null avant tout accept', () => {
  assert.equal(createQuotaStore(() => 1).current(), null)
})

test('le store remplace les deux fenêtres ensemble et date par now()', () => {
  let t = 1000
  const store = createQuotaStore(() => t)
  const first = store.accept({ fiveHour: { usedPercentage: 1, resetsAt: 2 }, sevenDay: { usedPercentage: 3, resetsAt: 4 } })
  assert.deepEqual(first, { fiveHour: { usedPercentage: 1, resetsAt: 2 }, sevenDay: { usedPercentage: 3, resetsAt: 4 }, receivedAt: 1000 })
  t = 2000
  const second = store.accept({ fiveHour: { usedPercentage: 5, resetsAt: 6 }, sevenDay: null })
  assert.deepEqual(second, { fiveHour: { usedPercentage: 5, resetsAt: 6 }, sevenDay: null, receivedAt: 2000 })
  assert.deepEqual(store.current(), second)
})
