import { afterEach, expect, it, vi } from 'vitest'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { ApiSessionAgentController } from '../../deepseek-harness/packages/api/session-controller/src/agent.ts'
import { SessionCommandController } from '../../deepseek-harness/packages/api/session-controller/src/commands.ts'
import { installModelSelectionProjection } from '../../deepseek-harness/packages/api/session-controller/src/model-selection-projection.ts'
import { buildModelCatalog } from '../../deepseek-harness/packages/api/session-controller/src/catalog.ts'
import { configurationUpdates, harness, send } from './harness.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.unstubAllGlobals() })

it('Session Controller accepts and logs sentinels while request headers contain only concrete calls', async () => {
  const answers = ['0', 'low', 'high']
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ answers: { route: { choice: answers.shift() } } })))
  const h = await harness(); cleanup.push(h.close)
  await h.ctx.plugin(TypertRegistry)
  await h.ctx.plugin(DefaultModel, { provider: 'test', model: 'gpt-6-sol' })
  installModelSelectionProjection(h.ctx)
  const controller = new SessionCommandController(h.ctx, new ApiSessionAgentController(h.ctx), '/tmp')
  const agent = await h.create('root', { provider: 'test', model: 'gpt-6-sol' })
  await expect(controller.selectModel({ sessionId: agent.id, provider: 'auto', model: 'jev' })).resolves.toEqual({ selected: { provider: 'auto', model: 'jev', reasoningEffort: 'auto/jev' } })
  await send(agent); await send(agent)
  expect(h.errors).toEqual([])
  expect(h.adapter.requests.map(request => [request.provider, request.model, request.reasoningEffort])).toEqual([['test', 'gpt-6-luna', 'low'], ['test', 'gpt-6-luna', 'low']])
  expect(h.adapter.requests.map(request => configurationUpdates(request.messages))).toEqual([[], ['high']])
  const notices = h.adapter.requests.flatMap(request => request.messages).filter(message => 'source' in message && message.source?.kind === 'model-selection')
  expect(notices).toEqual([])
  await expect(controller.selectModel({ sessionId: agent.id, provider: 'test', model: 'gpt-6-sol', reasoningEffort: 'auto/jev' })).resolves.toEqual({ selected: { provider: 'test', model: 'gpt-6-sol', reasoningEffort: 'auto/jev' } })
  await expect(controller.selectModel({ sessionId: agent.id, provider: 'missing', model: 'missing' })).rejects.toMatchObject({ code: 'session/model-unavailable' })
})

it('keeps initial automatic effort as Session selection after a later routing failure', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ answers: { route: { choice: 'low' } } }))
    .mockResolvedValueOnce(new Response('', { status: 500 }))
  vi.stubGlobal('fetch', fetcher)
  const h = await harness(); cleanup.push(h.close)
  installModelSelectionProjection(h.ctx)
  const agent = await h.create('initial-auto', { provider: 'test', model: 'gpt-6-sol', reasoningEffort: ReasoningEffortId('auto/jev') })
  await send(agent)
  expect(agent.session.requestHeader()?.config.reasoningEffort).toBe('low')
  await send(agent)
  expect(h.errors).toHaveLength(1)
  expect(h.ctx.sessionProjections.stateOf(agent.session, 'modelSelection')?.pending)
    .toMatchObject({ provider: 'test', model: 'gpt-6-sol', reasoningEffort: 'auto/jev' })
  expect(agent.session.snapshotEvents().filter(event => event.type === 'model/selection')).toHaveLength(1)
})

it('records auto/jev as the Session selection when the Session was created on auto/jev', async () => {
  const answers = ['0', 'low', 'medium']
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ answers: { route: { choice: answers.shift() } } })))
  const h = await harness(); cleanup.push(h.close)
  installModelSelectionProjection(h.ctx)
  const agent = await h.create('created-auto')
  expect(agent.options).not.toHaveProperty('reasoningEffort')
  await send(agent)
  await send(agent)
  expect(h.errors).toEqual([])
  expect(agent.session.requestHeader()?.config).toMatchObject({ model: 'gpt-6-luna' })
  expect(h.ctx.sessionProjections.stateOf(agent.session, 'modelSelection')?.pending)
    .toMatchObject({ provider: 'auto', model: 'jev', reasoningEffort: 'auto/jev' })
  expect(agent.session.snapshotEvents().filter(event => event.type === 'model/selection')).toHaveLength(1)
  expect(h.adapter.requests.map(request => request.reasoningEffort)).toEqual(['low', 'low'])
  expect(h.adapter.requests.map(request => configurationUpdates(request.messages))).toEqual([[], ['medium']])
})

it('restores automatic effort intent for an older Session without a selection event', async () => {
  const first = await harness(); cleanup.push(first.close)
  const agent = await first.create('old-auto', { provider: 'test', model: 'gpt-6-sol', reasoningEffort: ReasoningEffortId('low') })
  await send(agent)
  const { RouterStore } = await import('../src/store.ts')
  new RouterStore(first.settings.stateDirectory!).write(agent.id, {
    version: 1, selection: { provider: 'test', model: 'gpt-6-sol', reasoningEffort: 'auto/jev' },
    afterSeq: -1, pin: null,
  })
  await first.ctx.fiber.dispose()
  const second = await harness(first.settings, first.root); cleanup.push(second.close)
  installModelSelectionProjection(second.ctx)
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ answers: { route: { choice: 'high' } } })))
  const resumed = (await second.ctx.agents.resume({ resumeSessionId: agent.id })).agent
  await send(resumed)
  expect(second.errors).toEqual([])
  expect(second.ctx.sessionProjections.stateOf(resumed.session, 'modelSelection')?.pending)
    .toMatchObject({ model: 'gpt-6-sol', reasoningEffort: 'auto/jev' })
  expect(new RouterStore(first.settings.stateDirectory!).read(agent.id)?.selection.reasoningEffort).toBe('auto/jev')
})

it('unloading the plugin removes selector acceptance and catalog entries', async () => {
  const h = await harness(); cleanup.push(h.close)
  await h.fiber.dispose()
  const catalog = await buildModelCatalog(h.ctx, { provider: 'test', model: 'gpt-6-sol' })
  expect(catalog.groups.map(group => group.id)).toEqual(['test'])
  expect(catalog.groups[0]?.models[0]?.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'medium', 'high'])
})
