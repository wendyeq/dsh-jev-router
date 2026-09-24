import { afterEach, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, createAssistantMessage, createSystemMessage, createToolResultMessage, ToolCallId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import { evaluationMessages, fitMessages } from '../src/messages.ts'
import type { EvaluationMessage } from '../src/jev.ts'
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

const within = (limit: number) => (items: EvaluationMessage[]) => items.reduce((sum, item) => sum + Array.from(item.text).length, 0) <= limit

it('leaves input that already fits untouched', () => {
  const messages = [{ role: 'user' as const, text: 'short' }]
  expect(fitMessages(messages, within(5))).toEqual({ messages, dropped: 0, omitted: 0 })
})

it('drops whole messages oldest first and never drops the latest user message', () => {
  const messages: EvaluationMessage[] = [
    { role: 'user', text: 'a'.repeat(10) }, { role: 'assistant', text: 'b'.repeat(10) },
    { role: 'user', text: 'q' }, { role: 'tool', text: 'c'.repeat(5) },
  ]
  expect(fitMessages(messages, within(16))).toEqual({ messages: messages.slice(1), dropped: 1, omitted: 0 })
  expect(fitMessages(messages, within(6))).toEqual({ messages: messages.slice(2), dropped: 2, omitted: 0 })
  expect(fitMessages(messages, within(1))).toEqual({ messages: [messages[2]], dropped: 3, omitted: 0 })
})

it('keeps the last message when there is no user message', () => {
  const messages: EvaluationMessage[] = [{ role: 'assistant', text: 'a'.repeat(10) }, { role: 'tool', text: 'tool' }]
  expect(fitMessages(messages, within(4))).toEqual({ messages: [messages[1]], dropped: 1, omitted: 0 })
})

it('shortens only the kept message, keeping head and tail around a length marker', () => {
  const text = 'H'.repeat(50) + 'M'.repeat(100) + 'T'.repeat(50)
  const fitted = fitMessages([{ role: 'assistant', text: 'old' }, { role: 'user', text }], within(120))!
  expect(fitted.dropped).toBe(1)
  expect(fitted.messages).toHaveLength(1)
  expect(within(120)(fitted.messages)).toBe(true)
  const shortened = fitted.messages[0]!.text
  expect(shortened).toContain(`omitted ${fitted.omitted} of 200 characters`)
  expect(shortened.startsWith('H')).toBe(true)
  expect(shortened.endsWith('T')).toBe(true)
  expect(Array.from(shortened.replace(/\n\[.*\]\n/, '')).length).toBe(200 - fitted.omitted)
})

it('fails when not even one character of the kept message fits', () => {
  expect(fitMessages([{ role: 'user', text: 'abc' }], () => false)).toBeUndefined()
  expect(fitMessages([], () => false)).toBeUndefined()
})

it('an oversized paste routes and keeps routing on the following request', async () => {
  const answers = ['1', 'high', 'low']
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ answers: { route: { choice: answers.shift() } } })); vi.stubGlobal('fetch', fetcher)
  const h = await harness(); cleanup.push(h.close)
  const agent = await h.create()
  await send(agent, '汉'.repeat(20000))
  await send(agent, 'next step')
  expect(h.errors).toEqual([])
  expect(h.adapter.requests.map(request => request.model)).toEqual(['gpt-6-sol', 'gpt-6-sol'])
  expect(fetcher).toHaveBeenCalledTimes(3)
  for (const call of fetcher.mock.calls) expect(Buffer.byteLength(String(call[1]?.body))).toBeLessThanOrEqual(28000)
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
