import { afterEach, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, createAssistantMessage, createSystemMessage, createToolResultMessage, ToolCallId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import { evaluationMessages } from '../src/messages.ts'
import { resolveConfig } from '../src/config.ts'
import { harness, send, TestAdapter } from './harness.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.unstubAllGlobals() })
const image: ImageBlock = { type: 'image', attachment: { attachmentId: AttachmentId('a'.repeat(64)), mediaType: 'image/png', width: 1, height: 1, bytes: 1, name: 'SECRET-IMAGE' } }

it('evaluates only body text, excludes system/arguments/reasoning/images, and crops tool excerpts by characters', () => {
  const history = [
    createSystemMessage('SECRET-SYSTEM'),
    createUserMessage({ content: [{ type: 'text', text: 'user body' }, image], source: { kind: 'user' } }),
    createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [
      { type: 'text', text: 'assistant body' }, { type: 'reasoning', text: 'SECRET-REASONING' },
      { type: 'tool-call', id: ToolCallId('call'), name: 'tool', arguments: 'SECRET-ARGUMENTS' },
    ] }),
    createToolResultMessage({ callId: ToolCallId('call'), isError: false, content: [{ type: 'text', text: '😀'.repeat(1700) }, image] }),
  ]
  expect(evaluationMessages(history, 'model')).toEqual([{ role: 'user', text: 'user body' }, { role: 'assistant', text: 'assistant body' }])
  expect(evaluationMessages(history, 'effort')).toEqual([
    { role: 'user', text: 'user body' }, { role: 'assistant', text: 'assistant body' }, { role: 'tool', text: '😀'.repeat(1600) },
  ])
})

it('sends at most the latest eight eligible messages without truncating user or assistant bodies', () => {
  const messages = Array.from({ length: 10 }, (_, index) => createUserMessage({ content: [{ type: 'text', text: `body-${index}` }], source: { kind: 'user' } }))
  expect(evaluationMessages(messages, 'model').map(message => message.text)).toEqual(['body-2', 'body-3', 'body-4', 'body-5', 'body-6', 'body-7', 'body-8', 'body-9'])
})

it('image-incompatible models are excluded before model evaluation and task descriptions remain verbatim', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ answers: { route: { choice: '0' } } })); vi.stubGlobal('fetch', fetcher)
  const h = await harness(); cleanup.push(h.close)
  h.adapter.models[0] = { ...h.adapter.models[0]!, inputModalities: ['text'] }
  h.adapter.models[1] = { ...h.adapter.models[1]!, reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }] } }
  const agent = await h.create()
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Describe the image' }, image], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(h.errors).toEqual([])
  expect(h.adapter.requests[0]).toMatchObject({ model: 'gpt-6-sol', reasoningEffort: 'low' })
  const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body))
  expect(body.questions.route.criteria).toEqual({ '0': 'fixture-sol', '1': 'fixture-astra' })
  expect(JSON.stringify(body)).not.toContain('SECRET-IMAGE')
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('requires configured routes, accepts new model ids, and forwards configured effort wording', async () => {
  expect(() => resolveConfig({ enabled: true })).toThrow('requires candidates')
  const h = await harness({ candidates: [{ provider: 'test', model: 'gpt-7-sol', description: 'New model role' }],
    effortDescriptions: { 'test/gpt-7-sol': { low: 'Routine next step', high: 'Difficult next step' } } }); cleanup.push(h.close)
  h.adapter.models = [{ ...h.adapter.models[0]!, id: 'gpt-7-sol', reasoning: { efforts: [
    { id: ReasoningEffortId('low'), name: 'Low' }, { id: ReasoningEffortId('high'), name: 'High' },
  ] } }]
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ answers: { route: { choice: 'high' } } })); vi.stubGlobal('fetch', fetcher)
  const agent = await h.create(); await send(agent)
  expect(h.errors).toEqual([])
  expect(h.adapter.requests[0]).toMatchObject({ model: 'gpt-7-sol', reasoningEffort: 'high' })
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).questions.route.criteria)
    .toEqual({ low: 'Routine next step', high: 'Difficult next step' })
})

it('uses a sole available model and sole supported effort without credential or HTTP access', async () => {
  const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher)
  const h = await harness({ credentialRefs: [] }); cleanup.push(h.close)
  h.adapter.models = [{ ...h.adapter.models[0]!, reasoning: { efforts: [{ id: ReasoningEffortId('only'), name: 'Only' }] } }]
  const agent = await h.create(); await send(agent)
  expect(h.errors).toEqual([])
  expect(h.adapter.requests[0]).toMatchObject({ model: 'gpt-6-luna', reasoningEffort: 'only' })
  expect(fetcher).not.toHaveBeenCalled()
})

it.each(['model', 'effort', 'user-body'] as const)('fails with no available %s instead of sending a generation request', async missing => {
  const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher)
  const h = await harness(); cleanup.push(h.close)
  h.adapter.models = missing === 'model' ? [] : [{ ...h.adapter.models[0]!, reasoning: { efforts: [] } }]
  const agent = await h.create()
  if (missing === 'user-body') {
    agent.followup(createUserMessage({ content: [image], source: { kind: 'user' } })); await agent.whenIdle()
  } else await send(agent)
  expect(h.errors).toHaveLength(1)
  expect(h.adapter.requests).toEqual([])
  expect(fetcher).not.toHaveBeenCalled()
})

it('an unavailable provider does not disqualify available automatic models on another provider', async () => {
  class Offline extends TestAdapter { override async listModels(): Promise<never> { throw new Error('offline') } }
  const h = await harness({ credentialRefs: [] }); cleanup.push(h.close)
  h.ctx.effect(() => h.ctx.llm.registerAdapter(['offline'], new Offline()))
  h.adapter.models = [{ ...h.adapter.models[0]!, reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }] } }]
  const agent = await h.create(); await send(agent)
  expect(h.errors).toEqual([])
  expect(h.adapter.requests[0]).toMatchObject({ provider: 'test', model: 'gpt-6-luna' })
})
