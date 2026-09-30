import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ReasoningEffortId, createDeveloperMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { POLICY_VERSION, decideEffort, readAnswerChoice, readAnswerConfidence, readAnswerProbabilities, readProbabilityDecimals } from '../../jev-router-policy/src/index.ts'
import { JevRouter, AUTO_EFFORT } from '../src/router.ts'
import { configurationUpdates, harness, send } from './harness.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals() })

const sol = { provider: 'test', model: 'gpt-6.1-sol', reasoningEffort: AUTO_EFFORT }
const ledgerOf = (directory: string, id: string) => readFileSync(join(directory, `${id}.ledger.jsonl`), 'utf8')
  .trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)

function answer(body: unknown) {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(body))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

it.each([28000, 2400])('records drop causes without changing evidence or source history (budget %s)', async (maxBodyBytes) => {
  const fetcher = answer({ answers: { route: { choice: 'low', confidence: 0.9, probabilities: { low: 0.8, medium: 0.1, high: 0.1 } } } })
  const h = await harness({ maxBodyBytes }); cleanup.push(h.close)
  const agent = await h.create(`observed-${maxBodyBytes}`, sol)
  const router = new JevRouter(h.ctx, (await import('../src/config.ts')).resolveConfig(h.settings))
  const messages = Array.from({ length: 10 }, (_, i) => createUserMessage({
    content: [{ type: 'text', text: i === 9 ? 'current task' : `${i}:` + 'x'.repeat(2000) }], source: { kind: 'user' },
  }))
  const before = JSON.stringify(messages)
  const { prepareEvidence, fitEvidenceToBudget, effortState, effortCriteria } = await import('../../jev-router-policy/src/index.ts')
  const { effortEvidenceEvents } = await import('../src/messages.ts')
  const prepared = prepareEvidence(effortEvidenceEvents(messages))
  await router.main(agent, sol, messages, new AbortController().signal)
  const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body))
  const expected = fitEvidenceToBudget(prepared.messages, items => Buffer.byteLength(JSON.stringify({
    ...body, state: effortState('test/gpt-6.1-sol', null, items),
  })) <= maxBodyBytes)
  expect(body.state).toEqual(effortState('test/gpt-6.1-sol', null, expected.messages))
  expect(body.questions.route.criteria).toEqual(effortCriteria(['low', 'medium', 'high']))
  expect(Buffer.byteLength(String(fetcher.mock.calls[0]![1]?.body))).toBeLessThanOrEqual(maxBodyBytes)
  expect(JSON.stringify(messages)).toBe(before)
  expect(body.state.messages.at(-1).text).toBe('current task')
  const entry = ledgerOf(h.settings.stateDirectory!, `observed-${maxBodyBytes}`).at(-1)!
  expect(entry).toMatchObject({ windowDropped: 2, budgetDropped: expected.dropped, dropped: 2 + expected.dropped, omittedCodePoints: prepared.omittedCodePoints })
  expect(entry.budgetDropped).toBe(maxBodyBytes === 28000 ? 0 : expected.dropped)
  if (maxBodyBytes === 2400) expect(expected.dropped).toBeGreaterThan(0)
})

it('shortens only the Jev projection and delivers intact long text to the main model', async () => {
  const fetcher = answer({ answers: { route: { choice: 'low', confidence: 0.9, probabilities: { low: 0.8, medium: 0.1, high: 0.1 } } } })
  const h = await harness(); cleanup.push(h.close)
  const text = 'HEAD' + '汉'.repeat(5000) + 'TAIL'
  await send(await h.create('intact-main', sol), text)
  expect(h.errors).toEqual([])
  const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body))
  expect(Array.from(body.state.messages[0].text)).toHaveLength(1600)
  expect(body.state.messages[0].text).toContain('[...omitted...]')
  expect(JSON.stringify(h.adapter.requests[0]!.messages)).toContain(text)
  expect(ledgerOf(h.settings.stateDirectory!, 'intact-main').at(-1)).toMatchObject({ windowDropped: 0, budgetDropped: 0, applyStatus: 'applied' })
})

it('counts budget failure reduction once, on the failed evaluation rather than its fallback', async () => {
  const fetcher = answer({})
  const h = await harness({ maxBodyBytes: 1000 }); cleanup.push(h.close)
  const agent = await h.create('budget-failure-observed', sol)
  const router = new JevRouter(h.ctx, (await import('../src/config.ts')).resolveConfig(h.settings))
  const messages = Array.from({ length: 10 }, () => createUserMessage({
    content: [{ type: 'text', text: 'x'.repeat(2000) }], source: { kind: 'user' },
  }))
  await router.main(agent, sol, messages, new AbortController().signal)
  const entries = ledgerOf(h.settings.stateDirectory!, 'budget-failure-observed')
  expect(fetcher).not.toHaveBeenCalled()
  expect(entries.map(entry => entry.outcome)).toEqual(['failed', 'fallback'])
  expect(entries[0]).toMatchObject({ windowDropped: 2, budgetDropped: 7, dropped: 9 })
  const { summarizeLedger } = await import('../skills/dsh-jev-router-inspect/scripts/inspect.mjs')
  expect(summarizeLedger(entries as Parameters<typeof summarizeLedger>[0])).toMatchObject({
    shortenedEvaluations: 1,
    evidenceReduction: { windowLimitedEvaluations: 1, budgetLimitedEvaluations: 1, textShortenedEvaluations: 1, unknownDropCauseEvaluations: 0 },
    usage: { evaluations: 1, httpAttempts: 0, inputTokens: 0, gatewayCostUsd: 0 },
  })
})

it('publishes the shared policy version', async () => {
  const h = await harness(); cleanup.push(h.close)
  const policy = JSON.parse(readFileSync(join(h.settings.stateDirectory!, '_policy.json'), 'utf8'))
  expect(policy.policyVersion).toBe(POLICY_VERSION)
  expect(POLICY_VERSION).toBe('2026-09-30.2')
})

it.each([
  [0.49, 'high', 'raised'],
  [0.5, 'medium', 'confidence-kept'],
  [0.51, 'medium', 'confidence-kept'],
] as const)('confidence %s selects %s (%s)', async (confidence, selected, reason) => {
  answer({ answers: { route: { choice: 'medium', confidence, probabilities: { low: 0.2, medium: 0.5, high: 0.3 } } }, rounding: { probabilityDecimals: 2 } })
  const h = await harness(); cleanup.push(h.close)
  const id = `confidence-${confidence}`
  await send(await h.create(id, sol))
  expect(h.errors).toEqual([])
  expect(h.adapter.requests[0]).toMatchObject({ reasoningEffort: selected })
  expect(ledgerOf(h.settings.stateDirectory!, id).at(-1)).toMatchObject({
    policyVersion: POLICY_VERSION, selectedEffort: selected, decisionReason: reason, rawConfidence: confidence, applyStatus: 'applied',
  })
})

it('raises once from the top probability and can later lower to low', async () => {
  const bodies = [
    { answers: { route: { choice: 'medium', confidence: 0.4, probabilities: { low: 0.1, medium: 0.5, high: 0.4 } } }, rounding: { probabilityDecimals: 2 } },
    { answers: { route: { choice: 'low', confidence: 0.9, probabilities: { low: 0.7, medium: 0.2, high: 0.1 } } }, rounding: { probabilityDecimals: 2 } },
  ]
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(bodies.shift())))
  const h = await harness(); cleanup.push(h.close)
  const agent = await h.create('lower', sol)
  await send(agent)
  await send(agent, 'A smaller follow-up')
  expect(h.errors).toEqual([])
  expect(h.adapter.requests.map(request => request.reasoningEffort)).toEqual(['high', 'high'])
  expect(configurationUpdates(agent.session.deriveMessages())).toEqual(['low'])
  const entries = ledgerOf(h.settings.stateDirectory!, 'lower')
  expect(entries[0]).toMatchObject({ selectedEffort: 'high', decisionReason: 'raised', rawChoice: 'medium' })
  expect(entries[1]).toMatchObject({ selectedEffort: 'low', decisionReason: 'confidence-kept', currentEffort: 'high' })
})

it('treats an exact probability tie as the higher level and then raises once', async () => {
  answer({ answers: { route: { choice: 'low', confidence: 0.2, probabilities: { low: 0.4, medium: 0.4, high: 0.2 } } }, rounding: { probabilityDecimals: 2 } })
  const h = await harness(); cleanup.push(h.close)
  await send(await h.create('tie', sol))
  expect(ledgerOf(h.settings.stateDirectory!, 'tie').at(-1)).toMatchObject({
    selectedEffort: 'high', decisionReason: 'raised-tie', tied: true, choiceTopMismatch: true,
  })
})

it('stays on the highest offered level when low confidence would raise past it', async () => {
  answer({ answers: { route: { choice: 'high', confidence: 0.1, probabilities: { low: 0.1, medium: 0.2, high: 0.7 } } }, rounding: { probabilityDecimals: 2 } })
  const h = await harness(); cleanup.push(h.close)
  await send(await h.create('cap', sol))
  expect(h.adapter.requests[0]).toMatchObject({ reasoningEffort: 'high' })
  expect(ledgerOf(h.settings.stateDirectory!, 'cap').at(-1)).toMatchObject({ selectedEffort: 'high', decisionReason: 'capped', capped: true, raised: false })
})

it('matches the shared fixture decision', async () => {
  const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../../jev-router-policy/fixtures/dsh-success.json'), 'utf8')) as { body: unknown }
  const expected = decideEffort({
    candidates: ['low', 'medium', 'high'],
    rawChoice: readAnswerChoice(fixture.body, 'route'),
    rawConfidence: readAnswerConfidence(fixture.body, 'route'),
    rawProbabilities: readAnswerProbabilities(fixture.body, 'route'),
    probabilityDecimals: readProbabilityDecimals(fixture.body),
  })
  answer(fixture.body)
  const h = await harness(); cleanup.push(h.close)
  await send(await h.create('fixture', sol))
  expect(expected.ok).toBe(true)
  if (!expected.ok) return
  expect(ledgerOf(h.settings.stateDirectory!, 'fixture').at(-1)).toMatchObject({
    selectedEffort: expected.decision.selectedEffort, decisionReason: expected.decision.decisionReason, policyVersion: POLICY_VERSION,
  })
})

it('reuses one decision for the same evidence and does not raise again', async () => {
  const fetcher = answer({ answers: { route: { choice: 'medium', confidence: 0.4, probabilities: { low: 0.1, medium: 0.5, high: 0.4 } } }, rounding: { probabilityDecimals: 2 } })
  const h = await harness(); cleanup.push(h.close)
  const agent = await h.create('reuse', sol)
  const router = new JevRouter(h.ctx, (await import('../src/config.ts')).resolveConfig(h.settings))
  const messages = [createUserMessage({ content: [{ type: 'text', text: 'same evidence' }], source: { kind: 'user' } })]
  const signal = new AbortController().signal
  const first = await router.main(agent, sol, messages, signal)
  const second = await router.main(agent, sol, messages, signal)
  expect(first.reasoningEffort).toBe(ReasoningEffortId('high'))
  expect(second.reasoningEffort).toBe(first.reasoningEffort)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(ledgerOf(h.settings.stateDirectory!, 'reuse').map(entry => entry.decisionReason)).toEqual(['raised', 'raised'])
  expect(ledgerOf(h.settings.stateDirectory!, 'reuse')[1]).toMatchObject({ reused: true, selectedEffort: 'high' })
})

it('propagates caller cancellation without a fallback request', async () => {
  const controller = new AbortController()
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => { controller.abort(new Error('cancelled')); return new Promise(() => {}) }))
  const h = await harness(); cleanup.push(h.close)
  const agent = await h.create('cancel', sol)
  const router = new JevRouter(h.ctx, (await import('../src/config.ts')).resolveConfig(h.settings))
  const messages = [createUserMessage({ content: [{ type: 'text', text: 'stop' }], source: { kind: 'user' } })]
  await expect(router.main(agent, sol, messages, controller.signal)).rejects.toThrow('cancelled')
  expect(h.adapter.requests).toEqual([])
  expect(existsSync(join(h.settings.stateDirectory!, 'cancel.ledger.jsonl'))).toBe(false)
})

it('keeps a legal effective effort when another update cannot be inserted', async () => {
  const bodies = [
    { answers: { route: { choice: 'low', confidence: 0.9, probabilities: { low: 0.8, medium: 0.1, high: 0.1 } } } },
    { answers: { route: { choice: 'high', confidence: 0.9, probabilities: { low: 0.1, medium: 0.1, high: 0.8 } } } },
  ]
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(bodies.shift())))
  const h = await harness(); cleanup.push(h.close)
  const agent = await h.create('adjacent', sol)
  await send(agent)
  agent.session.append('developer/message', {
    turn: 1, step: 1,
    message: createDeveloperMessage({
      source: { kind: 'jev-configuration-update' },
      content: [{ type: 'configuration-update', effort: 'low', provider: 'test', model: 'gpt-6.1-sol' }],
    }),
  }, { surfaceOp: 'append' })
  await send(agent, 'Change it')
  expect(h.errors).toEqual([])
  expect(h.adapter.requests.map(request => request.reasoningEffort)).toEqual(['low', 'low'])
  expect(configurationUpdates(agent.session.deriveMessages())).toEqual(['low'])
  expect(ledgerOf(h.settings.stateDirectory!, 'adjacent').at(-1)).toMatchObject({
    selectedEffort: 'high', effectiveEffort: 'low', applyStatus: 'not-applied', decisionReason: 'confidence-kept',
  })
})

it('blocks the main request when the effective effort is below the floor', async () => {
  const bodies = [
    { answers: { route: { choice: 'high', confidence: 0.9, probabilities: { medium: 0.2, high: 0.8 } } } },
    { answers: { route: { choice: 'high', confidence: 0.9, probabilities: { medium: 0.2, high: 0.8 } } } },
  ]
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(bodies.shift())))
  const h = await harness({ effortFloors: { 'gpt-6.1-sol': 'medium' } }); cleanup.push(h.close)
  const agent = await h.create('below-floor', sol)
  await send(agent)
  agent.session.append('developer/message', {
    turn: 1, step: 1,
    message: createDeveloperMessage({
      source: { kind: 'jev-configuration-update' },
      content: [{ type: 'configuration-update', effort: 'low', provider: 'test', model: 'gpt-6.1-sol' }],
    }),
  }, { surfaceOp: 'append' })
  await send(agent, 'Should not run')
  expect(h.adapter.requests).toHaveLength(1)
  expect(String(h.errors[0])).toContain('apply-failed')
  expect(ledgerOf(h.settings.stateDirectory!, 'below-floor').at(-1)).toMatchObject({ applyStatus: 'apply-failed', selectedEffort: 'high' })
})
