import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReasoningEffortId, createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { evaluationMessages } from '../src/messages.ts'
import { JevRouter } from '../src/router.ts'
import { AUTO_EFFORT } from '../src/router.ts'
import * as plugin from '../src/index.ts'
import { configurationUpdates, harness, send } from './harness.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals() })
function gateway(...choices: string[]) {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ answers: { route: { choice: choices.shift() } } }))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

it.each([true, false])('specified model stays unchanged with automatic effort=%s', async automatic => {
  const fetcher = gateway('low', 'high')
  const h = await harness(); cleanup.push(h.close)
  const agent = await h.create()
  agent.session.append('model/selection', { provider: 'test', model: 'gpt-6-sol', reasoningEffort: automatic ? AUTO_EFFORT : ReasoningEffortId('medium') })
  await send(agent); await send(agent)
  expect(h.errors).toEqual([])
  expect(h.adapter.requests.map(request => [request.model, request.reasoningEffort])).toEqual([
    ['gpt-6-sol', automatic ? 'low' : 'medium'], ['gpt-6-sol', automatic ? 'low' : 'medium'],
  ])
  expect(h.adapter.requests.map(request => configurationUpdates(request.messages))).toEqual(automatic ? [[], ['high']] : [[], []])
  expect(fetcher).toHaveBeenCalledTimes(automatic ? 2 : 0)
})

it('selecting auto/jev again invalidates the old session model, even without a request header change', async () => {
  const fetcher = gateway('0', 'low', '2', 'high')
  const h = await harness(); cleanup.push(h.close)
  const agent = await h.create()
  agent.session.append('model/selection', { provider: 'auto', model: 'jev', reasoningEffort: AUTO_EFFORT })
  await send(agent)
  agent.session.append('model/selection', { provider: 'auto', model: 'jev', reasoningEffort: AUTO_EFFORT })
  await send(agent)
  expect(h.adapter.requests.map(request => request.model)).toEqual(['gpt-6-luna', 'gpt-6-astra'])
  expect(fetcher).toHaveBeenCalledTimes(4)
})

it('a committed model survives a tool-only recent window and still selects effort', async () => {
  const fetcher = gateway('0', 'low', 'high')
  const h = await harness(); cleanup.push(h.close)
  const agent = await h.create()
  await send(agent)
  const history = Array.from({ length: 9 }, (_, index) =>
    index % 2 === 0
      ? createToolResultMessage({ callId: ToolCallId(`call-${index}`), isError: false, content: [{ type: 'text', text: 'tool output' }] })
      : createAssistantMessage({ source: { provider: 'test', model: 'gpt-6-luna' }, content: [{ type: 'text', text: 'continuing' }] }))
  expect(evaluationMessages(history, 'model').some(message => message.role === 'user')).toBe(false)
  const router = new JevRouter(h.ctx, (await import('../src/config.ts')).resolveConfig(h.settings))
  const resolved = await router.main(agent, { provider: 'auto', model: 'jev', reasoningEffort: AUTO_EFFORT }, history, new AbortController().signal)
  expect(resolved).toMatchObject({ model: 'gpt-6-luna', reasoningEffort: 'low' })
  expect(configurationUpdates(agent.session.deriveMessages())).toEqual(['high'])
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it('real Session resume retains the session model but evaluates a fresh effort', async () => {
  const fetcher = gateway('1', 'high', 'low')
  const first = await harness(); cleanup.push(first.close)
  const agent = await first.create()
  await send(agent)
  await first.ctx.fiber.dispose()
  const second = await harness(first.settings, first.root); cleanup.push(second.close)
  const resumed = (await second.ctx.agents.resume({ resumeSessionId: agent.id })).agent
  await send(resumed)
  expect(second.errors).toEqual([])
  expect(second.adapter.requests[0]).toMatchObject({ model: 'gpt-6-sol', reasoningEffort: 'high' })
  expect(configurationUpdates(second.adapter.requests[0]!.messages)).toEqual(['low'])
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it('changing task descriptions during plugin reload does not reselect the session model', async () => {
  const fetcher = gateway('1', 'high', 'low')
  const h = await harness(); cleanup.push(h.close)
  const agent = await h.create()
  await send(agent)
  await h.fiber.dispose()
  await h.ctx.plugin(plugin, { ...h.settings, candidates: [{ model: 'gpt-6-luna', description: 'Changed description' }] })
  await send(agent)
  expect(h.errors).toEqual([])
  expect(h.adapter.requests.map(request => request.model)).toEqual(['gpt-6-sol', 'gpt-6-sol'])
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it('first effort failure leaves no session model, while later effort failure preserves it', async () => {
  const fetcher = gateway('0', 'invalid', '1', 'high', 'invalid', 'low')
  const h = await harness(); cleanup.push(h.close)
  const agent = await h.create()
  await send(agent)
  expect(h.adapter.requests).toHaveLength(0)
  await send(agent)
  await send(agent)
  await send(agent)
  expect(h.errors).toHaveLength(2)
  expect(h.adapter.requests.map(request => [request.model, request.reasoningEffort])).toEqual([['gpt-6-sol', 'high'], ['gpt-6-sol', 'high']])
  expect(h.adapter.requests.map(request => configurationUpdates(request.messages))).toEqual([[], ['low']])
  expect(fetcher).toHaveBeenCalledTimes(6)
})

it('keeps the last supported effort after three 503 responses', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ answers: { route: { choice: 'high' } } }))
    .mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockResolvedValueOnce(new Response('', { status: 503 }))
  vi.stubGlobal('fetch', fetcher)
  const h = await harness(); cleanup.push(h.close)
  const agent = await h.create('fallback-existing', { provider: 'test', model: 'gpt-6-sol', reasoningEffort: AUTO_EFFORT })
  await send(agent); await send(agent)
  expect(h.errors).toEqual([])
  expect(h.adapter.requests.map(request => request.reasoningEffort)).toEqual(['high', 'high'])
  expect(fetcher).toHaveBeenCalledTimes(4)
})

it('uses the adapter default on the first effort check after three 503 responses', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 503 })); vi.stubGlobal('fetch', fetcher)
  const h = await harness(); cleanup.push(h.close)
  const agent = await h.create('fallback-first', { provider: 'test', model: 'gpt-6-sol', reasoningEffort: AUTO_EFFORT })
  await send(agent)
  expect(h.errors).toEqual([])
  expect(h.adapter.requests[0]).toMatchObject({ model: 'gpt-6-sol', reasoningEffort: 'medium' })
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it('commits an auto-selected model when its first effort check exhausts 503 retries', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ answers: { route: { choice: '1' } } }))
    .mockResolvedValue(new Response('', { status: 503 }))
  vi.stubGlobal('fetch', fetcher)
  const h = await harness(); cleanup.push(h.close)
  const agent = await h.create('fallback-auto')
  await send(agent)
  expect(h.errors).toEqual([])
  expect(h.adapter.requests[0]).toMatchObject({ model: 'gpt-6-sol', reasoningEffort: 'medium' })
  expect(new (await import('../src/store.ts')).RouterStore(h.settings.stateDirectory!).read(agent.id)?.pin)
    .toMatchObject({ model: 'gpt-6-sol' })
  expect(fetcher).toHaveBeenCalledTimes(4)
})

it('falls back on effort after repeated network errors but still fails model selection', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => { throw new TypeError('fetch failed') }); vi.stubGlobal('fetch', fetcher)
  const h = await harness(); cleanup.push(h.close)
  const specified = await h.create('network-effort', { provider: 'test', model: 'gpt-6-sol', reasoningEffort: AUTO_EFFORT })
  await send(specified)
  expect(h.errors).toEqual([])
  expect(h.adapter.requests[0]).toMatchObject({ model: 'gpt-6-sol', reasoningEffort: 'medium' })
  const automatic = await h.create('network-model')
  await send(automatic)
  expect(h.errors).toHaveLength(1)
  expect(String(h.errors[0])).toContain('network')
  expect(h.adapter.requests).toHaveLength(1)
  expect(fetcher).toHaveBeenCalledTimes(6)
})

const sol = { provider: 'test', model: 'gpt-6-sol', reasoningEffort: AUTO_EFFORT }
const criteriaOf = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>, call: number) =>
  Object.keys(JSON.parse(String(fetcher.mock.calls[call]![1]?.body)).questions.route.criteria)

it('offers only efforts at or above the floor, preferring the provider/model key', async () => {
  const fetcher = gateway('medium')
  const h = await harness({ effortFloors: { 'gpt-6-sol': 'high', 'test/gpt-6-sol': 'medium' } }); cleanup.push(h.close)
  await send(await h.create('floor', sol))
  expect(h.errors).toEqual([])
  expect(criteriaOf(fetcher, 0)).toEqual(['medium', 'high'])
  expect(h.adapter.requests[0]).toMatchObject({ model: 'gpt-6-sol', reasoningEffort: 'medium' })
})

it('uses the floor without asking Jev when it leaves one effort', async () => {
  const fetcher = gateway()
  const h = await harness({ effortFloors: { 'gpt-6-sol': 'high' } }); cleanup.push(h.close)
  await send(await h.create('floor-single', sol))
  expect(h.errors).toEqual([])
  expect(h.adapter.requests[0]).toMatchObject({ reasoningEffort: 'high' })
  expect(fetcher).not.toHaveBeenCalled()
})

it('applies the floor to the effort of an auto-selected model', async () => {
  const fetcher = gateway('1', 'high')
  const h = await harness({ effortFloors: { 'gpt-6-sol': 'medium' } }); cleanup.push(h.close)
  await send(await h.create('floor-auto'))
  expect(h.errors).toEqual([])
  expect(h.adapter.requests[0]).toMatchObject({ model: 'gpt-6-sol', reasoningEffort: 'high' })
  expect(criteriaOf(fetcher, 1)).toEqual(['medium', 'high'])
})

it('leaves an explicitly selected effort below the floor unchanged', async () => {
  const fetcher = gateway()
  const h = await harness({ effortFloors: { 'gpt-6-sol': 'high' } }); cleanup.push(h.close)
  await send(await h.create('floor-explicit', { ...sol, reasoningEffort: ReasoningEffortId('low') }))
  expect(h.errors).toEqual([])
  expect(h.adapter.requests[0]).toMatchObject({ reasoningEffort: 'low' })
  expect(fetcher).not.toHaveBeenCalled()
})

it('fails instead of ignoring a floor the model does not support', async () => {
  const fetcher = gateway()
  const h = await harness({ effortFloors: { 'gpt-6-sol': 'xhigh' } }); cleanup.push(h.close)
  await send(await h.create('floor-unsupported', sol))
  expect(String(h.errors[0])).toContain('effort floor xhigh is not supported by test/gpt-6-sol')
  expect(h.adapter.requests).toEqual([])
  expect(fetcher).not.toHaveBeenCalled()
})

it('raises an adapter default below the floor to the floor when Jev is unavailable', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 503 })); vi.stubGlobal('fetch', fetcher)
  const records: string[] = []
  const h = await harness({ effortFloors: { 'gpt-6-sol': 'medium' }, logDecisions: true }); cleanup.push(h.close)
  const sol6 = h.adapter.models.findIndex(model => model.id === 'gpt-6-sol')
  h.adapter.models[sol6] = { ...h.adapter.models[sol6]!, reasoning: { ...h.adapter.models[sol6]!.reasoning!, defaultEffort: ReasoningEffortId('low') } }
  vi.spyOn(h.ctx.logger, 'info').mockImplementation((message: unknown) => { records.push(String(message)) })
  await send(await h.create('floor-fallback', sol))
  expect(h.errors).toEqual([])
  expect(h.adapter.requests[0]).toMatchObject({ reasoningEffort: 'medium' })
  expect(records.some(record => record.includes('fallback=medium source=floor'))).toBe(true)
})

const ledgerOf = (directory: string, id: string) => readFileSync(join(directory, `${id}.ledger.jsonl`), 'utf8')
  .trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)

it('records model and effort outcomes with usage in a private per-session ledger, without text', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ answers: { route: { choice: '1' } }, usage: { inputTokens: 400, outputTokens: 20 }, providerMetadata: { gateway: { cost: '0.001' } } }))
    .mockResolvedValueOnce(Response.json({ answers: { route: { choice: 'high' } }, usage: { inputTokens: 300, outputTokens: 10 } }))
  vi.stubGlobal('fetch', fetcher)
  const h = await harness(); cleanup.push(h.close)
  const agent = await h.create('ledger')
  await send(agent, 'private-prompt')
  expect(h.errors).toEqual([])
  const entries = ledgerOf(h.settings.stateDirectory!, 'ledger')
  expect(entries).toEqual([
    expect.objectContaining({ question: 'model', outcome: 'chosen', model: 'test/gpt-6-sol', attempts: 1, inputTokens: 400, outputTokens: 20, cost: 0.001 }),
    expect.objectContaining({ question: 'effort', outcome: 'chosen', model: 'test/gpt-6-sol', choice: 'high', inputTokens: 300 }),
  ])
  expect(entries[0]).not.toHaveProperty('choice')
  expect(entries.every(entry => typeof entry.time === 'string')).toBe(true)
  expect(statSync(join(h.settings.stateDirectory!, 'ledger.ledger.jsonl')).mode & 0o777).toBe(0o600)
  expect(JSON.stringify(entries)).not.toContain('private-prompt')
})

it('records an effort fallback after the unavailable evaluation', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('', { status: 503 })))
  const h = await harness(); cleanup.push(h.close)
  await send(await h.create('ledger-fallback', sol))
  expect(ledgerOf(h.settings.stateDirectory!, 'ledger-fallback').map(({ outcome, choice, source, reason }) => ({ outcome, choice, source, reason }))).toEqual([
    { outcome: 'unavailable', choice: undefined, source: undefined, reason: 'HTTP 503' },
    { outcome: 'fallback', choice: 'medium', source: 'adapter-default', reason: 'HTTP 503' },
  ])
})

it('publishes the effective policy and can disable the ledger', async () => {
  gateway('1', 'high')
  const h = await harness({ ledger: false, effortFloors: { 'gpt-6-sol': 'medium' } }); cleanup.push(h.close)
  await send(await h.create('no-ledger'))
  expect(() => statSync(join(h.settings.stateDirectory!, 'no-ledger.ledger.jsonl'))).toThrow()
  const policy = JSON.parse(readFileSync(join(h.settings.stateDirectory!, '_policy.json'), 'utf8'))
  expect(policy).toMatchObject({ version: 1, candidates: h.settings.candidates, effortFloors: { 'gpt-6-sol': 'medium' } })
  expect(JSON.stringify(policy)).not.toContain('JEV_TOKEN')
})

it('writes private diagnostic records without conversation text or credentials', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jev-diagnostics-'))
  const filename = join(directory, 'private', 'jev.jsonl')
  const h = await harness({ diagnosticLogFile: filename }); cleanup.push(h.close, async () => { rmSync(directory, { recursive: true, force: true }) })
  const fetcher = gateway('high')
  const agent = await h.create('diagnostics', { provider: 'test', model: 'gpt-6-sol', reasoningEffort: AUTO_EFFORT })
  await send(agent, 'SECRET-CONVERSATION')
  expect(h.errors).toEqual([])
  expect(fetcher).toHaveBeenCalledTimes(1)
  const records = readFileSync(filename, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(records.map(record => record.message)).toEqual([
    expect.stringMatching(/effort attempt=1\/3 status=200 durationMs=\d+/),
    'effort choice=high',
    'resolved provider=test model=gpt-6-sol effort=high',
  ])
  expect(records.every(record => record.sessionId === agent.id)).toBe(true)
  expect(JSON.stringify(records)).not.toMatch(/SECRET-CONVERSATION|test-token/)
  if (process.platform !== 'win32') expect(statSync(filename).mode & 0o077).toBe(0)
})

it('an empty user body never evaluates or saves a session model', async () => {
  const fetcher = gateway()
  const h = await harness(); cleanup.push(h.close)
  const agent = await h.create()
  agent.followup((await import('@deepseek-ai/dsh-llm')).createUserMessage({
    content: [{ type: 'image', attachment: { attachmentId: (await import('@deepseek-ai/dsh-attachment')).AttachmentId('a'.repeat(64)), mediaType: 'image/png', width: 1, height: 1, bytes: 1 } }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  expect(h.errors).toHaveLength(1)
  expect(h.adapter.requests).toEqual([])
  expect(fetcher).not.toHaveBeenCalled()
})

it('disabled plugins leave concrete requests and the directory unchanged', async () => {
  const fetcher = gateway()
  const h = await harness({ enabled: false }); cleanup.push(h.close)
  const agent = await h.create('root', { provider: 'test', model: 'gpt-6-sol' })
  await send(agent)
  expect(h.errors).toEqual([])
  expect(h.adapter.requests[0]).toMatchObject({ model: 'gpt-6-sol', reasoningEffort: 'medium' })
  expect(fetcher).not.toHaveBeenCalled()
})
