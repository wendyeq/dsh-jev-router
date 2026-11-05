import { afterEach, expect, it, vi } from 'vitest'
import { ReasoningEffortId, type RequestMessage } from '@deepseek-ai/dsh-llm'
import { planEffortChange, planExplicitEffort } from '../src/effort.ts'
import { AUTO_EFFORT } from '../src/router.ts'
import { configurationUpdates, harness, send } from './harness.ts'

const route = { provider: 'test', model: 'gpt-6-luna' }
const user = (text: string): RequestMessage => ({ role: 'user', content: [{ type: 'text', text }] })
const update = (effort: string, model = route.model): RequestMessage => ({
  role: 'developer',
  content: [{ type: 'configuration-update', effort, provider: route.provider, model }],
  source: { kind: 'jev-configuration-update' },
  id: '00000000-0000-4000-8000-000000000001' as never,
})

it('sets the first effort on the request and keeps it when a later effort changes', () => {
  const first = planEffortChange(undefined, route, 'low', [user('a')])
  expect(first).toMatchObject({ requestEffort: 'low', effectiveEffort: 'low', append: false })
  const second = planEffortChange(first.wire, route, 'high', [user('a')])
  expect(second).toMatchObject({ requestEffort: 'low', effectiveEffort: 'high', append: true })
  const third = planEffortChange(second.wire, route, 'medium', [user('a'), update('high'), user('b')])
  expect(third).toMatchObject({ requestEffort: 'low', effectiveEffort: 'medium', append: true })
})

it('does not append a second update beside the previous one', () => {
  const wire = { ...route, requestEffort: 'low', effectiveEffort: 'high' }
  const held = planEffortChange(wire, route, 'medium', [user('a'), update('high')])
  expect(held).toMatchObject({ requestEffort: 'low', effectiveEffort: 'high', append: false })
})

it('restates the request effort after compaction drops the update', () => {
  const wire = { ...route, requestEffort: 'low', effectiveEffort: 'high' }
  const fresh = planEffortChange(wire, route, 'high', [user('summary')])
  expect(fresh).toMatchObject({ requestEffort: 'low', effectiveEffort: 'high', append: true })
})

it('sends a manual effort on the request and overrides an older update', () => {
  const selected = planExplicitEffort(route, 'xhigh', [user('a')])
  expect(selected).toMatchObject({ requestEffort: 'xhigh', effectiveEffort: 'xhigh', append: false })
  const overridden = planExplicitEffort(route, 'xhigh', [user('a'), update('high'), user('b')])
  expect(overridden).toMatchObject({ requestEffort: 'xhigh', effectiveEffort: 'xhigh', append: true })
  const blocked = planExplicitEffort(route, 'xhigh', [user('a'), update('high')])
  expect(blocked).toMatchObject({ requestEffort: 'xhigh', effectiveEffort: 'high', append: false })
})

it('starts a new request-level effort when the model changes, and restates over a stale update', () => {
  const luna = { ...route, requestEffort: 'low', effectiveEffort: 'high' }
  const astra = planEffortChange(luna, { provider: 'test', model: 'gpt-6-astra' }, 'medium', [user('a'), update('high')])
  expect(astra).toMatchObject({ requestEffort: 'medium', effectiveEffort: 'medium', append: false })
  const back = planEffortChange(astra.wire, route, 'low', [user('a'), update('high'), user('b')])
  expect(back).toMatchObject({ requestEffort: 'low', effectiveEffort: 'low', append: true })
})

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.unstubAllGlobals() })

it('reports the effort in effect before the decision, preferring the wire over the request header', async () => {
  const answers = ['low', 'high', 'medium']
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ answers: { route: { choice: answers.shift() } } }))
  vi.stubGlobal('fetch', fetcher)
  const h = await harness(); cleanup.push(h.close)
  const agent = await h.create('current-effort', { ...route, reasoningEffort: AUTO_EFFORT })
  await send(agent); await send(agent); await send(agent)
  expect(h.errors).toEqual([])
  const states = fetcher.mock.calls.map(call => JSON.parse(String(call[1]?.body)).state)
  expect(states[0].currentEffort).toBeNull()
  expect(states[0].modelId).toBe('test/gpt-6-luna')
  expect(states[1].currentEffort).toBe('low')
  expect(states[2].currentEffort).toBe('high')
  expect(agent.session.requestHeader()?.config.reasoningEffort).toBe('low')
})

it('does not report a previous effort from another route', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ answers: { route: { choice: 'high' } } }))
  vi.stubGlobal('fetch', fetcher)
  const h = await harness(); cleanup.push(h.close)
  const agent = await h.create('other-route', { ...route, reasoningEffort: AUTO_EFFORT })
  await send(agent)
  agent.session.append('model/selection', { provider: 'test', model: 'gpt-6.1-sol', reasoningEffort: AUTO_EFFORT })
  await send(agent)
  expect(h.errors).toEqual([])
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body)).state.currentEffort).toBeNull()
})

it('omits a previous effort that is no longer offered above the floor', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ answers: { route: { choice: 'medium' } } }))
  vi.stubGlobal('fetch', fetcher)
  const h = await harness({ effortFloors: { [route.model]: 'medium' } }); cleanup.push(h.close)
  const agent = await h.create('below-floor', { ...route, reasoningEffort: AUTO_EFFORT })
  vi.spyOn(agent.session, 'requestHeader').mockReturnValue({ config: { ...route, reasoningEffort: 'low' } } as never)
  await send(agent)
  expect(h.errors).toEqual([])
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).state.currentEffort).toBeNull()
})

it('reports the same-route request header effort when there is no wire', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ answers: { route: { choice: 'low' } } }))
  vi.stubGlobal('fetch', fetcher)
  const h = await harness(); cleanup.push(h.close)
  const agent = await h.create('header-effort', { ...route, reasoningEffort: AUTO_EFFORT })
  vi.spyOn(agent.session, 'requestHeader').mockReturnValue({ config: { ...route, reasoningEffort: 'high' } } as never)
  await send(agent)
  expect(h.errors).toEqual([])
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).state.currentEffort).toBe('high')
})

it('sends a later manual effort instead of the stored request-level effort', async () => {
  const h = await harness(); cleanup.push(h.close)
  const luna = h.adapter.models.find(model => model.id === route.model)
  if (luna?.reasoning === undefined) throw new Error('fixture model has no efforts')
  luna.reasoning = {
    ...luna.reasoning,
    efforts: [...luna.reasoning.efforts, { id: ReasoningEffortId('xhigh'), name: 'xhigh' }],
  }
  const agent = await h.create('manual-effort', { ...route, reasoningEffort: ReasoningEffortId('high') })
  await send(agent)
  agent.model.select({ ...route, reasoningEffort: ReasoningEffortId('xhigh') })
  await send(agent, 'Continue with the higher effort')
  expect(h.errors.map(error => error instanceof Error ? error.message : String(error))).toEqual([])
  expect(h.adapter.requests.map(request => request.reasoningEffort)).toEqual(['high', 'xhigh'])
  expect(configurationUpdates(agent.session.deriveMessages())).toEqual([])
})
