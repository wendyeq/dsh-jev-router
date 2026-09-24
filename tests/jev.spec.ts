import { afterEach, expect, it, vi } from 'vitest'
import { evaluate, JevUnavailableError } from '../src/jev.ts'
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
  expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(fetcher.mock.calls[2]?.[1]?.signal)
})

it('bounds a stalled attempt after 503 and cancels pending work', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockReturnValueOnce(new Promise<Response>(() => {}))
  vi.stubGlobal('fetch', fetcher)
  await expect(evaluate(credentials, { ...config, timeoutMs: 50 }, messages, choices, 'effort', new AbortController().signal))
    .rejects.toThrow('timed out')
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

it.each([401, 429, 500])('fails HTTP %s without retry or a substitute choice', async status => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status })); vi.stubGlobal('fetch', fetcher)
  await expect(run()).rejects.toThrow(`HTTP ${status}`)
  expect(fetcher).toHaveBeenCalledTimes(1)
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
  await expect(evaluate(credentials, { ...config, maxBodyBytes: bytes - 1 }, messages, choices, 'effort', new AbortController().signal)).rejects.toThrow('maxBodyBytes')
  await expect(evaluate(credentials, config, [{ role: 'user', text: '汉'.repeat(10000) }], choices, 'model', new AbortController().signal)).rejects.toThrow('maxBodyBytes')
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it.each(['credentials', 'fetch', 'json'] as const)('bounds a stalled %s phase to five seconds', async phase => {
  vi.useFakeTimers()
  const never = new Promise<never>(() => {})
  const resolver = phase === 'credentials' ? { resolve: () => never } : credentials
  const response = Response.json({ answers: { route: { choice: 'low' } } })
  if (phase === 'json') vi.spyOn(response, 'json').mockReturnValue(never)
  const fetcher = vi.fn<typeof fetch>(() => phase === 'fetch' ? never : Promise.resolve(response)); vi.stubGlobal('fetch', fetcher)
  const pending = evaluate(resolver, config, messages, choices, 'effort', new AbortController().signal)
  const assertion = expect(pending).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(5000)
  await assertion
  expect(fetcher).toHaveBeenCalledTimes(phase === 'credentials' ? 0 : 1)
  expect(vi.getTimerCount()).toBe(0)
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
