import { afterEach, expect, it, vi } from 'vitest'
import { evaluate } from '../src/jev.ts'
import type { EvaluationRecord } from '../src/jev.ts'
import { resolveConfig } from '../src/config.ts'
import { summarizeLedger } from '../skills/jev-router-inspect/scripts/inspect.mjs'

const config = resolveConfig({ enabled: true, credentialRefs: ['test'], candidates: [{ model: 'fixture', description: 'Fixture' }] })
const choices = [{ key: 'low', description: 'Low' }, { key: 'high', description: 'High' }]
afterEach(() => vi.unstubAllGlobals())

it.each([
  [{ low: 0.6, high: 0.4 }, 'available'],
  [{ low: 0.6, high: 0.39 }, 'available'],
  [{ low: 0.5, high: 0.5 }, 'available'],
  [undefined, 'missing'],
  [null, 'invalid'],
  [{ low: '0.6', high: 0.4 }, 'invalid'],
  [{ low: -0.1, high: 1.1 }, 'invalid'],
  [{ low: 0.6 }, 'invalid'],
  [{ low: 0.6, high: 0.4, secret: 0 }, 'invalid'],
  [{ low: 0, high: 0 }, 'invalid'],
  [{ low: 0.2, high: 0.2 }, 'invalid'],
] as const)('records optional probabilities %j without changing selection', async (probabilities, status) => {
  const fetcher = vi.fn(async () => Response.json({ answers: { route: { choice: 'low', probabilities } } }))
  vi.stubGlobal('fetch', fetcher)
  const records: EvaluationRecord[] = []
  const chosen = await evaluate({ resolve: async () => ({ value: 'test', source: 'test' }) }, config,
    [{ role: 'user', text: 'Task' }], choices, 'effort', new AbortController().signal, undefined, entry => records.push(entry))
  expect(chosen.key).toBe('low')
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(records[0]?.probabilityStatus).toBe(status)
  expect(records[0]?.probabilities).toEqual(status === 'available' ? probabilities : undefined)
})

it('shows top-two margin and marks old records missing, without including single/fallback outcomes', () => {
  const base = { time: '2026-01-01', question: 'effort', outcome: 'chosen', model: 'p/m', choice: 'low' } as const
  const result = summarizeLedger([
    { ...base, probabilities: { low: 0.6, high: 0.39 }, probabilityStatus: 'available' },
    base,
    { ...base, probabilityStatus: 'invalid' },
    { ...base, outcome: 'single' },
    { ...base, outcome: 'fallback' },
  ])
  expect(result.probabilityDecisions).toHaveLength(3)
  expect(result.probabilityDecisions[0]).toMatchObject({ top: 'low', runnerUp: 'high', margin: 0.21 })
  expect(result.probabilityDecisions[1]).toMatchObject({ status: 'missing', probabilities: null, margin: null })
  expect(result.probabilityDecisions[2]).toMatchObject({ status: 'invalid', margin: null })
})
