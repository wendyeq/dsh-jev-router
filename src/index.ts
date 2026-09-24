/** Optional Cordis plugin: selector sentinels resolve to concrete calls before dispatch. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { Config, resolveConfig } from './config.ts'
import { AUTO_EFFORT, automaticModel, JevRouter } from './router.ts'

export { Config }
/** Cordis plugin identity. */
export const name = 'dsh-jev-router'
/** Services used by the request-time routing plugin. */
export const inject = ['llm', 'credentials', 'agents', 'sessions']

/**
 * Install routing only when explicitly enabled; no virtual generation adapter is registered.
 * @param ctx - Harness plugin context.
 * @param config - validated at activation, before registering listeners.
 */
export function apply(ctx: Context, config: Config): void {
  const settings = resolveConfig(config)
  if (!settings.enabled) return
  const router = new JevRouter(ctx, settings)
  const accepted = new WeakMap<Agent, readonly UserMessage[]>()
  const automatic = { id: AUTO_EFFORT, name: '自动' }
  ctx.on('llm/model-selector', (provider, model) => automaticModel({ provider, model }) ? true : undefined)
  ctx.on('session/model-catalog', async next => {
    const catalog = await next()
    const groups = catalog.groups.map(group => ({
      ...group,
      models: group.models.map(model => ({
        ...model,
        reasoning: { ...model.reasoning, efforts: [automatic, ...model.reasoning?.efforts ?? []] },
      })),
    }))
    return {
      ...catalog,
      routableProviders: [...catalog.routableProviders, 'auto'],
      groups: [...groups, {
        id: 'auto', name: '自动路由',
        models: [{ id: 'jev', name: 'auto/jev', reasoning: { efforts: [automatic], defaultEffort: AUTO_EFFORT } }],
      }],
    }
  })
  ctx.on('llm/selection', async (selection, next) => {
    if (automaticModel(selection)) {
      if (selection.reasoningEffort !== undefined && selection.reasoningEffort !== AUTO_EFFORT) {
        throw new Error('auto/jev requires automatic reasoning effort')
      }
      return { ...selection, reasoningEffort: AUTO_EFFORT }
    }
    if (selection.reasoningEffort !== AUTO_EFFORT) return next()
    const { reasoningEffort: _automatic, ...concrete } = selection
    await ctx.llm.resolveCallConfig(concrete)
    return selection
  })
  ctx.on('llm/selection-info', async (provider, model, next) => {
    if (!automaticModel({ provider, model })) return next()
    const models = await router.models([])
    return { provider, id: model, name: 'auto/jev',
      inputModalities: models.some(model => model.inputModalities?.includes('image')) ? ['text', 'image'] : ['text'] }
  })
  ctx.on('llm/auxiliary-options', async (_options, next) => router.auxiliary(await next()), { global: true })
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') {
      accepted.set(agent, [])
      return decision
    }
    accepted.set(agent, decision.messages)
    const saved = router.store.read(agent.id)
    const initial = agent.options.reasoningEffort === AUTO_EFFORT && agent.options.provider && agent.options.model
      ? { provider: agent.options.provider, model: agent.options.model, reasoningEffort: AUTO_EFFORT }
      : undefined
    const selection = saved?.selection.reasoningEffort === AUTO_EFFORT
      ? { provider: saved.selection.provider, model: saved.selection.model, reasoningEffort: AUTO_EFFORT }
      : initial
    if (selection && !agent.session.snapshotEvents().some(event => event.type === 'model/selection' && agent.session.isOwnSeq(event.seq))) {
      agent.session.append('model/selection', selection)
      if (saved) router.store.write(agent.id, { ...saved, afterSeq: agent.session.snapshotEvents().at(-1)!.seq })
    }
    return decision
  }, { global: true, prepend: true })
  ctx.on('agent/request', async ({ agent, turn, step, signal }, next) => {
    const proposed = await next()
    return router.main(agent, proposed, [...agent.session.deriveMessages(), ...accepted.get(agent) ?? []], signal, turn, step)
  }, { global: true, prepend: true })
}
