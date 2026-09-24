import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { LlmAdapter, ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmCallConfig, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import * as router from '../src/index.ts'
import type { Config } from '../src/config.ts'

export class TestCredentials extends CredentialProvider {
  async resolve() { return { value: 'test-token', source: 'test' } }
  async describe() { return { configured: true, writable: false } }
  async set(): Promise<void> { throw new Error('read-only test credentials') }
  async unset(): Promise<void> { throw new Error('read-only test credentials') }
  async readRecord() { return undefined }
  async describeRecord() { return { configured: false, writable: false } }
  async listRecords() { return [] }
  async modifyRecord(): Promise<undefined> { throw new Error('read-only test credentials') }
  async deleteRecord(): Promise<void> { throw new Error('read-only test credentials') }
}

/** Configuration updates recorded in one provider request, in transcript order. */
export function configurationUpdates(messages: readonly { content: readonly { type: string; effort?: string }[] }[]): string[] {
  const efforts: string[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'configuration-update' && block.effort !== undefined) efforts.push(block.effort)
    }
  }
  return efforts
}

export class TestAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  models: LlmResolvedModelInfo[] = ['luna', 'sol', 'astra'].map(tier => ({
    provider: 'test', id: `gpt-6-${tier}`, name: `GPT-6 ${tier[0]!.toUpperCase()}${tier.slice(1)}`,
    inputModalities: ['text', 'image'],
    reasoning: { efforts: ['low', 'medium', 'high'].map(id => ({ id: ReasoningEffortId(id), name: id })), defaultEffort: ReasoningEffortId('medium') },
  }))
  override async listModels() { return this.models }
  override async resolveModel(_provider: string, model: string) {
    const found = this.models.find(item => item.id === model)
    if (!found) throw new Error(`Unavailable model: ${model}`)
    return found
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export async function harness(config: Config = {}, persistenceRoot?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-jev-'))
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  const root = persistenceRoot ?? join(directory, 'logs')
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestCredentials)
  const adapter = new TestAdapter()
  ctx.effect(() => ctx.llm.registerAdapter(['test'], adapter))
  const settings = { enabled: true, credentialRefs: ['JEV_TOKEN'], stateDirectory: directory,
    candidates: ['luna', 'sol', 'astra'].map(tier => ({ provider: 'test', model: `gpt-6-${tier}`, description: `fixture-${tier}` })),
    ...config }
  const fiber = await ctx.plugin(router, settings)
  const errors: unknown[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  return {
    ctx, adapter, fiber, errors, settings, root,
    async create(id = 'root', selection: LlmCallConfig = { provider: 'auto', model: 'jev' }) {
      return (await ctx.agents.create({ sessionId: SessionId(id), agentOptions: selection })).agent
    },
    async close() { await ctx.fiber.dispose(); rmSync(directory, { recursive: true, force: true }) },
  }
}

export async function send(agent: Agent, text = 'Fix the parser') {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}
