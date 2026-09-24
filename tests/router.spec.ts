import { afterEach, expect, it, vi } from 'vitest'
import { configurationUpdates, harness, send } from './harness.ts'
import { buildModelCatalog } from '../../deepseek-harness/packages/api/session-controller/src/catalog.ts'
import { resolveModelSelection, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

it('offers selector-only auto/jev and automatic effort without registering a generation adapter', async () => {
  const h = await harness(); cleanup.push(h.close)
  const catalog = await buildModelCatalog(h.ctx, { provider: 'test', model: 'gpt-6-sol' })
  expect(catalog.groups.find(group => group.id === 'auto')?.models).toMatchObject([{ id: 'jev', reasoning: { efforts: [{ id: 'auto/jev', name: '自动' }] } }])
  expect(catalog.groups.find(group => group.id === 'test')?.models[0]?.reasoning?.efforts[0]).toMatchObject({ id: 'auto/jev', name: '自动' })
  expect(h.ctx.llm.listProviders().map(provider => provider.id)).toEqual(['test'])
  await expect(resolveModelSelection(h.ctx, { provider: 'auto', model: 'jev' })).resolves.toMatchObject({ provider: 'auto', model: 'jev', reasoningEffort: 'auto/jev' })
})

it.each(['session-title', 'compaction'] as const)('does not ask Jev for %s, and requires a committed model', async purpose => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ answers: { route: { choice: '0' } } }))
  vi.stubGlobal('fetch', fetcher)
  const h = await harness(); cleanup.push(h.close)
  const agent = await h.create()
  const options = { provider: 'auto', model: 'jev', messages: [], sessionId: agent.id, purpose }
  const drain = async () => { for await (const _chunk of h.ctx.llm.stream(options)) { /* consume terminal output */ } }
  await expect(drain()).rejects.toThrow('no session model')
  expect(fetcher).not.toHaveBeenCalled()
  fetcher.mockResolvedValueOnce(Response.json({ answers: { route: { choice: '0' } } }))
    .mockResolvedValueOnce(Response.json({ answers: { route: { choice: 'high' } } }))
  await send(agent)
  await drain()
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(h.adapter.requests.at(-1)).toMatchObject({ provider: 'test', model: 'gpt-6-luna', reasoningEffort: 'medium', purpose })
})

it.each([true, false])('child inherits its parent model and effort selection method (automatic=%s)', async automatic => {
  const answers = ['0', 'high', 'low']
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ answers: { route: { choice: answers.shift() } } }))
  vi.stubGlobal('fetch', fetcher)
  const h = await harness(); cleanup.push(h.close)
  const parent = await h.create('parent')
  if (!automatic) parent.session.append('model/selection', { provider: 'test', model: 'gpt-6-sol', reasoningEffort: ReasoningEffortId('medium') })
  await send(parent)
  const child = (await h.ctx.agents.create({ sessionId: SessionId('child'), parentAgent: parent,
    meta: { parentSession: parent.id }, agentOptions: parent.session.requestHeader()!.config })).agent
  await send(child)
  expect(h.errors).toEqual([])
  expect(h.adapter.requests.at(-1)).toMatchObject(automatic
    ? { model: 'gpt-6-luna', reasoningEffort: 'low' }
    : { model: 'gpt-6-sol', reasoningEffort: 'medium' })
  expect(fetcher).toHaveBeenCalledTimes(automatic ? 3 : 0)
})

it('child cannot select a model before its automatic parent has committed one', async () => {
  const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher)
  const h = await harness(); cleanup.push(h.close)
  const parent = await h.create('parent')
  const child = (await h.ctx.agents.create({ sessionId: SessionId('child'), parentAgent: parent,
    meta: { parentSession: parent.id }, agentOptions: { provider: 'auto', model: 'jev' } })).agent
  await send(child)
  expect(h.errors.map(String)).toEqual([expect.stringContaining('parent has no session model')])
  expect(fetcher).not.toHaveBeenCalled()
  expect(h.adapter.requests).toEqual([])
})

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.unstubAllGlobals() })

it('auto/jev selects a session model then effort, and later requests select only effort', async () => {
  const answers = ['0', 'low', 'high', 'medium']
  const fetcher = vi.fn(async () => Response.json({ answers: { route: { choice: answers.shift() } } }))
  vi.stubGlobal('fetch', fetcher)
  const h = await harness(); cleanup.push(h.close)
  const agent = await h.create()
  await send(agent)
  await send(agent, 'Now investigate its security implications')
  await send(agent, 'Then write the fix')
  expect(h.errors).toEqual([])
  expect(h.adapter.requests.map(({ provider, model, reasoningEffort }) => ({ provider, model, reasoningEffort })))
    .toEqual([
      { provider: 'test', model: 'gpt-6-luna', reasoningEffort: 'low' },
      { provider: 'test', model: 'gpt-6-luna', reasoningEffort: 'low' },
      { provider: 'test', model: 'gpt-6-luna', reasoningEffort: 'low' },
    ])
  expect(h.adapter.requests.map(request => configurationUpdates(request.messages))).toEqual([[], ['high'], ['high', 'medium']])
  const second = h.adapter.requests[1]!
  const highAt = second.messages.findIndex(message => configurationUpdates([message]).length > 0)
  expect(second.messages[highAt + 1]).toMatchObject({ role: 'user' })
  const third = h.adapter.requests[2]!
  const updates = third.messages.flatMap((message, index) => configurationUpdates([message]).map(effort => ({ effort, index, role: message.role })))
  expect(updates.map(update => update.role)).toEqual(['developer', 'developer'])
  expect(updates[1]!.index - updates[0]!.index).toBeGreaterThan(1)
  expect(third.messages[updates[1]!.index + 1]).toMatchObject({ role: 'user' })
  expect(fetcher).toHaveBeenCalledTimes(4)
  expect(agent.session.requestHeader()?.config).toMatchObject({ provider: 'test', model: 'gpt-6-luna', reasoningEffort: 'low' })
})
