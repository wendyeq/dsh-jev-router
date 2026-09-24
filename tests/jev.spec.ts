import { afterEach, expect, it, vi } from 'vitest'
import { evaluate, JevUnavailableError } from '../src/jev.ts'
import type { EvaluationRecord } from '../src/jev.ts'
import { resolveConfig } from '../src/config.ts'

const credentials = { resolve: vi.fn(async () => ({ value: 'test-token', source: 'test' })) }
const messages = [{ role: 'user' as const, text: 'Fix the parser' }]
const choices = [{ key: 'low', description: 'Low' }, { key: 'high', description: 'High' }]
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
const config = resolveConfig({ enabled: true, credentialRefs: ['JEV_TOKEN'], candidates: [{ model: 'fixture', description: 'Fixture' }] })
const run = (signal = new AbortController().signal) => evaluate(credentials, config, messages, choices, 'effort', signal)

it('skips credentials and HTTP for one option, and rejects an empty option list', async () => {
  const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher)
  const unavailable = { resolve: vi.fn(async () => undefined) }
  await expect(evaluate(unavailable, config, messages, choices.slice(0, 1), 'effort', new AbortController().signal)).resolves.toEqual(choices[0])
  await expect(evaluate(unavailable, config, messages, [], 'model', new AbortController().signal)).rejects.toThrow('no available choices')
  expect(fetcher).not.toHaveBeenCalled(); expect(unavailable.resolve).not.toHaveBeenCalled()
})

it.each(['not-offered', '01', '__proto__'])('rejects criteria key %s without retry', async choice => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ answers: { route: { choice } } })); vi.stubGlobal('fetch', fetcher)
  await expect(run()).rejects.toThrow('outside the offered criteria')
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('waits one second after each 503 and succeeds on the third attempt', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockResolvedValueOnce(Response.json({ answers: { route: { choice: 'high' } } }))
  vi.stubGlobal('fetch', fetcher)
  const started = Date.now()
  await expect(run()).resolves.toEqual(choices[1])
  expect(Date.now() - started).toBeGreaterThanOrEqual(1900)
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it('retries a stalled attempt after 503, cancels each stalled request, and reports the last failure', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockReturnValue(new Promise<Response>(() => {}))
  vi.stubGlobal('fetch', fetcher)
  const error = await evaluate(credentials, { ...config, timeoutMs: 50 }, messages, choices, 'effort', new AbortController().signal).catch(e => e)
  expect(error).toBeInstanceOf(JevUnavailableError)
  expect(error.reason).toBe('timeout')
  expect(fetcher).toHaveBeenCalledTimes(3)
  expect(fetcher.mock.calls.slice(1).map(call => call[1]?.signal?.aborted)).toEqual([true, true])
})

it('retries network errors and succeeds on a later attempt', async () => {
  const records: string[] = []
  const fetcher = vi.fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError('fetch failed'))
    .mockResolvedValueOnce(Response.json({ answers: { route: { choice: 'high' } } }))
  vi.stubGlobal('fetch', fetcher)
  await expect(evaluate(credentials, config, messages, choices, 'effort', new AbortController().signal, message => records.push(message)))
    .resolves.toEqual(choices[1])
  expect(records[0]).toMatch(/^effort attempt=1\/3 error=network durationMs=\d+$/)
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('logs only status, attempt, duration and offered choice without leaking input or token', async () => {
  const records: string[] = []
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockResolvedValueOnce(Response.json({ answers: { route: { choice: 'low' } } }))
  vi.stubGlobal('fetch', fetcher)
  await evaluate(credentials, config, [{ role: 'user', text: 'private-prompt' }], choices, 'effort',
    new AbortController().signal, message => records.push(message))
  expect(records).toHaveLength(3)
  expect(records[0]).toMatch(/attempt=1\/3 status=503 durationMs=\d+/)
  expect(records[1]).toMatch(/attempt=2\/3 status=200 durationMs=\d+/)
  expect(records[2]).toBe('effort choice=low')
  expect(records.join(' ')).not.toMatch(/private-prompt|test-token/)
})

it('fails after three HTTP 503 responses', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 503 })); vi.stubGlobal('fetch', fetcher)
  await expect(run()).rejects.toBeInstanceOf(JevUnavailableError)
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it.each([400, 401, 403, 404])('fails HTTP %s without retry or a substitute choice', async status => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status })); vi.stubGlobal('fetch', fetcher)
  const error = await run().catch(e => e)
  expect(error.message).toContain(`HTTP ${status}`)
  expect(error).not.toBeInstanceOf(JevUnavailableError)
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it.each([408, 429, 500, 502, 504])('retries temporary HTTP %s up to three attempts', async status => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status })); vi.stubGlobal('fetch', fetcher)
  const error = await run().catch(e => e)
  expect(error).toBeInstanceOf(JevUnavailableError)
  expect(error.reason).toBe(`HTTP ${status}`)
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it('rejects malformed JSON answers and credential absence', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ choice: 'low' })))
  await expect(run()).rejects.toThrow()
  await expect(evaluate({ resolve: async () => undefined }, config, messages, choices, 'model', new AbortController().signal)).rejects.toThrow('credential unavailable')
})

it('enforces UTF-8 bytes on the entire serialized request before HTTP', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ answers: { route: { choice: 'low' } } })); vi.stubGlobal('fetch', fetcher)
  await run()
  const bytes = Buffer.byteLength(String(fetcher.mock.calls[0]![1]?.body))
  await expect(evaluate(credentials, { ...config, maxBodyBytes: bytes }, messages, choices, 'effort', new AbortController().signal)).resolves.toEqual(choices[0])
  expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body)).state.messages).toEqual(messages)
  const huge = [{ key: 'low', description: 'x'.repeat(config.maxBodyBytes) }, choices[1]!]
  await expect(evaluate(credentials, config, messages, huge, 'effort', new AbortController().signal)).rejects.toThrow('maxBodyBytes')
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('keeps an oversized latest user message as head and tail with an omission marker instead of failing', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ answers: { route: { choice: 'low' } } })); vi.stubGlobal('fetch', fetcher)
  const records: string[] = []
  const text = '头'.repeat(5000) + '汉'.repeat(5000) + '尾'.repeat(5000)
  const history = [{ role: 'user' as const, text: 'older request' }, { role: 'assistant' as const, text: 'older answer' }, { role: 'user' as const, text }]
  await expect(evaluate(credentials, config, history, choices, 'model', new AbortController().signal, message => records.push(message)))
    .resolves.toEqual(choices[0])
  const body = String(fetcher.mock.calls[0]![1]?.body)
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(config.maxBodyBytes)
  const sent = JSON.parse(body).state.messages as { role: string; text: string }[]
  expect(sent).toHaveLength(1)
  expect(sent[0]!.text).toMatch(/^头+[\s\S]*omitted \d+ of 15000 characters[\s\S]*尾+$/)
  expect(records[0]).toMatch(/^model fit dropped=2 omittedChars=\d+$/)
  expect(records.join(' ')).not.toMatch(/头|汉|older/)
})

it('bounds a stalled credential lookup to five seconds without retrying it', async () => {
  vi.useFakeTimers()
  const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher)
  const pending = evaluate({ resolve: () => new Promise<never>(() => {}) }, config, messages, choices, 'effort', new AbortController().signal)
  const assertion = expect(pending).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(5000)
  await assertion
  expect(fetcher).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['fetch', 'json'] as const)('retries a stalled %s phase within the 17-second ceiling', async phase => {
  vi.useFakeTimers()
  const never = new Promise<never>(() => {})
  const fetcher = vi.fn<typeof fetch>(() => {
    if (phase === 'fetch') return never
    const response = Response.json({ answers: { route: { choice: 'low' } } })
    vi.spyOn(response, 'json').mockReturnValue(never)
    return Promise.resolve(response)
  }); vi.stubGlobal('fetch', fetcher)
  let settled = false
  const pending = evaluate(credentials, config, messages, choices, 'effort', new AbortController().signal).finally(() => { settled = true })
  const assertion = expect(pending).rejects.toBeInstanceOf(JevUnavailableError)
  await vi.advanceTimersByTimeAsync(16999)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await assertion
  expect(fetcher).toHaveBeenCalledTimes(3)
  expect(vi.getTimerCount()).toBe(0)
})

it('caller cancellation during the retry delay settles with the caller reason', async () => {
  const controller = new AbortController()
  const fetcher = vi.fn<typeof fetch>(async () => {
    setTimeout(() => controller.abort(new Error('cancelled by user')), 10)
    return new Response('', { status: 503 })
  }); vi.stubGlobal('fetch', fetcher)
  await expect(evaluate(credentials, config, messages, choices, 'effort', controller.signal)).rejects.toThrow('cancelled by user')
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('caller cancellation settles even if credential lookup ignores cancellation', async () => {
  const controller = new AbortController()
  const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher)
  const pending = evaluate({ resolve: () => new Promise(() => {}) }, config, messages, choices, 'model', controller.signal)
  controller.abort(new Error('cancelled by user'))
  await expect(pending).rejects.toThrow('cancelled by user')
  expect(fetcher).not.toHaveBeenCalled()
  await expect(evaluate(credentials, config, messages, choices.slice(0, 1), 'model', controller.signal)).rejects.toThrow('cancelled by user')
})

it('asks one question and accepts only an offered criteria key', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ answers: { route: { choice: 'low' } } }))
  vi.stubGlobal('fetch', fetcher)
  const chosen = await evaluate(credentials, config,
    messages, choices, 'effort', new AbortController().signal)
  expect(chosen).toEqual(choices[0])
  const [url, request] = fetcher.mock.calls[0]!
  expect(url).toBe('https://ai-gateway.vercel.sh/v1/evaluate')
  expect(request?.headers).toEqual({ Authorization: 'Bearer test-token', 'Content-Type': 'application/json' })
  expect(JSON.parse(String(request?.body))).toMatchObject({
    model: 'typesafe-ai/jev', state: { messages },
    questions: { route: { type: 'choice', criteria: { low: 'Low', high: 'High' } } },
  })
})

it('reports outcome, attempts, tokens and gateway cost once per evaluation', async () => {
  const reports: unknown[] = []
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockResolvedValueOnce(Response.json({ answers: { route: { choice: 'high' } },
      usage: { inputTokens: 499, outputTokens: 32 }, providerMetadata: { gateway: { cost: '0.0000125' } } }))
  vi.stubGlobal('fetch', fetcher)
  await evaluate(credentials, config, messages, choices, 'effort', new AbortController().signal, undefined, record => reports.push(record))
  expect(reports).toEqual([expect.objectContaining({ question: 'effort', outcome: 'chosen', choice: 'high', attempts: 2,
    inputTokens: 499, outputTokens: 32, cost: 0.0000125, durationMs: expect.any(Number) })])
})

it('reports failures with short labels and ignores malformed metering', async () => {
  const reports: EvaluationRecord[] = []
  const report = (record: EvaluationRecord) => { reports.push(record) }
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('secret body', { status: 401 })))
  await evaluate(credentials, config, messages, choices, 'effort', new AbortController().signal, undefined, report).catch(() => {})
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('', { status: 503 })))
  await evaluate(credentials, config, messages, choices, 'effort', new AbortController().signal, undefined, report).catch(() => {})
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ answers: {}, usage: { inputTokens: 'many' } })))
  await evaluate(credentials, config, messages, choices, 'effort', new AbortController().signal, undefined, report).catch(() => {})
  await evaluate(credentials, config, messages, choices.slice(0, 1), 'effort', new AbortController().signal, undefined, report)
  expect(reports.map(({ outcome, reason }) => [outcome, reason])).toEqual([
    ['failed', 'HTTP 401'], ['unavailable', 'HTTP 503'], ['failed', 'invalid-answer'], ['single', undefined],
  ])
  expect(reports[2]!.inputTokens).toBeUndefined()
  expect(JSON.stringify(reports)).not.toContain('secret')
})

it('does not report a caller cancellation', async () => {
  const report = vi.fn()
  const controller = new AbortController()
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => { controller.abort(new Error('cancelled')); return new Promise(() => {}) }))
  await expect(evaluate(credentials, config, messages, choices, 'effort', controller.signal, undefined, report)).rejects.toThrow('cancelled')
  expect(report).not.toHaveBeenCalled()
})
