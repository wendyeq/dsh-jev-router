/** Session-model commitment and independent per-main-request effort selection. */
import type { Context } from '@deepseek-ai/cordis'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createDeveloperMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmCallConfig, LlmModelInfo, LlmResolvedModelInfo, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ResolvedConfig } from './config.ts'
import { planEffortChange } from './effort.ts'
import { evaluate, JevUnavailableError } from './jev.ts'
import type { EvaluationRecord } from './jev.ts'
import { Ledger } from './ledger.ts'
import type { LedgerEntry } from './ledger.ts'
import { evaluationMessages } from './messages.ts'
import { RouterStore } from './store.ts'
import type { PersistedRouter, Selection } from './types.ts'

/** Selector-only effort value, never sent to a generation adapter. */
export const AUTO_EFFORT = ReasoningEffortId('auto/jev')

/** @param selection - user-selected route.
 * @returns whether the model selector requests automatic routing.
 */
export function automaticModel(selection: Selection): boolean {
  return selection.provider === 'auto' && selection.model === 'jev'
}

/** Keeps each Session's model while selecting fresh effort for each main request. */
export class JevRouter {
  readonly store: RouterStore
  private readonly ledger: Ledger

  /** @param ctx - live Harness services.
   * @param config - validated routing configuration.
   */
  constructor(private readonly ctx: Context, private readonly config: ResolvedConfig) {
    this.store = new RouterStore(config.stateDirectory)
    this.ledger = new Ledger(config.stateDirectory, message => ctx.logger.warn(message))
  }

  /** Apply every own selection event, including repeated auto/jev selections.
   * @param session - Session whose current selection is read.
   * @param initial - creation or first assembled selection.
   * @returns router state after applying new user selections.
   */
  replaySelection(session: Session, initial: Selection): PersistedRouter {
    let state = this.store.read(session.id) ?? { version: 1 as const, selection: initial, afterSeq: -1, pin: null }
    for (const event of session.snapshotEvents()) {
      if (event.type !== 'model/selection' || !session.isOwnSeq(event.seq) || event.seq <= state.afterSeq) continue
      const wire = state.effortWire
      const keepWire = wire !== undefined && !automaticModel(event.data)
        && event.data.provider === wire.provider && event.data.model === wire.model
      state = {
        version: 1, selection: event.data, afterSeq: event.seq, pin: null,
        ...keepWire && wire ? { effortWire: wire } : {},
      }
      this.store.write(session.id, state)
    }
    return state
  }

  /** Resolve currently registered automatic models against the request's input modalities.
   * @param messages - full request input, inspected but never sent as-is to Jev.
   * @param signal - optional request cancellation during discovery.
   * @returns exact registered models, each retaining its configured task description.
   */
  async models(messages: readonly RequestMessage[], signal?: AbortSignal): Promise<(LlmResolvedModelInfo & { taskDescription: string })[]> {
    const hasImage = messages.some(message => message.content.some(block => block.type === 'image' && !block.offloaded))
    const choices: (LlmResolvedModelInfo & { taskDescription: string })[] = []
    for (const provider of this.ctx.llm.listProviders()) {
      signal?.throwIfAborted()
      let models: readonly LlmModelInfo[]
      try {
        models = await this.ctx.llm.listModels(provider.id)
      } catch (_error) {
        // A provider whose directory cannot be read offers no available models.
        signal?.throwIfAborted()
        continue
      }
      for (const candidate of this.config.candidates) {
        if (candidate.provider !== undefined && candidate.provider !== provider.id) continue
        if (!models.some(model => model.id === candidate.model)) continue
        let model: LlmResolvedModelInfo
        try {
          model = await this.ctx.llm.resolveModelInfo(provider.id, candidate.model, signal)
        } catch (_error) {
          // Unknown current capabilities make this particular model unavailable.
          signal?.throwIfAborted()
          continue
        }
        if (hasImage && !model.inputModalities?.includes('image')) continue
        choices.push({ ...model, taskDescription: candidate.description })
      }
    }
    return choices
  }

  /** Resolve a main request and commit a new model only after effort validation.
   * @param agent - owning Agent.
   * @param proposed - downstream request controls, including selector sentinels.
   * @param messages - history and accepted input for this main request.
   * @param signal - cancellation covering both evaluations and commitment.
   * @param turn - open turn, used only when a configuration update is recorded.
   * @param step - open step, used only when a configuration update is recorded.
   * @returns a concrete call. `reasoningEffort` is the request-level effort, not a later update.
   */
  async main(
    agent: Agent,
    proposed: LlmCallConfig,
    messages: readonly RequestMessage[],
    signal: AbortSignal,
    turn = 0,
    step = 0,
  ): Promise<LlmCallConfig> {
    signal.throwIfAborted()
    const state = this.inherit(agent, proposed)
    const selection = state.selection
    const autoModel = automaticModel(selection)
    const autoEffort = selection.reasoningEffort === AUTO_EFFORT || (autoModel && selection.reasoningEffort === undefined)
    const log = this.config.logDecisions || this.config.diagnosticLogFile
      ? (message: string) => {
        if (this.config.logDecisions) this.ctx.logger.info(`dsh-jev-router session=${agent.id} ${message}`)
        if (!this.config.diagnosticLogFile) return
        try {
          mkdirSync(dirname(this.config.diagnosticLogFile), { recursive: true, mode: 0o700 })
          appendFileSync(this.config.diagnosticLogFile,
            JSON.stringify({ time: new Date().toISOString(), sessionId: agent.id, message }) + '\n', { mode: 0o600 })
        } catch (_error) {
          // A diagnostic write must never turn a model request into a failed request.
          this.ctx.logger.warn('dsh-jev-router: diagnostic log write failed')
        }
      }
      : undefined
    const record = this.config.ledger ? (entry: LedgerEntry) => this.ledger.append(agent.id, entry) : undefined
    if (!autoModel && !autoEffort) {
      const { reasoningEffort: _previous, ...base } = proposed
      if (selection.reasoningEffort === undefined) {
        const resolved = await this.ctx.llm.resolveCallConfig({ ...base, provider: selection.provider, model: selection.model }, signal)
        signal.throwIfAborted()
        if (this.store.read(agent.id) === undefined) this.store.write(agent.id, state)
        return resolved
      }
      return this.finish(agent, state, turn, step, { provider: selection.provider, model: selection.model }, selection.reasoningEffort, base, signal, log)
    }
    let model: LlmResolvedModelInfo
    if (autoModel && state.pin === null) {
      const modelMessages = evaluationMessages(messages, 'model')
      if (!modelMessages.some(message => message.role === 'user')) throw new Error('Jev routing failed: no user body')
      const available = await this.models(messages, signal)
      const choices = available.map((model, index) => ({ key: String(index), description: model.taskDescription, model }))
      const report = record && (({ choice, ...rest }: EvaluationRecord) => {
        const chosen = choices.find(item => item.key === choice)?.model
        record({ ...rest, ...chosen ? { model: `${chosen.provider}/${chosen.id}` } : {} })
      })
      model = (await evaluate(this.ctx.credentials, this.config, modelMessages, choices, 'model', signal, log, report)).model
    } else {
      const route = autoModel ? state.pin! : selection
      model = await this.ctx.llm.resolveModelInfo(route.provider, route.model, signal)
    }
    let effort = selection.reasoningEffort
    if (autoEffort) {
      const descriptions = this.config.effortDescriptions[`${model.provider}/${model.id}`]
        ?? this.config.effortDescriptions[model.id]
      const efforts = model.reasoning?.efforts ?? []
      // Adapters list efforts in escalation order, so the floor keeps it and everything after it.
      const floor = this.config.effortFloors[`${model.provider}/${model.id}`] ?? this.config.effortFloors[model.id]
      const start = floor === undefined ? 0 : efforts.findIndex(item => String(item.id) === floor)
      if (start < 0) throw new Error(`Jev routing failed: effort floor ${floor} is not supported by ${model.provider}/${model.id}`)
      const choices = efforts.slice(start).map(item => ({ key: String(item.id),
        description: descriptions?.[String(item.id)] ?? item.description ?? item.name }))
      try {
        const report = record && ((entry: EvaluationRecord) => record({ ...entry, model: `${model.provider}/${model.id}` }))
        effort = (await evaluate(this.ctx.credentials, this.config, evaluationMessages(messages, 'effort'), choices, 'effort', signal, log, report)).key
      } catch (error) {
        if (!(error instanceof JevUnavailableError)) throw error
        signal.throwIfAborted()
        const wire = state.effortWire
        const wireHeld = wire?.provider === model.provider && wire.model === model.id ? wire.effectiveEffort : undefined
        const previous = agent.session.requestHeader()?.config
        const headerHeld = previous?.provider === model.provider && previous.model === model.id
          ? previous.reasoningEffort : undefined
        const held = wireHeld ?? headerHeld
        const offered = (key: string | undefined) => key !== undefined && choices.some(choice => choice.key === key)
        const adapterDefault = model.reasoning?.defaultEffort
        // A default below the floor is raised to the floor; an unsupported default still fails.
        const belowFloor = adapterDefault !== undefined && efforts.slice(0, start).some(item => item.id === adapterDefault)
        const [fallback, source] = offered(held) ? [held!, 'previous']
          : offered(adapterDefault) ? [adapterDefault!, 'adapter-default']
            : belowFloor ? [choices[0]!.key, 'floor'] : [undefined, undefined]
        if (fallback === undefined) throw error
        effort = fallback
        log?.(`effort unavailable reason=${error.reason} fallback=${effort} source=${source}`)
        record?.({ question: 'effort', outcome: 'fallback', model: `${model.provider}/${model.id}`, choice: effort, source: source!, reason: error.reason })
      }
    }
    const { reasoningEffort: _previous, ...base } = proposed
    const route = { provider: model.provider, model: model.id }
    const pinned = autoModel && state.pin === null
      ? { ...state, pin: { provider: model.provider, model: model.id, selectedAt: Date.now() } }
      : state
    if (effort === undefined) {
      const resolved = await this.ctx.llm.resolveCallConfig({ ...base, ...route }, signal)
      signal.throwIfAborted()
      if (this.replaySelection(agent.session, proposed).afterSeq !== state.afterSeq) throw new Error('Jev routing failed: selection changed during evaluation')
      this.store.write(agent.session.id, pinned)
      log?.(`resolved provider=${resolved.provider} model=${resolved.model} effort=provider-default`)
      return resolved
    }
    return this.finish(agent, pinned, turn, step, route, effort, base, signal, log, state.afterSeq, proposed)
  }

  /** Resolve the request-level effort, then record a configuration update when the effort changed.
   * @param agent - owning Agent.
   * @param state - router state, including a pin committed in this call.
   * @param turn - open turn for a recorded update.
   * @param step - open step for a recorded update.
   * @param route - concrete model.
   * @param effort - effort chosen for this request.
   * @param base - downstream controls other than reasoning effort.
   * @param signal - cancellation covering resolution and commitment.
   * @param log - optional diagnostic writer.
   * @param afterSeq - selection cursor captured before evaluation; defaults to `state`.
   * @param proposed - selection used to detect a concurrent change.
   * @returns the concrete call. Its effort is the request-level value.
   */
  private async finish(
    agent: Agent,
    state: PersistedRouter,
    turn: number,
    step: number,
    route: { provider: string; model: string },
    effort: string,
    base: Omit<LlmCallConfig, 'reasoningEffort'>,
    signal: AbortSignal,
    log: ((message: string) => void) | undefined,
    afterSeq = state.afterSeq,
    proposed: Selection = state.selection,
  ): Promise<LlmCallConfig> {
    const plan = planEffortChange(state.effortWire, route, effort, agent.session.deriveMessages())
    const resolved = await this.ctx.llm.resolveCallConfig({
      ...base, ...route, reasoningEffort: ReasoningEffortId(plan.requestEffort),
    }, signal)
    signal.throwIfAborted()
    if (this.replaySelection(agent.session, proposed).afterSeq !== afterSeq) throw new Error('Jev routing failed: selection changed during evaluation')
    if (plan.append) {
      agent.session.append('developer/message', {
        turn,
        step,
        message: createDeveloperMessage({
          source: { kind: 'jev-configuration-update' },
          content: [{ type: 'configuration-update', effort: plan.effectiveEffort, provider: route.provider, model: route.model }],
        }),
      }, { surfaceOp: 'append' })
    }
    this.store.write(agent.session.id, { ...state, effortWire: plan.wire })
    log?.(`resolved provider=${resolved.provider} model=${resolved.model} effort=${plan.effectiveEffort}`)
    return resolved
  }

  private inherit(agent: Agent, proposed: Selection): PersistedRouter {
    const state = this.replaySelection(agent.session, proposed)
    const parentId = agent.session.header.parentSession
    if (parentId === undefined || (!automaticModel(state.selection)
      && (state.afterSeq >= 0 || this.store.read(agent.id) !== undefined))) return state
    const parent = this.ctx.agents.get(parentId)
    const parentSession = this.ctx.sessions.get(parentId)
    const parentInitial = parent?.options.provider && parent.options.model
      ? { provider: parent.options.provider, model: parent.options.model, reasoningEffort: parent.options.reasoningEffort }
      : parentSession?.requestHeader()?.config
    const parentState = parentSession && parentInitial ? this.replaySelection(parentSession, parentInitial) : this.store.read(parentId)
    if (!parentState) throw new Error('Jev routing failed: parent has no session model')
    const parentRoute = automaticModel(parentState.selection) ? parentState.pin : parentState.selection
    const previous = parentSession?.requestHeader()?.config
    const explicit = !agent.session.header.isSeeded && !automaticModel(proposed) && proposed.provider && proposed.model
      && (proposed.provider !== previous?.provider || proposed.model !== previous.model)
    if (!parentRoute && !explicit) throw new Error('Jev routing failed: parent has no session model')
    const route = explicit ? proposed : parentRoute!
    const effort = parentState.selection.reasoningEffort
      ?? (automaticModel(parentState.selection) ? AUTO_EFFORT : undefined)
    const inherited: PersistedRouter = { ...state, selection: { provider: route.provider, model: route.model,
      ...effort === undefined ? {} : { reasoningEffort: effort } } }
    this.store.write(agent.id, inherited)
    return inherited
  }

  /** Resolve a purpose-tagged call without evaluating or committing a model.
   * @param options - title or compaction request.
   * @returns the selected concrete model with its own default effort.
   */
  async auxiliary(options: GenerateOptions): Promise<GenerateOptions> {
    if (options.sessionId === undefined) {
      if (automaticModel(options) || options.reasoningEffort === AUTO_EFFORT) throw new Error('Jev routing failed: no session model')
      return options
    }
    const session = this.ctx.sessions.get(options.sessionId)
    const agent = this.ctx.agents.get(options.sessionId)
    const initial = agent?.options.provider && agent.options.model
      ? { provider: agent.options.provider, model: agent.options.model, reasoningEffort: agent.options.reasoningEffort }
      : options
    const state = session ? this.replaySelection(session, initial) : this.store.read(options.sessionId)
    if (!state) throw new Error('Jev routing failed: no session model')
    const route = automaticModel(state.selection) ? state.pin : state.selection
    if (!route) throw new Error('Jev routing failed: no session model')
    const { reasoningEffort: _previous, ...base } = options
    const resolved = await this.ctx.llm.resolveCallConfig({ ...base, provider: route.provider, model: route.model }, options.signal)
    options.signal?.throwIfAborted()
    return { ...base, ...resolved }
  }
}
