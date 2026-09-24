import { expect, it } from 'vitest'
import type { RequestMessage } from '@deepseek-ai/dsh-llm'
import { planEffortChange } from '../src/effort.ts'

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

it('starts a new request-level effort when the model changes, and restates over a stale update', () => {
  const luna = { ...route, requestEffort: 'low', effectiveEffort: 'high' }
  const astra = planEffortChange(luna, { provider: 'test', model: 'gpt-6-astra' }, 'medium', [user('a'), update('high')])
  expect(astra).toMatchObject({ requestEffort: 'medium', effectiveEffort: 'medium', append: false })
  const back = planEffortChange(astra.wire, route, 'low', [user('a'), update('high'), user('b')])
  expect(back).toMatchObject({ requestEffort: 'low', effectiveEffort: 'low', append: true })
})
